// habits.anton.miami: a daily habit tracker.
//
//  /            the page (static, from ./public); it shows a login form until signed in
//               (no sign-in when run locally without a password: `npm run habits`)
//  /api/login   POST { password } -> session cookie (rate-limited)
//  /api/logout  POST
//  /api/state   GET  every habit and every check-off
//  /api/habits  POST { name, today }                     add
//  /api/habits/:id            PATCH { name } | { dir }   rename | move up/down
//  /api/habits/:id/check      POST { day, done }
//  /api/habits/:id/remove     POST { confirm, today }    (harder the more work it has)
//  /api/habits/:id/keep       POST { today }             cancel a pending removal
//
// Everything is stored in one SQLite-backed Durable Object. The password is the
// HABITS_PASSWORD secret; the session cookie is signed with a key derived from it,
// so changing the password signs out every device.

import { DurableObject } from 'cloudflare:workers';
import { Store } from './store.js';
import { makeSession, validSession, safeEqual, SESSION_DAYS } from './session.js';

const COOKIE = 'hb_session';

export class HabitsDO extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.store = new Store(ctx.storage.sql);
  }
  // One RPC entry point; returns { status, body }.
  call(op, ...args) {
    const s = this.store;
    switch (op) {
      case 'state': return s.state();
      case 'add': return s.addHabit(...args);
      case 'rename': return s.rename(...args);
      case 'move': return s.move(...args);
      case 'check': return s.setCheck(...args);
      case 'remove': return s.remove(...args);
      case 'keep': return s.keep(...args);
      case 'loginLockedFor': return s.loginLockedFor();
      case 'loginFailed': return s.loginFailed();
      case 'loginSucceeded': return s.loginSucceeded();
      default: return { status: 404, body: { error: 'Unknown operation.' } };
    }
  }
}

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });

function readCookie(request, name) {
  for (const part of (request.headers.get('Cookie') || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}
const setCookie = (value, maxAge, url) =>
  `${COOKIE}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Strict${url.protocol === 'https:' ? '; Secure' : ''}`;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);

    const password = env.HABITS_PASSWORD;
    // Local mode (`npm run habits` passes --var HABITS_LOCAL:1): no sign-in, and wrangler dev
    // only listens on this machine. Never set HABITS_LOCAL on the deployed Worker; with no
    // password and no local flag it refuses to serve any data.
    const local = env.HABITS_LOCAL === '1';
    if (!password && !local) return json({ error: 'HABITS_PASSWORD is not set on the Worker yet.' }, 503);

    // State-changing requests must be same-origin JSON (on top of SameSite=Strict).
    if (request.method !== 'GET') {
      const origin = request.headers.get('Origin');
      if ((origin && origin !== url.origin) || !(request.headers.get('content-type') || '').includes('application/json')) {
        return json({ error: 'Bad request.' }, 400);
      }
    }

    const db = env.HABITS.get(env.HABITS.idFromName('me'));
    const route = url.pathname.slice(5); // after "/api/"
    let body = {};
    if (request.method === 'POST' || request.method === 'PATCH') {
      try { body = await request.json(); } catch { return json({ error: 'Bad JSON.' }, 400); }
      if (!body || typeof body !== 'object') body = {};
    }

    if (route === 'login' && request.method === 'POST' && !local) {
      const lockedMs = await db.call('loginLockedFor');
      if (lockedMs > 0) {
        return json({ error: `Too many tries. Wait ${Math.ceil(lockedMs / 60000)} min.` }, 429, { 'retry-after': String(Math.ceil(lockedMs / 1000)) });
      }
      if (!(await safeEqual(body.password ?? '', password))) {
        await db.call('loginFailed');
        return json({ error: 'Wrong password.' }, 401);
      }
      await db.call('loginSucceeded');
      return json({ ok: true }, 200, { 'set-cookie': setCookie(await makeSession(password), SESSION_DAYS * 86400, url) });
    }
    if (route === 'logout' && request.method === 'POST') {
      return json({ ok: true }, 200, { 'set-cookie': setCookie('', 0, url) });
    }

    if (!local && !(await validSession(password, readCookie(request, COOKIE)))) return json({ error: 'Sign in.' }, 401);

    let r;
    let m;
    if (route === 'state' && request.method === 'GET') {
      r = await db.call('state');
      r.body.local = local;
    }
    else if (route === 'habits' && request.method === 'POST') r = await db.call('add', body);
    else if ((m = route.match(/^habits\/(\d+)$/)) && request.method === 'PATCH') {
      r = await db.call('dir' in body ? 'move' : 'rename', +m[1], body);
    } else if ((m = route.match(/^habits\/(\d+)\/(check|remove|keep)$/)) && request.method === 'POST') {
      r = await db.call(m[2], +m[1], body);
    } else r = { status: 404, body: { error: 'Not found.' } };
    return json(r.body, r.status);
  },
};
