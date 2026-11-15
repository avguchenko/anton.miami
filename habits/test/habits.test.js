// Tests for the habit tracker's storage rules and scoring (node:test + node:sqlite,
// standing in for the Durable Object's SQLite storage).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/store.js';
import { makeSession, validSession } from '../src/session.js';
import { Scorer, pct, addDays, removalPolicy, startOfWeek, isDay } from '../public/logic.js';

// Same shape as ctx.storage.sql: exec(query, ...bindings).toArray()
function memorySql() {
  const db = new DatabaseSync(':memory:');
  return { exec: (q, ...b) => { const rows = db.prepare(q).all(...b); return { toArray: () => rows }; } };
}

const TODAY = '2026-11-15';
const NOW = Date.parse('2026-11-15T15:00:00Z');
const store = () => new Store(memorySql());
const add = (s, name, today = TODAY) => s.addHabit({ name, today }, NOW).body.habit;
const checkDays = (s, id, from, n) => { for (let i = 0; i < n; i++) s.setCheck(id, { day: addDays(from, i), done: true }, NOW); };
const backdate = (s, id, day) => s.sql.exec('UPDATE habits SET start_on = ? WHERE id = ?', day, id);

test('add, rename, reorder, list', () => {
  const s = store();
  const a = add(s, '  Read   20 pages ');
  const b = add(s, 'Stretch');
  assert.equal(a.name, 'Read 20 pages');
  assert.equal(s.addHabit({ name: 'read 20 PAGES', today: TODAY }, NOW).status, 409);
  assert.equal(s.addHabit({ name: '', today: TODAY }, NOW).status, 400);
  assert.equal(s.addHabit({ name: 'x', today: '2026-11-20' }, NOW).status, 400, 'today must be near the server clock');
  s.rename(b.id, { name: 'Stretch 10 min' });
  s.move(b.id, { dir: -1 });
  assert.deepEqual(s.state().body.habits.map(h => h.name), ['Stretch 10 min', 'Read 20 pages']);
});

test('check-offs: only on days the habit existed, never in the future', () => {
  const s = store();
  const h = add(s, 'Walk');
  assert.equal(s.setCheck(h.id, { day: TODAY, done: true }, NOW).status, 200);
  assert.equal(s.setCheck(h.id, { day: TODAY, done: true }, NOW).status, 200, 'idempotent');
  assert.equal(s.setCheck(h.id, { day: '2026-11-14', done: true }, NOW).status, 400, 'before it started');
  assert.equal(s.setCheck(h.id, { day: '2026-11-18', done: true }, NOW).status, 400, 'future');
  assert.equal(s.setCheck(h.id, { day: '2026-02-30', done: true }, NOW).status, 400);
  assert.deepEqual(s.state().body.checks, [[h.id, TODAY]]);
  s.setCheck(h.id, { day: TODAY, done: false }, NOW);
  assert.deepEqual(s.state().body.checks, []);
});

test('removal policy scales with the work put in', () => {
  assert.equal(removalPolicy(0).tier, 'free');
  assert.equal(removalPolicy(5).tier, 'confirm');
  assert.equal(removalPolicy(21).tier, 'hard');
  assert.ok(removalPolicy(400).holdSeconds > removalPolicy(30).holdSeconds);
  assert.equal(removalPolicy(10000).holdSeconds, 30);
});

test('a habit with no check-offs is deleted outright', () => {
  const s = store();
  const h = add(s, 'Floss');
  assert.equal(s.remove(h.id, { today: TODAY }, NOW).body.removed, 'deleted');
  assert.equal(s.state().body.habits.length, 0);
});

test('a little history: must type the name; history is kept', () => {
  const s = store();
  const h = add(s, 'Journal');
  backdate(s, h.id, '2026-11-01');
  checkDays(s, h.id, '2026-11-01', 5);
  assert.equal(s.remove(h.id, { confirm: 'journ', today: TODAY }, NOW).status, 400);
  const r = s.remove(h.id, { confirm: 'journal', today: TODAY }, NOW);
  assert.equal(r.body.removed, 'retired');
  assert.equal(r.body.ends_on, TODAY);
  assert.equal(s.state().body.checks.length, 5);
  assert.equal(s.setCheck(h.id, { day: TODAY, done: true }, NOW).status, 400, 'retired habits take no new checks');
});

test('real history: cooling-off through tomorrow, and it can be kept', () => {
  const s = store();
  const h = add(s, 'Run');
  backdate(s, h.id, '2026-10-01');
  checkDays(s, h.id, '2026-10-01', 30);
  assert.equal(s.remove(h.id, { confirm: 'nope', today: TODAY }, NOW).status, 400);
  const r = s.remove(h.id, { confirm: 'Run', today: TODAY }, NOW);
  assert.equal(r.body.removed, 'pending');
  assert.equal(r.body.ends_on, '2026-11-17', 'still owed today and tomorrow');
  assert.equal(s.setCheck(h.id, { day: '2026-11-16', done: true }, NOW).status, 200);
  assert.equal(s.keep(h.id, { today: TODAY }, NOW).status, 200);
  assert.equal(s.habit(h.id).ends_on, null);
  // After the cooling-off ends it's too late to keep.
  s.remove(h.id, { confirm: 'run', today: TODAY }, NOW);
  const later = Date.parse('2026-11-17T15:00:00Z');
  assert.equal(s.keep(h.id, { today: '2026-11-17' }, later).status, 400);
});

test('login lock after repeated failures', () => {
  const s = store();
  for (let i = 0; i < 4; i++) s.loginFailed(NOW + i);
  assert.equal(s.loginLockedFor(NOW + 10), 0);
  s.loginFailed(NOW + 5);
  assert.ok(s.loginLockedFor(NOW + 10) > 14 * 60e3);
  assert.equal(s.loginLockedFor(NOW + 16 * 60e3), 0);
});

test('scoring: day, range, streaks, retired habits stop counting', () => {
  const habits = [
    { id: 1, start_on: '2026-11-10', ends_on: null },
    { id: 2, start_on: '2026-11-10', ends_on: '2026-11-13' },
  ];
  const checks = [[1, '2026-11-12'], [1, '2026-11-13'], [1, '2026-11-14'], [1, '2026-11-15'], [2, '2026-11-10'], [1, '2026-11-10']];
  const sc = new Scorer({ habits, checks });
  assert.deepEqual(sc.day('2026-11-10'), { done: 2, possible: 2 });
  assert.deepEqual(sc.day('2026-11-13'), { done: 1, possible: 1 });
  assert.deepEqual(sc.day('2026-11-09'), { done: 0, possible: 0 });
  assert.equal(pct(sc.day('2026-11-11')), 0);
  const wk = sc.range(startOfWeek(TODAY), addDays(startOfWeek(TODAY), 6), TODAY); // Mon 9 … Sun 15
  assert.deepEqual([wk.done, wk.possible, wk.perfect], [6, 9, 4]); // perfect: 10, 13, 14, 15
  assert.equal(sc.streak(1, TODAY), 4);
  assert.equal(sc.streak(1, '2026-11-16'), 4, 'today not done yet keeps yesterday\'s streak');
  assert.equal(sc.longestStreak(1), 4);
});

test('date helpers', () => {
  assert.ok(isDay('2028-02-29'));
  assert.ok(!isDay('2026-02-29'));
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(startOfWeek('2026-11-15'), '2026-11-09');
});

test('sessions: signed, expiring, tied to the password', async () => {
  const tok = await makeSession('pw', NOW);
  assert.ok(await validSession('pw', tok, NOW));
  assert.ok(!(await validSession('other', tok, NOW)));
  assert.ok(!(await validSession('pw', tok.replace(/.$/, c => (c === 'A' ? 'B' : 'A')), NOW)));
  assert.ok(!(await validSession('pw', tok, NOW + 400 * 86400e3)));
  assert.ok(!(await validSession('pw', 'garbage', NOW)));
});
