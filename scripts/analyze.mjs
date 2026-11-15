#!/usr/bin/env node
// Pull the A/B test data from PostHog, analyse it per visitor, and write a report.
//
//   npm run analyze              # real data (needs .env, see README → Analysis)
//   npm run analyze -- --demo    # synthetic data, to see what a report looks like
//   npm run analyze -- --notify  # also show a macOS notification with the headline
//
// Output (git-ignored): reports/latest.md, reports/<date>.md, data/visitors-<date>.csv
//
// The unit of analysis is the visitor (PostHog distinct_id = the am_vid cookie), because
// that is what the Worker randomises. A visitor's metrics combine all their page loads.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  twoProportions, probBBeatsA, mannWhitney, bootstrapMedianDiff, srm, sampleSize, median, quantile, mean, wilson, rng,
} from './lib/stats.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));

// ---- the pre-registered plan (decide these before looking at results) --------
const PLAN = {
  primary: 'engaged30',              // share of visitors with >= 30 s of visible time
  baseline: 0.30,                    // assumed control rate for planning
  minEffect: 0.10,                   // smallest lift worth detecting (absolute)
  alpha: 0.05,
};
PLAN.perArm = sampleSize(PLAN.baseline, PLAN.baseline + PLAN.minEffect);

// ---- config -------------------------------------------------------------------
function loadEnv() {
  const f = join(ROOT, '.env');
  if (!existsSync(f)) return;
  for (const line of readFileSync(f, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"\n]*)"?\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}
function wranglerVars() {
  const txt = readFileSync(join(ROOT, 'wrangler.jsonc'), 'utf8');
  const v = (k) => (txt.match(new RegExp(`"${k}"\\s*:\\s*"([^"]*)"`)) || [])[1];
  return { variants: v('VARIANTS').split(','), weights: v('WEIGHTS').split(',').map(Number), experiment: v('EXPERIMENT') };
}

// ---- PostHog ------------------------------------------------------------------
async function hogql(query) {
  const host = (process.env.POSTHOG_HOST || 'https://us.posthog.com').replace(/\/$/, '');
  const project = process.env.POSTHOG_PROJECT_ID || '@current';
  const res = await fetch(`${host}/api/projects/${project}/query/`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.POSTHOG_PERSONAL_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: { kind: 'HogQLQuery', query }, name: 'anton.miami ab analysis' }),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`PostHog ${res.status}: ${body.slice(0, 400)}`);
  const json = JSON.parse(body);
  return json.results.map((row) => Object.fromEntries(json.columns.map((c, i) => [c, row[i]])));
}

async function fetchVisitors(experiment) {
  const where = `properties.ab_experiment = '${experiment.replace(/'/g, '')}'
    AND toString(properties.ab_preview) != 'true'`;
  const q = (sql) => hogql(sql.replace(/\{where\}/g, where));

  const [exposures, summaries, engaged, interactions, outbound, perf] = await Promise.all([
    q(`SELECT distinct_id,
         argMin(toString(properties.variant), timestamp)                  AS variant,
         uniqExact(toString(properties.variant))                          AS n_variants,
         min(timestamp)                                                   AS first_seen,
         count()                                                          AS page_loads,
         argMin(toString(properties.input_class), timestamp)              AS input_class,
         argMin(coalesce(toString(properties.utm_source), ''), timestamp) AS utm_source,
         argMin(coalesce(toString(properties.referrer_domain), ''), timestamp) AS referrer,
         max(toString(properties.in_app_browser) = 'true')                AS in_app
       FROM events WHERE event = 'ab_exposure' AND {where}
       GROUP BY distinct_id LIMIT 50000`),
    // last summary per page load, then summed per visitor
    q(`SELECT distinct_id,
         sum(v) AS visible_s, sum(att) AS attentive_s, max(out) AS clicked_out, max(inter) AS interacted,
         sum(travel) AS travel, sum(taps) AS taps, sum(drags) AS drags, sum(keys) AS keys, sum(ui) AS ui_clicks
       FROM (
         SELECT distinct_id, toString(properties.page_id) AS pid,
           argMax(toFloat(properties.visible_s), toInt(properties.seq))                AS v,
           argMax(toFloat(properties.attentive_s), toInt(properties.seq))              AS att,
           argMax(toString(properties.exit) = 'outbound', toInt(properties.seq))       AS out,
           argMax(toString(properties.interacted) = 'true', toInt(properties.seq))     AS inter,
           argMax(toFloat(properties.pointer_travel_screens), toInt(properties.seq))   AS travel,
           argMax(toFloat(properties.taps), toInt(properties.seq))                     AS taps,
           argMax(toFloat(properties.drags), toInt(properties.seq))                    AS drags,
           argMax(toFloat(properties.keys), toInt(properties.seq))                     AS keys,
           argMax(toFloat(properties.ui_clicks), toInt(properties.seq))                AS ui
         FROM events WHERE event = 'page_summary' AND {where}
         GROUP BY distinct_id, pid)
       GROUP BY distinct_id LIMIT 50000`),
    q(`SELECT distinct_id, max(toInt(properties.seconds)) AS max_milestone
       FROM events WHERE event = 'engaged' AND {where} GROUP BY distinct_id LIMIT 50000`),
    q(`SELECT distinct_id, min(toFloat(properties.ms_to_first)) AS ms_to_first
       FROM events WHERE event = 'first_interaction' AND {where} GROUP BY distinct_id LIMIT 50000`),
    q(`SELECT distinct_id, count() AS clicks, groupUniqArray(toString(properties.destination)) AS destinations
       FROM events WHERE event = 'outbound_click' AND {where} GROUP BY distinct_id LIMIT 50000`),
    q(`SELECT distinct_id, avg(toFloat(properties.fps)) AS fps, avg(toFloat(properties.load_ms)) AS load_ms
       FROM events WHERE event = 'perf' AND {where} GROUP BY distinct_id LIMIT 50000`),
  ]);

  const by = (rows) => new Map(rows.map((r) => [r.distinct_id, r]));
  const S = by(summaries), E = by(engaged), I = by(interactions), O = by(outbound), P = by(perf);
  return exposures.map((x) => {
    const s = S.get(x.distinct_id) || {}, e = E.get(x.distinct_id), i = I.get(x.distinct_id), o = O.get(x.distinct_id), p = P.get(x.distinct_id);
    const engagedS = Math.max(Number(s.visible_s) || 0, Number(e?.max_milestone) || 0);
    return {
      id: x.distinct_id, variant: x.variant, mixed: Number(x.n_variants) > 1, first_seen: x.first_seen,
      page_loads: Number(x.page_loads), input: x.input_class || 'unknown',
      source: x.utm_source || (x.referrer ? x.referrer.replace(/^www\./, '') : 'direct'),
      in_app: !!Number(x.in_app),
      has_summary: S.has(x.distinct_id),
      engaged_s: engagedS,
      attentive_s: Number(s.attentive_s) || 0,
      engaged30: engagedS >= 30,
      interacted: !!i || !!Number(s.interacted),
      ms_to_first: i ? Number(i.ms_to_first) : null,
      clicked_out: !!o || !!Number(s.clicked_out),
      destinations: o ? o.destinations : [],
      bounce: engagedS < 10 && !i && !Number(s.interacted),
      travel: Number(s.travel) || 0, taps: Number(s.taps) || 0, drags: Number(s.drags) || 0, keys: Number(s.keys) || 0,
      fps: p ? Number(p.fps) : null, load_ms: p ? Number(p.load_ms) : null,
    };
  });
}

// ---- synthetic data for --demo -----------------------------------------------------
function demoVisitors(variants) {
  const r = rng(2026), out = [];
  for (let k = 0; k < 520; k++) {
    const variant = variants[r() < 0.5 ? 0 : 1], touch = r() < 0.6;
    const lift = variant === variants[1] ? 1.25 : 1;
    const engagedS = Math.round(-Math.log(1 - r()) * 22 * lift * (touch ? 0.8 : 1.2));
    const interacted = r() < (touch ? 0.55 : 0.8);
    out.push({
      id: 'demo-' + k, variant, mixed: false, first_seen: new Date(Date.now() - r() * 14 * 864e5).toISOString(),
      page_loads: 1 + (r() < 0.15), input: touch ? 'touch' : 'mouse', source: r() < 0.6 ? 'linkedin' : r() < 0.5 ? 'github' : 'direct',
      in_app: touch && r() < 0.5, has_summary: r() < 0.9, engaged_s: engagedS, attentive_s: Math.round(engagedS * 0.6),
      engaged30: engagedS >= 30, interacted, ms_to_first: interacted ? Math.round(800 + r() * 4000) : null,
      clicked_out: false, destinations: [], bounce: engagedS < 10 && !interacted,
      travel: interacted ? +(r() * 12 * lift).toFixed(1) : 0, taps: Math.round(r() * 4), drags: Math.round(r() * 2), keys: Math.round(r() * 2),
      fps: Math.round((variant === variants[0] ? 48 : 58) - (touch ? 8 : 0) + r() * 6), load_ms: Math.round((variant === variants[0] ? 1400 : 600) + r() * 900),
    });
  }
  out.forEach((v) => { if (r() < 0.06 * (v.variant === variants[1] ? 1.25 : 1)) { v.clicked_out = true; v.destinations = ['github.com']; } });
  return out;
}

// ---- report -------------------------------------------------------------------------
const pct = (x, d = 1) => (Number.isFinite(x) ? (x * 100).toFixed(d) + '%' : '–');
const pp = (x) => (Number.isFinite(x) ? (x >= 0 ? '+' : '') + (x * 100).toFixed(1) + ' pp' : '–');
const num = (x, d = 0) => (Number.isFinite(x) ? x.toFixed(d) : '–');
const pv = (p) => (!Number.isFinite(p) ? '–' : p < 0.001 ? '< 0.001' : p.toFixed(3));

function binaryRow(label, A, B, key) {
  const xa = A.filter((v) => v[key]).length, xb = B.filter((v) => v[key]).length;
  if (!A.length || !B.length) return `| ${label} | – | – | – | – | – |`;
  const t = twoProportions(xa, A.length, xb, B.length);
  return `| ${label} | ${pct(t.pa)} (${xa}/${A.length}) | ${pct(t.pb)} (${xb}/${B.length}) | ${pp(t.diff)} [${pp(t.ci[0])}, ${pp(t.ci[1])}] | ${pv(t.p)} | ${pct(probBBeatsA(xa, A.length, xb, B.length), 0)} |`;
}
function continuousRow(label, A, B, key, unit = '') {
  const a = A.map((v) => v[key]).filter(Number.isFinite), b = B.map((v) => v[key]).filter(Number.isFinite);
  if (!a.length || !b.length) return `| ${label} | – | – | – | – | – |`;
  const mw = mannWhitney(a, b), bs = bootstrapMedianDiff(a, b);
  return `| ${label} | ${num(median(a), 1)}${unit} | ${num(median(b), 1)}${unit} | ${bs.diff >= 0 ? '+' : ''}${num(bs.diff, 1)}${unit} [${num(bs.ci[0], 1)}, ${num(bs.ci[1], 1)}] | ${pv(mw.p)} | ${pct(mw.probBGreater, 0)} |`;
}

function analyse(visitors, cfg, { demo }) {
  const [va, vb] = cfg.variants;
  const mixed = visitors.filter((v) => v.mixed);
  const clean = visitors.filter((v) => !v.mixed && cfg.variants.includes(v.variant));
  const A = clean.filter((v) => v.variant === va), B = clean.filter((v) => v.variant === vb);
  const ratio = srm([A.length, B.length], cfg.weights);
  const first = visitors.map((v) => v.first_seen).sort()[0];
  const days = first ? Math.max(1, (Date.now() - new Date(first)) / 864e5) : 0;
  const perDay = days ? clean.length / days : 0;
  const remaining = Math.max(0, PLAN.perArm * 2 - clean.length);
  const eta = perDay > 0 && remaining ? Math.ceil(remaining / perDay) : null;

  const xa = A.filter((v) => v.engaged30).length, xb = B.filter((v) => v.engaged30).length;
  const prim = A.length && B.length ? twoProportions(xa, A.length, xb, B.length) : null;
  const pBest = A.length && B.length ? probBBeatsA(xa, A.length, xb, B.length) : NaN;
  const reached = Math.min(A.length, B.length) >= PLAN.perArm;

  let verdict;
  if (ratio.p < 0.001 && clean.length > 50) verdict = `⚠️ **Sample ratio mismatch** (p ${pv(ratio.p)}): the split isn't matching ${cfg.weights.join(':')}. Something is broken in assignment or tracking, so don't trust the results until it's fixed.`;
  else if (!reached) verdict = `⏳ **Keep running.** ${clean.length} of ${PLAN.perArm * 2} planned visitors (${pct(clean.length / (PLAN.perArm * 2), 0)}).` + (eta ? ` At ~${perDay.toFixed(1)} visitors/day, about **${eta} more days**.` : '') + ' Results below are early and will move; don\'t pick a winner yet.';
  else if (prim.p < PLAN.alpha) verdict = `✅ **${prim.diff > 0 ? vb : va} wins** on the primary metric: ${pct(prim.pb)} vs ${pct(prim.pa)} engaged ≥ 30 s (${pp(prim.diff)}, p ${pv(prim.p)}).`;
  else verdict = `🤝 **No clear winner.** The planned sample has been reached and the difference (${pp(prim.diff)}) isn't significant (p ${pv(prim.p)}). Pick the one you prefer, or run a bolder variant.`;

  const seg = (label, f) => {
    const a = A.filter(f), b = B.filter(f);
    return binaryRow(`${label} (n=${a.length}/${b.length})`, a, b, 'engaged30');
  };
  const sources = [...new Set(clean.map((v) => v.source))].sort((s, t) => clean.filter((v) => v.source === t).length - clean.filter((v) => v.source === s).length).slice(0, 5);
  const dest = {};
  clean.forEach((v) => (v.destinations || []).forEach((d) => { dest[d] = dest[d] || { [va]: 0, [vb]: 0 }; dest[d][v.variant]++; }));
  const noSummary = clean.filter((v) => !v.has_summary).length;
  const H = '| Metric | ' + va + ' | ' + vb + ' | ' + vb + ' − ' + va + ' (95% CI) | p | P(' + vb + ' better) |\n|---|---|---|---|---|---|';

  return `# anton.miami A/B report: ${new Date().toISOString().slice(0, 10)}${demo ? ' (DEMO DATA)' : ''}

Experiment \`${cfg.experiment}\` · **${va}** vs **${vb}** · ${clean.length} visitors (${A.length} / ${B.length}) since ${first ? first.slice(0, 10) : '–'}

${verdict}

## Primary metric (pre-registered)
Share of visitors who stayed **≥ 30 seconds** with the page visible. Plan: ${PLAN.perArm} visitors per arm, enough to detect ${pct(PLAN.baseline, 0)} → ${pct(PLAN.baseline + PLAN.minEffect, 0)} at α = ${PLAN.alpha}, 80% power.

${H}
${binaryRow('Engaged ≥ 30 s', A, B, 'engaged30')}

## Secondary metrics
${H}
${binaryRow('Interacted at all', A, B, 'interacted')}
${binaryRow('Clicked a link out', A, B, 'clicked_out')}
${binaryRow('Bounced (< 10 s, no input)', A, B, 'bounce')}
${continuousRow('Visible time (median)', A, B, 'engaged_s', ' s')}
${continuousRow('Attentive time (median)', A, B, 'attentive_s', ' s')}
${continuousRow('Pointer travel (screens)', A, B, 'travel')}
${continuousRow('Time to first input', A, B, 'ms_to_first', ' ms')}

*Proportions: Newcombe CI, pooled z-test, Bayesian P with uniform priors. Times: bootstrap CI of the median difference, Mann–Whitney p, and "P(${vb} better)" = probability a random ${vb} visitor exceeds a random ${va} visitor (lower is better for bounce and time to first input).*

## Segments (primary metric)
${H}
${seg('Mouse', (v) => v.input === 'mouse')}
${seg('Touch', (v) => v.input === 'touch')}
${seg('In-app browser (LinkedIn etc.)', (v) => v.in_app)}
${sources.map((s) => seg('Source: ' + s, (v) => v.source === s)).join('\n')}

Segments are for understanding, not for picking a winner: with many slices, one will look significant by chance.

## Performance (possible confounder)
| | ${va} | ${vb} |
|---|---|---|
| Median frame rate (first 6 s) | ${num(median(A.map((v) => v.fps).filter(Number.isFinite)))} fps | ${num(median(B.map((v) => v.fps).filter(Number.isFinite)))} fps |
| Visitors under 30 fps | ${pct(mean(A.filter((v) => Number.isFinite(v.fps)).map((v) => v.fps < 30)))} | ${pct(mean(B.filter((v) => Number.isFinite(v.fps)).map((v) => v.fps < 30)))} |
| Median load time | ${num(median(A.map((v) => v.load_ms).filter(Number.isFinite)))} ms | ${num(median(B.map((v) => v.load_ms).filter(Number.isFinite)))} ms |
| Engaged ≥ 30 s when ≥ 45 fps | ${pct(mean(A.filter((v) => v.fps >= 45).map((v) => v.engaged30)))} | ${pct(mean(B.filter((v) => v.fps >= 45).map((v) => v.engaged30)))} |

If one design wins mainly among slow devices, the difference may be speed rather than design.

## Where people went
${Object.keys(dest).length ? '| Destination | ' + va + ' | ' + vb + ' |\n|---|---|---|\n' + Object.entries(dest).map(([d, c]) => `| ${d} | ${c[va]} | ${c[vb]} |`).join('\n') : 'No outbound clicks yet.'}

## Data quality
- Sample ratio check: ${A.length} : ${B.length} vs expected ${cfg.weights.join(':')}, χ² p = ${pv(ratio.p)} ${ratio.p < 0.01 ? '⚠️' : '✓'}
- Visitors who saw both variants (excluded): ${mixed.length}${mixed.length > clean.length * 0.05 ? ' ⚠️ more than 5%, cookies may be getting lost' : ''}
- Visitors with no leave summary (time taken from engagement milestones instead): ${noSummary} (${pct(clean.length ? noSummary / clean.length : NaN, 0)})
- Median visible time, all visitors: ${num(median(clean.map((v) => v.engaged_s)))} s · 90th percentile: ${num(quantile(clean.map((v) => v.engaged_s), 0.9))} s
`;
}

function toCsv(rows) {
  const cols = ['id', 'variant', 'mixed', 'first_seen', 'page_loads', 'input', 'source', 'in_app', 'engaged_s', 'attentive_s', 'engaged30', 'interacted', 'ms_to_first', 'clicked_out', 'bounce', 'travel', 'taps', 'drags', 'keys', 'fps', 'load_ms'];
  const esc = (x) => (x === null || x === undefined ? '' : /[",\n]/.test(String(x)) ? `"${String(x).replace(/"/g, '""')}"` : String(x));
  return [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n') + '\n';
}

// ---- main -----------------------------------------------------------------------------
async function main() {
  loadEnv();
  const cfg = wranglerVars();
  const demo = args.has('--demo');
  if (!demo && !process.env.POSTHOG_PERSONAL_API_KEY) {
    console.error('analyze: set POSTHOG_PERSONAL_API_KEY (and POSTHOG_PROJECT_ID) in .env; see README → Analysis.\nTry `npm run analyze -- --demo` to preview a report.');
    process.exit(1);
  }
  const visitors = demo ? demoVisitors(cfg.variants) : await fetchVisitors(cfg.experiment);
  const report = analyse(visitors, cfg, { demo });
  const date = new Date().toISOString().slice(0, 10);
  mkdirSync(join(ROOT, 'reports'), { recursive: true });
  mkdirSync(join(ROOT, 'data'), { recursive: true });
  const suffix = demo ? '-demo' : '';
  writeFileSync(join(ROOT, 'reports', `${date}${suffix}.md`), report);
  writeFileSync(join(ROOT, 'reports', `latest${suffix}.md`), report);
  writeFileSync(join(ROOT, 'data', `visitors-${date}${suffix}.csv`), toCsv(visitors));
  const headline = report.split('\n').find((l) => /^(⏳|✅|🤝|⚠️)/.test(l)) || '';
  console.log(report);
  console.log(`\nSaved reports/${date}${suffix}.md and data/visitors-${date}${suffix}.csv`);
  if (args.has('--notify') && process.platform === 'darwin') {
    const msg = headline.replace(/\*\*/g, '').replace(/["\\]/g, '').slice(0, 220);
    try { execFileSync('osascript', ['-e', `display notification "${msg}" with title "anton.miami A/B test"`]); } catch { /* notifications are best-effort */ }
  }
}

main().catch((e) => { console.error('analyze:', e.message); process.exit(1); });
