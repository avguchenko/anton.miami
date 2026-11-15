// Habit storage on a SQLite database (a Durable Object's ctx.storage.sql in
// production, node:sqlite in the tests). Every method returns
// { status, body } so the Worker can hand it straight back as JSON.

import { isDay, addDays, daysBetween, removalPolicy, sameName } from '../public/logic.js';

const MAX_NAME = 80;
const MAX_HABITS = 60;
const LOCK_FAILS = 5;            // failed logins allowed…
const LOCK_WINDOW_MS = 15 * 60e3; // …per 15 minutes

const ok = (body = { ok: true }) => ({ status: 200, body });
const err = (status, error) => ({ status, body: { error } });

export class Store {
  constructor(sql) {
    this.sql = sql;
    for (const q of [
      `CREATE TABLE IF NOT EXISTS habits (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         name TEXT NOT NULL,
         position INTEGER NOT NULL,
         start_on TEXT NOT NULL,
         ends_on TEXT,
         created_at INTEGER NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS checks (
         habit_id INTEGER NOT NULL,
         day TEXT NOT NULL,
         at INTEGER NOT NULL,
         PRIMARY KEY (habit_id, day))`,
      `CREATE TABLE IF NOT EXISTS login_failures (at INTEGER NOT NULL)`,
    ]) this.sql.exec(q);
  }

  rows(q, ...b) { return this.sql.exec(q, ...b).toArray(); }
  habit(id) { return this.rows('SELECT * FROM habits WHERE id = ?', id)[0] || null; }
  checkCount(id) { return this.rows('SELECT COUNT(*) AS n FROM checks WHERE habit_id = ?', id)[0].n; }

  state() {
    const habits = this.rows('SELECT id, name, position, start_on, ends_on FROM habits ORDER BY position, id');
    const checks = this.rows('SELECT habit_id, day FROM checks ORDER BY day').map(r => [r.habit_id, r.day]);
    return ok({ habits, checks });
  }

  // `today` comes from the browser; refuse anything more than a day away from
  // the server's clock (UTC−12 … UTC+14 all fall within that).
  static plausibleToday(today, now) {
    if (!isDay(today)) return false;
    return Math.abs(daysBetween(new Date(now).toISOString().slice(0, 10), today)) <= 1;
  }

  addHabit({ name, today }, now = Date.now()) {
    name = String(name ?? '').trim().replace(/\s+/g, ' ');
    if (!name || name.length > MAX_NAME) return err(400, `A habit needs a name of 1–${MAX_NAME} characters.`);
    if (!Store.plausibleToday(today, now)) return err(400, 'Bad date.');
    const active = this.rows('SELECT name FROM habits WHERE ends_on IS NULL OR ends_on > ?', today);
    if (active.length >= MAX_HABITS) return err(400, `That's ${MAX_HABITS} habits already.`);
    if (active.some(h => sameName(h.name, name))) return err(409, 'You already have that habit.');
    const pos = this.rows('SELECT COALESCE(MAX(position), 0) + 1 AS p FROM habits')[0].p;
    const row = this.rows(
      'INSERT INTO habits (name, position, start_on, created_at) VALUES (?, ?, ?, ?) RETURNING id, name, position, start_on, ends_on',
      name, pos, today, now)[0];
    return ok({ habit: row });
  }

  rename(id, { name }) {
    const h = this.habit(id);
    if (!h) return err(404, 'No such habit.');
    name = String(name ?? '').trim().replace(/\s+/g, ' ');
    if (!name || name.length > MAX_NAME) return err(400, `A habit needs a name of 1–${MAX_NAME} characters.`);
    this.sql.exec('UPDATE habits SET name = ? WHERE id = ?', name, id);
    return ok();
  }

  // Swap places with the neighbouring habit above (-1) or below (+1).
  move(id, { dir }) {
    const list = this.rows('SELECT id, position FROM habits ORDER BY position, id');
    const i = list.findIndex(h => h.id === id);
    if (i < 0) return err(404, 'No such habit.');
    const j = i + (dir < 0 ? -1 : 1);
    if (j < 0 || j >= list.length) return ok();
    [list[i], list[j]] = [list[j], list[i]];
    list.forEach((h, k) => this.sql.exec('UPDATE habits SET position = ? WHERE id = ?', k + 1, h.id));
    return ok();
  }

  setCheck(id, { day, done }, now = Date.now()) {
    const h = this.habit(id);
    if (!h) return err(404, 'No such habit.');
    if (!isDay(day)) return err(400, 'Bad date.');
    if (daysBetween(new Date(now).toISOString().slice(0, 10), day) > 1) return err(400, "That day hasn't happened yet.");
    if (day < h.start_on || (h.ends_on && day >= h.ends_on)) return err(400, "That habit wasn't on your list that day.");
    if (done) this.sql.exec('INSERT OR IGNORE INTO checks (habit_id, day, at) VALUES (?, ?, ?)', id, day, now);
    else this.sql.exec('DELETE FROM checks WHERE habit_id = ? AND day = ?', id, day);
    return ok();
  }

  // The friction is enforced here too, not just in the page.
  remove(id, { confirm, today }, now = Date.now()) {
    const h = this.habit(id);
    if (!h) return err(404, 'No such habit.');
    if (!Store.plausibleToday(today, now)) return err(400, 'Bad date.');
    if (h.ends_on && h.ends_on <= today) return err(400, 'That habit is already retired.');
    if (h.ends_on) return err(400, 'That habit is already on its way out.');
    const policy = removalPolicy(this.checkCount(id));
    if (policy.tier === 'free') {
      this.sql.exec('DELETE FROM checks WHERE habit_id = ?', id);
      this.sql.exec('DELETE FROM habits WHERE id = ?', id);
      return ok({ removed: 'deleted' });
    }
    if (policy.typeName && !sameName(confirm, h.name)) return err(400, 'Type the habit’s name exactly to remove it.');
    let endsOn;
    if (policy.coolingDays) endsOn = addDays(today, policy.coolingDays);
    else {
      // Retire from today, unless today is already checked off: then keep today's credit.
      const doneToday = this.rows('SELECT 1 FROM checks WHERE habit_id = ? AND day = ?', id, today).length > 0;
      endsOn = doneToday ? addDays(today, 1) : today;
    }
    this.sql.exec('UPDATE habits SET ends_on = ? WHERE id = ?', endsOn, id);
    return ok({ removed: policy.coolingDays ? 'pending' : 'retired', ends_on: endsOn });
  }

  // Change your mind during the cooling-off.
  keep(id, { today }, now = Date.now()) {
    const h = this.habit(id);
    if (!h) return err(404, 'No such habit.');
    if (!Store.plausibleToday(today, now)) return err(400, 'Bad date.');
    if (!h.ends_on || h.ends_on <= today) return err(400, 'Too late: that habit has already retired.');
    this.sql.exec('UPDATE habits SET ends_on = NULL WHERE id = ?', id);
    return ok();
  }

  // Login rate limit: LOCK_FAILS failures in LOCK_WINDOW_MS locks logins until the oldest one ages out.
  loginLockedFor(now = Date.now()) {
    this.sql.exec('DELETE FROM login_failures WHERE at < ?', now - LOCK_WINDOW_MS);
    const rows = this.rows('SELECT at FROM login_failures ORDER BY at');
    if (rows.length < LOCK_FAILS) return 0;
    return rows[rows.length - LOCK_FAILS].at + LOCK_WINDOW_MS - now;
  }
  loginFailed(now = Date.now()) { this.sql.exec('INSERT INTO login_failures (at) VALUES (?)', now); }
  loginSucceeded() { this.sql.exec('DELETE FROM login_failures'); }
}
