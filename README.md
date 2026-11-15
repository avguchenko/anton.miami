# anton.miami

Personal front page, run as an A/B test between two designs:

| Variant | File | What it is |
|---|---|---|
| `dawn`  | `public/variants/dawn/index.html`  | "Anton in Miami": a line-drawn sea under the real sky, with a wake under the pointer |
| `chart` | `public/variants/chart/index.html` | "Anton Miami": a living nautical chart of the Straits of Florida |

A Cloudflare Worker (`src/worker.js`) serves `https://anton.miami/`. On a visitor's first visit it
picks a variant at random (50/50) and stores the choice in a cookie, so returning
visitors always see the same page. There's no redirect and no flicker, and the URL stays `anton.miami/`.
Analytics go to PostHog through a first-party proxy at `/ingest`, so ad blockers
don't silently drop data.

```
public/
  variants/dawn/index.html     variant A
  variants/chart/index.html    variant B
  ab/track.js                  shared tracking (PostHog + behavioural events)
  og.png                       neutral link-preview card (same for both variants)
src/worker.js                  split + cookie + PostHog proxy
wrangler.jsonc                 Worker config (variants, weights, experiment name, domain)
```

## One-time setup

### 1. PostHog
1. Create a free account at posthog.com (US cloud) and a project called `anton.miami`.
2. Copy the **Project API key** (`phc_…`) into `POSTHOG_KEY` at the top of `public/ab/track.js`.
3. In the project settings, turn on **Session replay**, **Heatmaps** and **Autocapture**.
   *Web analytics* works out of the box.
4. If you chose the EU cloud instead, set `POSTHOG_UI` in `track.js` to `https://eu.posthog.com`
   and `POSTHOG_REGION` in `wrangler.jsonc` to `"eu"`.

Until a real key is in place the tracker runs in "keyless" mode: it sends nothing and logs every event to the
browser console.

### 2. Cloudflare
1. **Free the domain from the `yardsale` Worker.** `anton.miami` and `www.anton.miami` are attached
   to the `yardsale` Worker as custom domains (that's what redirects them today). In
   Workers & Pages → **yardsale** → Settings → **Domains & Routes**, remove `anton.miami` and
   `www.anton.miami`. Keep `yardsale.anton.miami`; Yard Sale keeps working, it just isn't linked
   from the front page.
2. Deploy this Worker right away (next step). It claims both domains, and `www` redirects to the root.
3. **Deploy.** Choose one:
   - *Git-connected (recommended):* Workers & Pages → Create → **Import a repository** →
     `avguchenko/anton.miami`, production branch `main`. Leave the build command blank; the deploy command is
     `npx wrangler deploy`. Every push to `main` redeploys.
   - *From your Mac:* `npm install && npx wrangler login && npx wrangler deploy`.
4. `wrangler.jsonc` attaches the Worker to `anton.miami` as a custom domain. If the
   deploy complains about it, add it by hand under Worker → Settings → Domains & Routes.

### 3. Exclude yourself
Open `https://anton.miami/?ab_optout=1` once in every browser and on every phone you use (undo with
`?ab_optout=0`). Visitors with Global Privacy Control or Do Not Track turned on are never tracked.

## Links to share

LinkedIn and most apps hide where a click came from, so give each profile its own tagged link:

| Where | Link |
|---|---|
| LinkedIn profile / featured | `https://anton.miami/?utm_source=linkedin&utm_medium=profile` |
| LinkedIn post | `https://anton.miami/?utm_source=linkedin&utm_medium=post` |
| GitHub profile | `https://anton.miami/?utm_source=github&utm_medium=profile` |
| X / Instagram / other | `https://anton.miami/?utm_source=<site>&utm_medium=profile` |
| Email signature | `https://anton.miami/?utm_source=email&utm_medium=signature` |

The link preview (title, description, `og.png`) is identical for both variants, so it can't favour
either one. After deploying, paste the URL into LinkedIn's **Post Inspector**
(linkedin.com/post-inspector) to refresh LinkedIn's cached preview.

## Previewing variants

- `https://anton.miami/?v=dawn` or `?v=chart` forces a variant. It isn't stored and is flagged `ab_preview`.
- `https://anton.miami/variants/dawn/` opens the page directly (`noindex`, also flagged `ab_preview`).
- Add `&ab_debug=1` to print every tracking event to the console.

## What's measured

Every event carries `variant`, `ab_experiment`, `ab_assignment` (`new` / `returning` / `forced`) and `ab_preview`.

| Event | When | Key properties |
|---|---|---|
| `ab_exposure` | page load | viewport, `input_class` (mouse/touch), `reduced_motion`, `referrer_domain`, `utm_*` |
| `first_interaction` | first move / tap / key | `kind`, `ms_to_first` |
| `engaged` | 10, 30, 60, 120, 300 s of *visible* time | `seconds`, `interacted` |
| `key_used` | first press of each distinct key | `key` |
| `ui_click` | in-page buttons (projection, edition) | `control` |
| `coords_pasted` | pasting coordinates (dawn) | `moved`, `place` |
| `view_changed` | URL hash changes | `hash` |
| `outbound_click` | any link off the site | `destination`, `href`, `label`, `seconds_on_page` |
| `page_summary` | tab hidden / page closed | `visible_s`, `attentive_s` (visible + input in the last 15 s), `exit` (`outbound`/`left`), `exit_href`, `pointer_travel_screens`, `taps`, `drags`, `keys`, `distinct_keys`, `max_idle_s`, `heat_grid` (12×8, % of pointer time per cell) |

PostHog's own data covers the rest: `$pageview` / `$pageleave`, autocaptured clicks, **heatmaps**
(click, rage-click and mouse-movement overlays in the Toolbar) and **session replays** that
include the canvas at 2 fps, so you can watch the cursor move over the actual animation. To turn
canvas recording off, set `RECORD_CANVAS = false` in `track.js`.

`page_summary` can fire more than once per page load when someone tabs away and back. Its
numbers are cumulative within that load, so keep the row with the highest `seq` per `page_id`,
then roll page loads up into sessions (the SQL below does this). `max_idle_s` includes the idle
stretch still running when the visitor leaves.

## Running the test properly

**Decide the primary metric before you look at results.** Suggested:

> **Primary:** share of exposed visitors who stay **≥ 30 s visible** (`engaged` with `seconds = 30`).
> **Secondary:** interaction rate (`first_interaction`), median `attentive_s`, outbound click-through.
> **Guardrail:** bounce under 10 s.

Always filter `ab_preview = false`, and segment by `input_class`, because phone and mouse visitors
behave very differently on these pages.

**Sample size.** To detect a move from 30% to 40% engaged at 95% confidence / 80% power you need about
**360 visitors per variant (~720 total)**. Profile traffic is modest, so plan on several weeks.
Settle the stopping point up front (a visitor count or a date) and don't stop early because one
variant pulls ahead. Early leads at small sample sizes are mostly noise.

### PostHog insights to build
1. **Funnel:** `ab_exposure` → `engaged` (seconds = 30), broken down by `variant`. Filter `ab_preview = false`.
   PostHog shows the conversion rates; the significance check is below.
2. **Funnel:** `ab_exposure` → `outbound_click`, by `variant`.
3. **Trend:** `page_summary` → median of `attentive_s`, by `variant`.
4. **Web analytics** → filter `variant`, to see referrers and UTM sources.

### SQL (PostHog → SQL editor)
```sql
-- 1) one row per page load: the final page_summary of that load
WITH loads AS (
  SELECT
    any(properties.variant)                                   AS variant,
    any(properties.$session_id)                               AS sid,
    argMax(toFloat(properties.visible_s),   toInt(properties.seq)) AS visible_s,
    argMax(toFloat(properties.attentive_s), toInt(properties.seq)) AS attentive_s,
    argMax(properties.exit,                 toInt(properties.seq)) AS exit,
    argMax(toFloat(properties.pointer_travel_screens), toInt(properties.seq)) AS travel
  FROM events
  WHERE event = 'page_summary'
    AND properties.ab_preview = false
    AND properties.ab_experiment = 'front-page-2026-11'
  GROUP BY properties.page_id
),
-- 2) roll page loads (reloads, extra tabs) up into sessions
s AS (
  SELECT variant, sid,
    sum(visible_s)            AS visible_s,
    sum(attentive_s)          AS attentive_s,
    max(exit = 'outbound')    AS clicked_out,
    sum(travel)               AS travel
  FROM loads
  GROUP BY variant, sid
)
SELECT
  variant,
  count()                                AS sessions,
  round(avg(visible_s >= 30) * 100, 1)   AS pct_engaged_30s,
  quantile(0.5)(visible_s)               AS median_visible_s,
  quantile(0.5)(attentive_s)             AS median_attentive_s,
  round(avg(clicked_out) * 100, 1)       AS pct_clicked_out,
  round(avg(travel), 1)                  AS avg_pointer_travel_screens
FROM s
GROUP BY variant
ORDER BY variant
```
For the significance check on the primary metric, put the two `sessions` / `pct_engaged_30s` pairs
into a two-proportion z-test. PostHog's experiment calculator or any online A/B significance
calculator works.

## Changing the experiment
- **Weights:** `WEIGHTS` in `wrangler.jsonc` (e.g. `"1,3"`).
- **New round** (e.g. a third design): add `public/variants/<name>/index.html` with
  `<meta name="ab-variant" content="<name>">` and the `track.js` script tag, add it to `VARIANTS`,
  and change `EXPERIMENT`. Changing `EXPERIMENT` re-randomises everyone.
- **Ending the test:** set `VARIANTS` to the winner alone.

## Local development
```
npm install
npx wrangler dev        # http://localhost:8787  (try /?v=chart&ab_debug=1)
```
