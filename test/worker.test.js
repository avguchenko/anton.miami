// Unit tests for the edge Worker (node:test, no extra dependencies).
// HTMLRewriter only exists on Cloudflare, so a pass-through stand-in is used here.
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.HTMLRewriter ??= class { on() { return this; } transform(r) { return r; } };
const { default: worker } = await import('../src/worker.js');

const VARIANTS = ['dawn', 'chart'];
function env(over = {}) {
  return {
    VARIANTS: VARIANTS.join(','),
    WEIGHTS: '1,1',
    EXPERIMENT: 'exp-1',
    POSTHOG_REGION: 'us',
    ASSETS: {
      fetch: async (req) => {
        const path = new URL(req.url ?? req).pathname;
        const m = path.match(/^\/variants\/([^/]+)\/$/);
        if (m && VARIANTS.includes(m[1])) {
          return new Response(`<html><head><meta name="ab-variant" content="${m[1]}"></head></html>`,
            { headers: { 'content-type': 'text/html' } });
        }
        return new Response('asset ' + path, { status: path === '/missing' ? 404 : 200 });
      },
    },
    ...over,
  };
}
const get = (url, headers = {}, e = env()) => worker.fetch(new Request(url, { headers }), e);
const cookies = (res) => res.headers.getSetCookie();

test('new visitors are split roughly evenly', async () => {
  const counts = { dawn: 0, chart: 0 };
  for (let i = 0; i < 2000; i++) counts[(await get('https://anton.miami/')).headers.get('X-AB-Variant')]++;
  assert.ok(counts.dawn > 850 && counts.chart > 850, JSON.stringify(counts));
});

test('weights are respected', async () => {
  let chart = 0;
  for (let i = 0; i < 2000; i++) {
    if ((await get('https://anton.miami/', {}, env({ WEIGHTS: '1,3' }))).headers.get('X-AB-Variant') === 'chart') chart++;
  }
  assert.ok(chart > 1350 && chart < 1650, `chart=${chart}`);
});

test('assignment is sticky via cookie and never cached', async () => {
  const res = await get('https://anton.miami/', { Cookie: 'am_ab=exp-1:chart' });
  assert.equal(res.headers.get('X-AB-Variant'), 'chart');
  assert.match(res.headers.get('Cache-Control'), /no-store/);
  assert.ok(cookies(res).some(c => c.startsWith('am_ab=exp-1%3Achart')));
});

test('a new experiment name re-randomises old cookies', async () => {
  const seen = new Set();
  for (let i = 0; i < 50; i++) {
    seen.add((await get('https://anton.miami/', { Cookie: 'am_ab=old-exp:chart' })).headers.get('X-AB-Variant'));
  }
  assert.deepEqual([...seen].sort(), ['chart', 'dawn']);
});

test('unknown variant in cookie is ignored', async () => {
  const res = await get('https://anton.miami/', { Cookie: 'am_ab=exp-1:retired' });
  assert.ok(VARIANTS.includes(res.headers.get('X-AB-Variant')));
});

test('?v= forces a variant without storing it', async () => {
  const res = await get('https://anton.miami/?v=dawn', { Cookie: 'am_ab=exp-1:chart' });
  assert.equal(res.headers.get('X-AB-Variant'), 'dawn');
  assert.ok(!cookies(res).some(c => c.startsWith('am_ab=')));
});

test('visitor id cookie is set and reused', async () => {
  const id = '0fdd6e80-2fa6-480e-b096-160d09c4aa9c';
  const res = await get('https://anton.miami/', { Cookie: `am_vid=${id}` });
  assert.ok(cookies(res).some(c => c.startsWith(`am_vid=${id}`)));
  const fresh = await get('https://anton.miami/');
  assert.ok(cookies(fresh).some(c => /^am_vid=[0-9a-f-]{36};/.test(c)));
});

test('cookies are Secure on https', async () => {
  const res = await get('https://anton.miami/');
  assert.ok(cookies(res).every(c => c.includes('Secure') && c.includes('SameSite=Lax')));
});

test('www redirects to the apex, keeping path and query', async () => {
  const res = await get('https://www.anton.miami/?utm_source=linkedin');
  assert.equal(res.status, 301);
  assert.equal(res.headers.get('Location'), 'https://anton.miami/?utm_source=linkedin');
});

test('direct variant URLs are noindex', async () => {
  const res = await get('https://anton.miami/variants/chart/');
  assert.equal(res.headers.get('X-Robots-Tag'), 'noindex');
});

test('other paths fall through to static assets', async () => {
  const res = await get('https://anton.miami/og.png');
  assert.equal(await res.text(), 'asset /og.png');
});

test('/ingest proxies to the right PostHog hosts without cookies', async () => {
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => { calls.push({ url: String(url), init }); return new Response('ok'); };
  try {
    await get('https://anton.miami/ingest/e/?ip=1', { Cookie: 'am_vid=x', 'CF-Connecting-IP': '203.0.113.9' });
    await get('https://anton.miami/ingest/static/array.js');
    await get('https://anton.miami/ingest/e/', {}, env({ POSTHOG_REGION: 'eu' }));
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(calls[0].url, 'https://us.i.posthog.com/e/?ip=1');
  assert.equal(calls[0].init.headers.get('cookie'), null);
  assert.equal(calls[0].init.headers.get('X-Forwarded-For'), '203.0.113.9');
  assert.equal(calls[1].url, 'https://us-assets.i.posthog.com/static/array.js');
  assert.equal(calls[2].url, 'https://eu.i.posthog.com/e/');
});
