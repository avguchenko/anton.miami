// Pure date and scoring helpers, shared by the page (app.js) and the Worker.
// Every day is a local calendar date written 'YYYY-MM-DD'; the browser decides
// what "today" is, so a day always means the day on the person's own clock.

const DAY_MS = 86400000;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isDay(s) {
  if (typeof s !== 'string' || !DAY_RE.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export function localDay(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

const toUTC = (day) => Date.UTC(+day.slice(0, 4), +day.slice(5, 7) - 1, +day.slice(8, 10));
const fromUTC = (ms) => new Date(ms).toISOString().slice(0, 10);

export const addDays = (day, n) => fromUTC(toUTC(day) + n * DAY_MS);
export const daysBetween = (a, b) => Math.round((toUTC(b) - toUTC(a)) / DAY_MS); // b - a
export const weekday = (day) => (new Date(toUTC(day)).getUTCDay() + 6) % 7; // Mon=0 … Sun=6
export const startOfWeek = (day) => addDays(day, -weekday(day));
export const startOfMonth = (day) => day.slice(0, 8) + '01';
export const startOfYear = (day) => day.slice(0, 5) + '01-01';
export const daysInMonth = (day) => new Date(Date.UTC(+day.slice(0, 4), +day.slice(5, 7), 0)).getUTCDate();
export const endOfMonth = (day) => day.slice(0, 8) + String(daysInMonth(day)).padStart(2, '0');
export const endOfYear = (day) => day.slice(0, 5) + '12-31';
export function addMonths(day, n) {
  const y = +day.slice(0, 4), m = +day.slice(5, 7) - 1 + n;
  const d = new Date(Date.UTC(y, m, 1));
  return d.toISOString().slice(0, 10);
}

// A habit counts on `day` from its start date until (not including) ends_on.
export const isActive = (h, day) => h.start_on <= day && (!h.ends_on || day < h.ends_on);

// How hard removing a habit is, by how much work went into it.
//  free:    never checked off; it goes at once and leaves no trace.
//  confirm: a little history; type its name to retire it.
//  hard:    real history; type its name, hold the button (longer the more work),
//           and it stays on the list through tomorrow before it retires,
//           so there is a full day to change your mind.
export function removalPolicy(checks) {
  if (checks <= 0) return { tier: 'free', typeName: false, holdSeconds: 0, coolingDays: 0 };
  if (checks <= 20) return { tier: 'confirm', typeName: true, holdSeconds: 0, coolingDays: 0 };
  return { tier: 'hard', typeName: true, holdSeconds: Math.min(30, 5 + Math.floor(checks / 20)), coolingDays: 2 };
}

export const sameName = (a, b) => String(a).trim().toLowerCase() === String(b).trim().toLowerCase();

// Scoring over a state snapshot: { habits: [...], checks: [[habitId, day], ...] }.
export class Scorer {
  constructor(state) {
    this.habits = state.habits;
    this.done = new Set(state.checks.map(([id, day]) => `${id}|${day}`));
    this.byHabit = new Map();
    for (const [id, day] of state.checks) {
      if (!this.byHabit.has(id)) this.byHabit.set(id, []);
      this.byHabit.get(id).push(day);
    }
    for (const days of this.byHabit.values()) days.sort();
    this.cache = new Map();
  }

  has(id, day) { return this.done.has(`${id}|${day}`); }

  day(day) {
    let s = this.cache.get(day);
    if (s) return s;
    s = { done: 0, possible: 0 };
    for (const h of this.habits) {
      if (!isActive(h, day)) continue;
      s.possible++;
      if (this.has(h.id, day)) s.done++;
    }
    this.cache.set(day, s);
    return s;
  }

  // Sum over [from, to], clipped to `upTo` (days that haven't happened yet don't count).
  range(from, to, upTo = to) {
    const end = to < upTo ? to : upTo;
    const out = { done: 0, possible: 0, perfect: 0, days: 0 };
    for (let d = from; d <= end; d = addDays(d, 1)) {
      const s = this.day(d);
      out.done += s.done; out.possible += s.possible;
      if (s.possible) { out.days++; if (s.done === s.possible) out.perfect++; }
    }
    return out;
  }

  count(id) { return (this.byHabit.get(id) || []).length; }

  // Consecutive checked days ending today, or ending yesterday if today isn't done yet.
  streak(id, today) {
    let d = this.has(id, today) ? today : addDays(today, -1);
    let n = 0;
    while (this.has(id, d)) { n++; d = addDays(d, -1); }
    return n;
  }

  longestStreak(id) {
    let best = 0, run = 0, prev = null;
    for (const d of this.byHabit.get(id) || []) {
      run = prev && daysBetween(prev, d) === 1 ? run + 1 : 1;
      if (run > best) best = run;
      prev = d;
    }
    return best;
  }

  firstCheck(id) { return (this.byHabit.get(id) || [])[0] || null; }
}

export const pct = (s) => (s.possible ? Math.round((100 * s.done) / s.possible) : null);
