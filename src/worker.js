// anton.miami edge Worker
//
//  /                 -> one of the front-page variants, chosen at random on a
//                       visitor's first visit and kept (cookie) on later visits
//  /?v=<name>        -> force a variant for previewing (not stored, flagged as preview)
//  /ingest/*         -> first-party proxy to PostHog, so ad blockers don't drop data
//  /variants/<name>/ -> direct preview of a variant (noindex, flagged as preview)
//  anything else     -> static assets from ./public

const ASSIGN_COOKIE = 'am_ab';   // "<experiment>:<variant>"
const VISITOR_COOKIE = 'am_vid'; // anonymous visitor id, shared with PostHog as distinct_id
const COOKIE_DAYS = 120;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname.startsWith('/ingest/') || url.pathname === '/ingest') {
      return proxyPostHog(request, url, env);
    }

    if (url.pathname === '/' || url.pathname === '/index.html') {
      return serveFrontPage(request, url, env);
    }

    const res = await env.ASSETS.fetch(request);
    if (url.pathname.startsWith('/variants/')) {
      const out = new Response(res.body, res);
      out.headers.set('X-Robots-Tag', 'noindex');
      return out;
    }
    return res;
  },
};

function config(env) {
  const variants = String(env.VARIANTS || 'dawn,chart').split(',').map(s => s.trim()).filter(Boolean);
  const weights = String(env.WEIGHTS || '').split(',').map(Number);
  return {
    variants,
    weights: variants.map((_, i) => (weights[i] > 0 ? weights[i] : 1)),
    experiment: String(env.EXPERIMENT || 'front-page'),
  };
}

function pickWeighted(variants, weights) {
  const total = weights.reduce((a, b) => a + b, 0);
  // crypto-grade randomness: unbiased, independent of anything about the visitor
  const r = (crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32) * total;
  let acc = 0;
  for (let i = 0; i < variants.length; i++) {
    acc += weights[i];
    if (r < acc) return variants[i];
  }
  return variants[variants.length - 1];
}

function readCookies(request) {
  const out = {};
  const header = request.headers.get('Cookie') || '';
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function cookie(name, value, url) {
  const secure = url.protocol === 'https:' ? '; Secure' : '';
  return `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${COOKIE_DAYS * 86400}; SameSite=Lax${secure}`;
}

async function serveFrontPage(request, url, env) {
  const { variants, weights, experiment } = config(env);
  const cookies = readCookies(request);

  const forced = url.searchParams.get('v');
  let variant, assignment;

  if (forced && variants.includes(forced)) {
    variant = forced;
    assignment = 'forced';
  } else {
    const [exp, saved] = String(cookies[ASSIGN_COOKIE] || '').split(':');
    if (exp === experiment && variants.includes(saved)) {
      variant = saved;
      assignment = 'returning';
    } else {
      variant = pickWeighted(variants, weights);
      assignment = 'new';
    }
  }

  const visitorId = /^[0-9a-f-]{36}$/.test(cookies[VISITOR_COOKIE] || '') ? cookies[VISITOR_COOKIE] : crypto.randomUUID();

  const asset = await env.ASSETS.fetch(new Request(new URL(`/variants/${variant}/`, url), request));
  if (!asset.ok) return asset;

  // Tell the page which experiment arm it is and how it got here. The page's own
  // <meta name="ab-variant"> is the source of truth for *which* page it is.
  const rewritten = new HTMLRewriter()
    .on('head', {
      element(el) {
        el.prepend(
          `<meta name="ab-experiment" content="${experiment}">` +
          `<meta name="ab-assignment" content="${assignment}">`,
          { html: true },
        );
      },
    })
    .transform(asset);

  const res = new Response(rewritten.body, rewritten);
  res.headers.set('Cache-Control', 'private, no-store');
  res.headers.set('Vary', 'Cookie');
  res.headers.set('X-AB-Variant', variant);
  res.headers.append('Set-Cookie', cookie(VISITOR_COOKIE, visitorId, url));
  if (assignment !== 'forced') {
    res.headers.append('Set-Cookie', cookie(ASSIGN_COOKIE, `${experiment}:${variant}`, url));
  }
  return res;
}

async function proxyPostHog(request, url, env) {
  const region = env.POSTHOG_REGION === 'eu' ? 'eu' : 'us';
  const path = url.pathname.replace(/^\/ingest/, '') || '/';
  const host = path.startsWith('/static/') || path.startsWith('/array/')
    ? `${region}-assets.i.posthog.com`
    : `${region}.i.posthog.com`;

  const target = new URL(path + url.search, `https://${host}`);
  const headers = new Headers(request.headers);
  headers.delete('cookie');
  headers.set('Host', host);
  const ip = request.headers.get('CF-Connecting-IP');
  if (ip) headers.set('X-Forwarded-For', ip); // keeps PostHog's GeoIP accurate

  const init = { method: request.method, headers, redirect: 'manual' };
  if (request.method !== 'GET' && request.method !== 'HEAD') init.body = request.body;
  return fetch(target, init);
}
