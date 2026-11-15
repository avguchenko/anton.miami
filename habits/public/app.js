import {
  localDay, addDays, daysBetween, weekday, startOfWeek, startOfMonth, startOfYear, endOfMonth,
  endOfYear, daysInMonth, addMonths, isActive, removalPolicy, sameName, Scorer, pct,
} from './logic.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const asDate = (day) => new Date(day + 'T12:00:00');
const fmt = (opts) => { const f = new Intl.DateTimeFormat(undefined, opts); return (day) => f.format(asDate(day)); };
const fmtShort = fmt({ month: 'short', day: 'numeric' });
const fmtLong = fmt({ weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
const fmtWeekdayShort = fmt({ weekday: 'short', month: 'short', day: 'numeric' });
const fmtMonth = fmt({ month: 'long', year: 'numeric' });
const fmtMonthShort = fmt({ month: 'short' });
const fmtMonthName = fmt({ month: 'long' });
const fmtFull = fmt({ month: 'short', day: 'numeric', year: 'numeric' });
const WEEKDAY_LETTERS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];

let data = null;          // { habits, checks }
let scorer = null;
let today = localDay();
let viewMonth = startOfMonth(today);
let editing = false;
let pastUnlocked = false;
let scrollToToday = true;

// ---------------------------------------------------------------- network
class SignedOut extends Error {}
async function api(method, path, body) {
  const res = await fetch('/api/' + path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  let out = {};
  try { out = await res.json(); } catch { /* empty */ }
  if (res.status === 401 && path !== 'login') { showLogin(); throw new SignedOut(); }
  if (!res.ok) throw new Error(out.error || `Something went wrong (${res.status}).`);
  return out;
}

async function load() {
  data = await api('GET', 'state');
  scorer = new Scorer(data);
  showApp();
  render();
}

function fail(e) { if (!(e instanceof SignedOut)) toast(e.message || String(e)); }

// ---------------------------------------------------------------- views
function showLogin() {
  $('app').hidden = true;
  $('login').hidden = false;
  $('password').focus();
}
function showApp() {
  $('login').hidden = true;
  $('app').hidden = false;
}

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('login-error').textContent = '';
  try {
    await api('POST', 'login', { password: $('password').value });
    $('password').value = '';
    await load();
  } catch (err) { $('login-error').textContent = err.message; }
});

$('logout').addEventListener('click', async () => {
  try { await api('POST', 'logout', {}); } catch { /* ignore */ }
  data = null;
  showLogin();
});

$('toggle-edit').addEventListener('click', () => {
  editing = !editing;
  $('toggle-edit').setAttribute('aria-pressed', editing);
  $('toggle-edit').textContent = editing ? 'Done editing' : 'Edit habits';
  renderGrid();
});
$('toggle-past').addEventListener('click', () => {
  pastUnlocked = !pastUnlocked;
  $('toggle-past').setAttribute('aria-pressed', pastUnlocked);
  $('toggle-past').textContent = pastUnlocked ? 'Lock past days' : 'Unlock past days';
  renderGrid();
});
$('prev-month').addEventListener('click', () => { viewMonth = addMonths(viewMonth, -1); scrollToToday = true; renderGrid(); });
$('next-month').addEventListener('click', () => { viewMonth = addMonths(viewMonth, 1); scrollToToday = true; renderGrid(); });
$('this-month').addEventListener('click', () => { viewMonth = startOfMonth(today); scrollToToday = true; renderGrid(); });

function render() {
  $('today-label').textContent = fmtLong(today);
  renderTiles();
  renderGrid();
  renderRetired();
}

// ---------------------------------------------------------------- tiles
function pctText(s) { const p = pct(s); return p === null ? '–' : p + '%'; }

// Bars anchored to a baseline, top corners rounded. items: [{ value: 0..100|null, tip, label? }]
function barChart(items, current) {
  const W = 300, H = 64, gap = 4, n = items.length;
  const bw = (W - gap * (n - 1)) / n;
  let svg = `<svg viewBox="0 -2 ${W} ${H + 18}" role="img" aria-hidden="true">`;
  items.forEach((it, i) => {
    const x = i * (bw + gap);
    const h = it.value === null ? 0 : Math.max(it.value > 0 ? 3 : 0, (it.value / 100) * H);
    const y = H - h, r = Math.min(3, bw / 2, h);
    svg += `<rect class="bar-hit" x="${x - gap / 2}" y="0" width="${bw + gap}" height="${H}" data-tip="${esc(it.tip)}" tabindex="-1"/>`;
    svg += h > 0
      ? `<path class="bar${i === current ? ' current' : ''}" d="M${x},${H} V${y + r} Q${x},${y} ${x + r},${y} H${x + bw - r} Q${x + bw},${y} ${x + bw},${y + r} V${H} Z"/>`
      : '<g></g>';
    if (it.label) svg += `<text class="axis" x="${x + bw / 2}" y="${H + 14}" text-anchor="middle">${esc(it.label)}</text>`;
  });
  svg += `<line class="baseline" x1="0" x2="${W}" y1="${H + 0.5}" y2="${H + 0.5}"/></svg>`;
  return svg;
}

function tile(el, { label, stats, sub, chart, caption }) {
  const p = pct(stats);
  el.innerHTML = `
    <p class="label">${esc(label)}</p>
    <div class="row"><span class="value${p === null ? ' none' : ''}">${pctText(stats)}</span><span class="sub">${sub}</span></div>
    <div class="meter" role="img" aria-label="${p ?? 0}% complete"><i style="width:${p ?? 0}%"></i></div>
    ${chart}
    ${caption ? `<div class="caption">${caption}</div>` : ''}`;
}

const doneOf = (s) => s.possible ? `${s.done} of ${s.possible} done` : 'nothing to do yet';

function renderTiles() {
  // Today + the last 14 days
  const dayItems = [];
  for (let i = 13; i >= 0; i--) {
    const d = addDays(today, -i), s = scorer.day(d);
    dayItems.push({
      value: pct(s), tip: `${fmtWeekdayShort(d)}: ${s.possible ? `${pct(s)}% (${s.done}/${s.possible})` : 'no habits yet'}`,
      label: i === 13 ? fmtShort(d) : i === 0 ? 'today' : '',
    });
  }
  const sDay = scorer.day(today);
  const left = sDay.possible - sDay.done;
  tile($('tile-day'), {
    label: 'Today', stats: sDay,
    sub: sDay.possible ? `${sDay.done} of ${sDay.possible} done${left ? ` · ${left} to go` : ' · perfect day'}` : 'add a habit below',
    chart: barChart(dayItems, 13),
  });

  // This week + the last 12 weeks
  const wk = startOfWeek(today);
  const weekItems = [];
  for (let i = 11; i >= 0; i--) {
    const from = addDays(wk, -7 * i), s = scorer.range(from, addDays(from, 6), today);
    weekItems.push({
      value: pct(s), tip: `Week of ${fmtShort(from)}: ${s.possible ? `${pct(s)}% (${s.done}/${s.possible})` : 'no habits yet'}`,
      label: i === 11 ? fmtShort(from) : i === 0 ? 'this wk' : '',
    });
  }
  const sWeek = scorer.range(wk, addDays(wk, 6), today);
  tile($('tile-week'), {
    label: `This week · since ${fmtWeekdayShort(wk).split(',')[0]} ${fmtShort(wk)}`, stats: sWeek,
    sub: doneOf(sWeek), chart: barChart(weekItems, 11),
  });

  // This month + the last 12 months
  const mo = startOfMonth(today);
  const monthItems = [];
  for (let i = 11; i >= 0; i--) {
    const from = addMonths(mo, -i), s = scorer.range(from, endOfMonth(from), today);
    monthItems.push({
      value: pct(s), tip: `${fmtMonth(from)}: ${s.possible ? `${pct(s)}% (${s.done}/${s.possible})` : 'no habits yet'}`,
      label: fmtMonthShort(from).slice(0, 1),
    });
  }
  const sMonth = scorer.range(mo, endOfMonth(mo), today);
  tile($('tile-month'), {
    label: fmtMonthName(today), stats: sMonth,
    sub: `${doneOf(sMonth)}${sMonth.days ? ` · ${sMonth.perfect} perfect day${sMonth.perfect === 1 ? '' : 's'}` : ''}`,
    chart: barChart(monthItems, 11),
  });

  // This year: a heatmap of every day
  const yr = startOfYear(today);
  const sYear = scorer.range(yr, endOfYear(today), today);
  const el = $('tile-year');
  tile(el, {
    label: today.slice(0, 4), stats: sYear,
    sub: `${doneOf(sYear)}${sYear.days ? ` · ${sYear.perfect} perfect day${sYear.perfect === 1 ? '' : 's'}` : ''}`,
    chart: `<div class="heat">${heatmap(yr)}</div>`,
    caption: `<div class="year-foot"><span>Each square is a day; darker means more of that day's habits were done.</span>
      <span class="legend">Less ${[0, 1, 2, 3, 4, 5].map(q => `<i style="background:var(--q${q})"></i>`).join('')} More</span></div>`,
  });
  const heat = el.querySelector('.heat');
  const now = heat.querySelector('.hc.today');
  if (now) heat.scrollLeft = Math.max(0, now.getBoundingClientRect().left - heat.getBoundingClientRect().left - heat.clientWidth + 60);
}

function bucket(p) { return p === 0 ? 0 : p < 25 ? 1 : p < 50 ? 2 : p < 75 ? 3 : p < 100 ? 4 : 5; }

function heatmap(yr) {
  const end = endOfYear(yr), first = startOfWeek(yr);
  const weeks = Math.ceil((daysBetween(first, end) + 1) / 7);
  const C = 11, G = 3, L = 26, T = 16;
  const W = L + weeks * (C + G), H = T + 7 * (C + G);
  let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Daily completion for ${yr.slice(0, 4)}">`;
  ['Mon', '', 'Wed', '', 'Fri', '', ''].forEach((t, r) => {
    if (t) svg += `<text class="axis" x="0" y="${T + r * (C + G) + C - 1}">${t}</text>`;
  });
  for (let m = 0; m < 12; m++) {
    const d = addMonths(yr, m), col = Math.floor(daysBetween(first, d) / 7);
    svg += `<text class="axis" x="${L + col * (C + G)}" y="10">${esc(fmtMonthShort(d))}</text>`;
  }
  for (let d = yr; d <= end; d = addDays(d, 1)) {
    const k = daysBetween(first, d), col = Math.floor(k / 7), row = k % 7;
    const x = L + col * (C + G), y = T + row * (C + G);
    if (d > today) {
      svg += `<rect class="hc" x="${x + .5}" y="${y + .5}" width="${C - 1}" height="${C - 1}" fill="none" stroke="var(--q0)"/>`;
      continue;
    }
    const s = scorer.day(d), p = pct(s);
    const tip = `${fmtWeekdayShort(d)}: ${p === null ? 'no habits yet' : `${p}% (${s.done}/${s.possible})`}`;
    const fill = p === null ? 'var(--q0)' : `var(--q${bucket(p)})`;
    svg += `<rect class="hc${d === today ? ' today' : ''}" x="${x}" y="${y}" width="${C}" height="${C}" fill="${fill}"${p === null ? ' opacity=".5"' : ''} data-tip="${esc(tip)}"/>`;
  }
  return svg + '</svg>';
}

// ---------------------------------------------------------------- grid
function visibleHabits(from, to) {
  return data.habits.filter(h => h.start_on <= to && (!h.ends_on || h.ends_on > from));
}

function renderGrid() {
  const from = viewMonth, n = daysInMonth(viewMonth), to = endOfMonth(viewMonth);
  const yesterday = addDays(today, -1);
  $('month-label').textContent = fmtMonth(viewMonth);
  $('next-month').disabled = viewMonth >= startOfMonth(today);
  $('this-month').hidden = viewMonth === startOfMonth(today);
  $('grid').classList.toggle('editing', editing);

  const habits = visibleHabits(from, to > today ? today : to);
  const days = Array.from({ length: n }, (_, i) => addDays(from, i));

  let head = '<thead><tr><th class="name">Habit</th>';
  for (const d of days) {
    const wd = weekday(d);
    head += `<th class="${d === today ? 'today' : ''}${wd >= 5 ? ' weekend' : ''}">${WEEKDAY_LETTERS[wd]}<b>${+d.slice(8)}</b></th>`;
  }
  head += '<th class="stat first" title="Current streak in days">Streak</th><th class="stat" title="Share done this month">Month</th></tr></thead>';

  let body = '<tbody>';
  habits.forEach((h, idx) => {
    const leaving = h.ends_on && h.ends_on > today;
    const retired = h.ends_on && h.ends_on <= today;
    let row = `<tr data-id="${h.id}"><th class="name" scope="row"><div class="name-inner">
      <span class="name-text" title="${esc(h.name)}">${esc(h.name)}</span>`;
    if (leaving) {
      row += `<span class="leaving" title="Retires after ${fmtShort(addDays(h.ends_on, -1))}"><span class="lv">leaving</span><button data-act="keep" data-id="${h.id}">Keep</button></span>`;
    }
    if (!retired && !leaving) {
      row += `<span class="tools">
        <button data-act="up" data-id="${h.id}" aria-label="Move up" ${idx === 0 ? 'disabled' : ''}>↑</button>
        <button data-act="down" data-id="${h.id}" aria-label="Move down">↓</button>
        <button data-act="rename" data-id="${h.id}" aria-label="Rename">✎</button>
        <button class="rm" data-act="remove" data-id="${h.id}" aria-label="Remove">✕</button></span>`;
    }
    row += '</div></th>';
    for (const d of days) {
      let cls = 'cell', attrs = '', label;
      const done = scorer.has(h.id, d);
      if (d > today) { cls += ' future'; attrs = 'disabled'; label = 'upcoming'; }
      else if (!isActive(h, d)) { cls += ' na'; attrs = 'disabled'; label = 'not on the list'; }
      else {
        if (done) cls += ' done';
        if (d === today) cls += ' today';
        if (d < yesterday && !pastUnlocked) cls += ' locked';
        label = done ? 'done' : 'not done';
        attrs = `aria-pressed="${done}"`;
      }
      row += `<td class="c${d === today ? ' today-col' : ''}"><button class="${cls}" data-h="${h.id}" data-d="${d}" ${attrs} aria-label="${esc(h.name)}, ${fmtShort(d)}: ${label}"></button></td>`;
    }
    const own = { done: 0, possible: 0 };
    for (const d of days) if (d <= today && isActive(h, d)) { own.possible++; if (scorer.has(h.id, d)) own.done++; }
    const streak = viewMonth === startOfMonth(today) && !retired ? scorer.streak(h.id, today) : null;
    row += `<td class="stat first">${streak === null ? '' : streak ? `${streak}d` : '–'}</td><td class="stat">${pctText(own)}</td></tr>`;
    body += row;
  });
  body += '</tbody>';

  let foot = '';
  if (habits.length) {
    foot = '<tfoot><tr><th class="name">Done each day</th>';
    for (const d of days) {
      const s = scorer.day(d), p = pct(s);
      foot += `<td class="c${d === today ? ' today-col' : ''}">${d <= today && p !== null
        ? `<span class="daybar${p === 100 ? ' perfect' : ''}" data-tip="${esc(`${fmtWeekdayShort(d)}: ${p}% (${s.done}/${s.possible})`)}"><i style="height:${p}%"></i></span>` : ''}</td>`;
    }
    const sm = scorer.range(from, to, today);
    foot += `<td class="stat first"></td><td class="stat"><b>${pctText(sm)}</b></td></tr></tfoot>`;
  }

  $('grid').innerHTML = head + body + foot;
  $('empty').hidden = data.habits.some(h => !h.ends_on || h.ends_on > today);

  if (scrollToToday) {
    scrollToToday = false;
    const wrap = $('grid-scroll');
    const cell = wrap.querySelector('th.today');
    wrap.scrollLeft = cell ? Math.max(0, cell.offsetLeft - wrap.clientWidth + 160) : 0;
  }
}

function renderRetired() {
  const list = data.habits.filter(h => h.ends_on && h.ends_on <= today);
  const el = $('retired');
  el.hidden = !list.length;
  if (!list.length) return;
  el.querySelector('summary').textContent = `Retired habits (${list.length})`;
  el.querySelector('ul').innerHTML = list.map(h => {
    const n = scorer.count(h.id);
    return `<li>${esc(h.name)}: ${n} check-off${n === 1 ? '' : 's'}, ${fmtFull(h.start_on)} – ${fmtFull(addDays(h.ends_on, -1))}</li>`;
  }).join('');
}

// ---------------------------------------------------------------- grid interactions
$('grid').addEventListener('click', async (e) => {
  const cell = e.target.closest('button.cell');
  if (cell) return toggle(cell);
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const id = +btn.dataset.id;
  const h = data.habits.find(x => x.id === id);
  try {
    switch (btn.dataset.act) {
      case 'up': case 'down':
        await api('PATCH', `habits/${id}`, { dir: btn.dataset.act === 'up' ? -1 : 1 });
        return reload();
      case 'rename': return startRename(btn.closest('th'), h);
      case 'remove': return openRemove(h);
      case 'keep':
        await api('POST', `habits/${id}/keep`, { today });
        toast(`Kept “${h.name}”.`);
        return reload();
    }
  } catch (err) { fail(err); }
});

async function toggle(cell) {
  if (cell.disabled) return;
  if (cell.classList.contains('locked')) {
    toast('Days before yesterday are locked. Use “Unlock past days” to change them.');
    return;
  }
  const id = +cell.dataset.h, day = cell.dataset.d;
  const done = !scorer.has(id, day);
  apply(id, day, done);
  try {
    await api('POST', `habits/${id}/check`, { day, done });
  } catch (err) {
    apply(id, day, !done);
    fail(err);
  }
}

function apply(id, day, done) {
  if (done) data.checks.push([id, day]);
  else data.checks = data.checks.filter(([h, d]) => !(h === id && d === day));
  scorer = new Scorer(data);
  renderTiles();
  renderGrid();
}

function startRename(th, h) {
  const inner = th.querySelector('.name-inner');
  inner.innerHTML = `<input value="${esc(h.name)}" maxlength="80" aria-label="Rename habit">`;
  const input = inner.querySelector('input');
  input.focus(); input.select();
  let done = false;
  const finish = async (save) => {
    if (done) return; done = true;
    const name = input.value.trim();
    if (save && name && name !== h.name) {
      try { await api('PATCH', `habits/${h.id}`, { name }); } catch (err) { fail(err); }
      return reload();
    }
    renderGrid();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') finish(true);
    if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
}

$('add-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('add-name').value.trim();
  if (!name) return;
  try {
    await api('POST', 'habits', { name, today });
    $('add-name').value = '';
    viewMonth = startOfMonth(today);
    await reload();
  } catch (err) { fail(err); }
});

async function reload() {
  try {
    data = await api('GET', 'state');
    scorer = new Scorer(data);
    render();
  } catch (err) { fail(err); }
}

// ---------------------------------------------------------------- removal (harder the more work it has)
let holdTimer = null;
function openRemove(h) {
  const n = scorer.count(h.id);
  const policy = removalPolicy(n);
  const dlg = $('remove-dialog');
  const go = $('rm-go');
  $('rm-error').textContent = '';
  $('rm-type').value = '';
  $('rm-title').textContent = policy.tier === 'free' ? `Remove “${h.name}”?` : `Retire “${h.name}”?`;
  const since = scorer.firstCheck(h.id);
  const facts = `<div class="facts">
      <div><b>${n}</b><span>check-off${n === 1 ? '' : 's'}</span></div>
      <div><b>${scorer.streak(h.id, today)}</b><span>day streak now</span></div>
      <div><b>${scorer.longestStreak(h.id)}</b><span>best streak</span></div></div>`;
  if (policy.tier === 'free') {
    $('rm-body').innerHTML = '<p>It has no check-offs yet, so it will be deleted outright.</p>';
  } else if (policy.tier === 'confirm') {
    $('rm-body').innerHTML = `${facts}<p>It leaves your list from today. Its history${since ? ` since ${fmtShort(since)}` : ''} stays in your charts.</p>`;
  } else {
    $('rm-body').innerHTML = `${facts}
      <p>You've put real work into this${since ? ` since ${fmtFull(since)}` : ''}. Retiring it has a cooling-off:
      it stays on your list through <b>tomorrow</b>, so you still owe it one more day, and you can keep it any time before then.
      Its history stays in your charts.</p>`;
  }
  $('rm-type-field').hidden = !policy.typeName;
  $('rm-type-label').textContent = `Type “${h.name}” to confirm`;

  const label = policy.tier === 'free' ? 'Remove'
    : policy.holdSeconds ? `Hold ${policy.holdSeconds}s to retire` : 'Retire habit';
  go.querySelector('.hold-text').textContent = label;
  const ready = () => !policy.typeName || sameName($('rm-type').value, h.name);
  go.disabled = !ready();
  $('rm-type').oninput = () => { go.disabled = !ready(); };

  const submit = async () => {
    try {
      const r = await api('POST', `habits/${h.id}/remove`, { confirm: $('rm-type').value, today });
      dlg.close();
      toast(r.removed === 'pending' ? `“${h.name}” leaves after tomorrow. Tap Keep to change your mind.`
        : r.removed === 'deleted' ? `Removed “${h.name}”.` : `Retired “${h.name}”.`);
      reload();
    } catch (err) { $('rm-error').textContent = err.message; }
  };

  const fill = go.querySelector('.hold-fill');
  const cancelHold = () => {
    if (holdTimer) cancelAnimationFrame(holdTimer);
    holdTimer = null;
    fill.style.width = '0';
  };
  const startHold = () => {
    if (go.disabled || holdTimer) return;
    if (!policy.holdSeconds) return submit();
    const t0 = performance.now(), ms = policy.holdSeconds * 1000;
    const step = (t) => {
      const f = Math.min(1, (t - t0) / ms);
      fill.style.width = f * 100 + '%';
      const left = Math.ceil((ms - (t - t0)) / 1000);
      go.querySelector('.hold-text').textContent = f < 1 ? `Keep holding… ${left}s` : 'Retiring…';
      if (f < 1) holdTimer = requestAnimationFrame(step);
      else { holdTimer = null; submit(); }
    };
    holdTimer = requestAnimationFrame(step);
  };
  const release = () => {
    if (!holdTimer) return;
    cancelHold();
    go.querySelector('.hold-text').textContent = label;
  };
  go.onpointerdown = (e) => { e.preventDefault(); startHold(); };
  go.onpointerup = go.onpointerleave = go.onpointercancel = release;
  go.onkeydown = (e) => { if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) { e.preventDefault(); startHold(); } };
  go.onkeyup = (e) => { if (e.key === ' ' || e.key === 'Enter') release(); };
  go.onclick = (e) => e.preventDefault();
  dlg.onclose = cancelHold;
  dlg.showModal();
  if (policy.typeName) $('rm-type').focus();
}

// ---------------------------------------------------------------- tooltip & toast
const tip = $('tip');
function showTip(el) {
  const text = el.getAttribute('data-tip');
  if (!text) return;
  const r = el.getBoundingClientRect();
  tip.textContent = text;
  tip.hidden = false;
  const x = Math.min(Math.max(r.left + r.width / 2, tip.offsetWidth / 2 + 8), innerWidth - tip.offsetWidth / 2 - 8);
  tip.style.left = x + 'px';
  tip.style.top = Math.max(r.top, tip.offsetHeight + 12) + 'px';
}
document.addEventListener('pointerover', (e) => {
  const el = e.target.closest?.('[data-tip]');
  if (el) showTip(el); else tip.hidden = true;
});
document.addEventListener('scroll', () => { tip.hidden = true; }, true);

let toastTimer;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 3500);
}

// ---------------------------------------------------------------- keep in sync
// Pick up changes from other devices, and roll over at midnight.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && data) { today = localDay(); reload(); }
});
setInterval(() => {
  const now = localDay();
  if (now !== today && data) {
    const wasCurrent = viewMonth === startOfMonth(today);
    today = now;
    if (wasCurrent) viewMonth = startOfMonth(today);
    scrollToToday = true;
    render();
  }
}, 30000);

load().catch((e) => { if (!(e instanceof SignedOut)) { showLogin(); $('login-error').textContent = e.message; } });
