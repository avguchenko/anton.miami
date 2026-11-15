/* anton.miami A/B tracking
 *
 * Loaded by both front pages. Sends everything to PostHog through the
 * first-party /ingest proxy, tagged with the variant so every metric can be
 * broken down by "variant". Both pages draw on one big canvas, so
 * DOM click heatmaps alone can't tell much. This script adds behavioural
 * events (pointer travel, drags, taps, keys, attention time, a coarse
 * position grid) that work on any canvas page.
 *
 * Debug: add ?ab_debug=1 to the URL to log every event to the console.
 */
(function () {
  'use strict';

  // ---- configuration --------------------------------------------------------
  var POSTHOG_KEY = 'phc_ybcUDErwHCceLdNViW4esrhSzpc8boezDKtQsRedDa64';
  var POSTHOG_UI = 'https://us.posthog.com';   // use https://eu.posthog.com for an EU project
  var RECORD_CANVAS = true;   // session replay shows the canvas itself (low fps); false = cursor over blank
  var CANVAS_FPS = 2;
  var ENGAGED_MILESTONES = [10, 30, 60, 120, 300]; // seconds of visible time
  var ATTENTIVE_WINDOW_MS = 15000; // visible AND input within the last 15 s counts as attentive
  var GRID_COLS = 12, GRID_ROWS = 8; // coarse heat grid of where the pointer spends time

  // ---- context --------------------------------------------------------------
  function meta(name) { var m = document.querySelector('meta[name="' + name + '"]'); return m ? m.content : null; }
  function readCookie(n) { var m = document.cookie.match('(?:^|; )' + n + '=([^;]*)'); return m ? decodeURIComponent(m[1]) : null; }

  var variant = meta('ab-variant') || 'unknown';
  var experiment = meta('ab-experiment');
  var assignment = meta('ab-assignment'); // new | returning | forced | null (direct visit)
  var preview = assignment === 'forced' || location.pathname !== '/';
  var debug = /[?&]ab_debug=1\b/.test(location.search);
  var keyless = POSTHOG_KEY.indexOf('REPLACE') !== -1;
  // Exclude your own browsers: visit /?ab_optout=1 once (undo with ?ab_optout=0).
  try {
    var oo = new URLSearchParams(location.search).get('ab_optout');
    if (oo === '1') localStorage.setItem('ab_optout', '1');
    if (oo === '0') localStorage.removeItem('ab_optout');
  } catch (e) {}
  var selfOptOut = false;
  try { selfOptOut = localStorage.getItem('ab_optout') === '1'; } catch (e) {}
  var optedOut = selfOptOut || navigator.globalPrivacyControl === true || navigator.doNotTrack === '1';

  var t0 = performance.now();
  // one id per page load, so summaries from reloads / other tabs in the same session stay separate
  var pageId = (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2) + Date.now());
  var queue = [];
  function capture(event, props, beacon) {
    props = props || {};
    if (debug || keyless) console.log('[ab] ' + event + ' ' + JSON.stringify(props));
    if (optedOut || keyless) return;
    if (window.posthog && window.posthog.__loaded) {
      window.posthog.capture(event, props, beacon ? { transport: 'sendBeacon' } : undefined);
    } else {
      queue.push([event, props, beacon]);
    }
  }

  // ---- PostHog --------------------------------------------------------------
  if (!optedOut && !keyless) {
    /* official PostHog loader snippet (array.js served via /ingest proxy) */
    !function(t,e){var o,n,p,r;e.__SV||(window.posthog=e,e._i=[],e.init=function(i,s,a){function g(t,e){var o=e.split(".");2==o.length&&(t=t[o[0]],e=o[1]),t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}}(p=t.createElement("script")).type="text/javascript",p.crossOrigin="anonymous",p.async=!0,p.src=s.api_host.replace(".i.posthog.com","-assets.i.posthog.com")+"/static/array.js",(r=t.getElementsByTagName("script")[0]).parentNode.insertBefore(p,r);var u=e;for(void 0!==a?u=e[a]=[]:a="posthog",u.people=u.people||[],u.toString=function(t){var e="posthog";return"posthog"!==a&&(e+="."+a),t||(e+=" (stub)"),e},u.people.toString=function(){return u.toString(1)+".people (stub)"},o="init capture register register_once register_for_session unregister unregister_for_session getFeatureFlag getFeatureFlagPayload isFeatureEnabled reloadFeatureFlags updateEarlyAccessFeatureEnrollment getEarlyAccessFeatures on onFeatureFlags onSessionId getSurveys getActiveMatchingSurveys renderSurvey canRenderSurvey getNextSurveyStep identify setPersonProperties group resetGroups setPersonPropertiesForFlags resetPersonPropertiesForFlags setGroupPropertiesForFlags resetGroupPropertiesForFlags reset get_distinct_id getGroups get_session_id get_session_replay_url alias set_config startSessionRecording stopSessionRecording sessionRecordingStarted captureException loadToolbar get_property getSessionProperty createPersonProfile opt_in_capturing opt_out_capturing has_opted_in_capturing has_opted_out_capturing clear_opt_in_out_capturing debug".split(" "),n=0;n<o.length;n++)g(u,o[n]);e._i.push([i,s,a])},e.__SV=1)}(document,window.posthog||[]);

    var vid = readCookie('am_vid');
    window.posthog.init(POSTHOG_KEY, {
      api_host: location.origin + '/ingest',
      ui_host: POSTHOG_UI,
      person_profiles: 'identified_only',
      bootstrap: vid ? { distinctID: vid } : undefined,
      capture_pageview: true,
      capture_pageleave: true,
      autocapture: true,
      enable_heatmaps: true,          // PostHog heatmaps: clicks, rage clicks, mouse movement
      respect_dnt: true,
      session_recording: {
        captureCanvas: { recordCanvas: RECORD_CANVAS, canvasFps: CANVAS_FPS, canvasQuality: '0.35' },
      },
      loaded: function (ph) {
        ph.register({ variant: variant, ab_experiment: experiment, ab_assignment: assignment, ab_preview: preview, page_id: pageId });
        if (debug) ph.debug(true);
        while (queue.length) { var q = queue.shift(); ph.capture(q[0], q[1], q[2] ? { transport: 'sendBeacon' } : undefined); }
      },
    });
    // register immediately too, so events queued in the stub carry the variant
    window.posthog.register({ variant: variant, ab_experiment: experiment, ab_assignment: assignment, ab_preview: preview, page_id: pageId });
  }

  // ---- exposure -------------------------------------------------------------
  function utm() {
    var o = {}, p = new URLSearchParams(location.search);
    ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content'].forEach(function (k) { if (p.get(k)) o[k] = p.get(k); });
    return o;
  }
  var refDomain = '';
  try { refDomain = document.referrer ? new URL(document.referrer).hostname : ''; } catch (e) {}
  var fine = matchMedia('(pointer: fine)').matches;

  capture('ab_exposure', Object.assign({
    variant: variant,
    ab_experiment: experiment,
    ab_assignment: assignment,
    ab_preview: preview,
    viewport_w: innerWidth,
    viewport_h: innerHeight,
    dpr: devicePixelRatio || 1,
    input_class: fine ? 'mouse' : 'touch',
    reduced_motion: matchMedia('(prefers-reduced-motion: reduce)').matches,
    cpu_cores: navigator.hardwareConcurrency || null,
    device_memory_gb: navigator.deviceMemory || null,
    connection: (navigator.connection && navigator.connection.effectiveType) || null,
    in_app_browser: /FBAN|FBAV|Instagram|LinkedInApp|Twitter|Line\//i.test(navigator.userAgent),
    referrer_domain: refDomain,
  }, utm()));

  // ---- performance: load time and frame rate --------------------------------
  // The two designs differ a lot in weight and rendering cost, so slow loads or
  // low frame rates could explain engagement differences on their own. Measured
  // here so the analysis can control for them.
  var perf = { fps: null, fpsMin: null, longFrames: 0 };
  (function measureFps() {
    var frames = 0, start = null, last = null, worst = 0, windowStart = null, windowFrames = 0, minFps = Infinity;
    function step(t) {
      if (document.hidden) { start = null; requestAnimationFrame(step); return; }
      if (start === null) { start = last = windowStart = t; requestAnimationFrame(step); return; }
      frames++; windowFrames++;
      var dt = t - last; last = t;
      if (dt > 50) perf.longFrames++;            // a visible stutter (< 20 fps for that frame)
      worst = Math.max(worst, dt);
      if (t - windowStart >= 1000) { minFps = Math.min(minFps, windowFrames * 1000 / (t - windowStart)); windowStart = t; windowFrames = 0; }
      if (t - start < 6000) { requestAnimationFrame(step); return; }
      perf.fps = Math.round(frames * 1000 / (t - start));
      perf.fpsMin = Math.round(minFps);
      var nav = performance.getEntriesByType && performance.getEntriesByType('navigation')[0];
      capture('perf', {
        fps: perf.fps,                          // average over the first 6 visible seconds
        fps_min_1s: perf.fpsMin,                // worst one-second window
        long_frames: perf.longFrames,
        worst_frame_ms: Math.round(worst),
        load_ms: nav ? Math.round(nav.loadEventEnd || nav.domContentLoadedEventEnd) : null,
        dom_ready_ms: nav ? Math.round(nav.domContentLoadedEventEnd) : null,
        transfer_kb: nav && nav.transferSize ? Math.round(nav.transferSize / 1024) : null,
      });
    }
    requestAnimationFrame(step);
  })();

  // ---- behaviour accumulators ----------------------------------------------
  var s = {
    moves: 0, distancePx: 0, downs: 0, taps: 0, drags: 0, wheel: 0,
    keys: 0, distinctKeys: {}, uiClicks: 0, pastes: 0,
    firstInputAt: null, lastInputAt: null, maxIdleMs: 0,
    visibleMs: 0, attentiveMs: 0, visibleSince: document.hidden ? null : performance.now(),
    grid: new Array(GRID_COLS * GRID_ROWS).fill(0), lastX: null, lastY: null, lastMoveT: null,
    pointerTypes: {},
  };
  var milestonesHit = {};
  var down = null;

  function onInput(kind) {
    var now = performance.now();
    if (s.firstInputAt === null) {
      s.firstInputAt = now;
      capture('first_interaction', { kind: kind, ms_to_first: Math.round(now - t0) });
    }
    if (s.lastInputAt !== null) s.maxIdleMs = Math.max(s.maxIdleMs, now - s.lastInputAt);
    s.lastInputAt = now;
  }

  function gridAdd(x, y, ms) {
    var c = Math.min(GRID_COLS - 1, Math.max(0, Math.floor(x / innerWidth * GRID_COLS)));
    var r = Math.min(GRID_ROWS - 1, Math.max(0, Math.floor(y / innerHeight * GRID_ROWS)));
    s.grid[r * GRID_COLS + c] += ms;
  }

  addEventListener('pointermove', function (e) {
    if (!e.isPrimary) return;
    var now = performance.now();
    s.moves++;
    s.pointerTypes[e.pointerType] = 1;
    if (s.lastX !== null) {
      s.distancePx += Math.hypot(e.clientX - s.lastX, e.clientY - s.lastY);
      // time-weighted: credit the cell the pointer was resting in (capped so idle hovering doesn't dominate)
      gridAdd(s.lastX, s.lastY, Math.min(now - s.lastMoveT, 2000));
    }
    if (down) down.moved += Math.hypot(e.clientX - down.x, e.clientY - down.y), down.x = e.clientX, down.y = e.clientY;
    s.lastX = e.clientX; s.lastY = e.clientY; s.lastMoveT = now;
    onInput('move');
  }, { passive: true, capture: true });

  addEventListener('pointerdown', function (e) {
    if (!e.isPrimary) return;
    s.downs++;
    s.pointerTypes[e.pointerType] = 1;
    gridAdd(e.clientX, e.clientY, 500); // touch has no hover, so presses mark the grid too
    down ={ x: e.clientX, y: e.clientY, moved: 0, t: performance.now(), onUi: !!(e.target.closest && e.target.closest('a,button')) };
    onInput('down');
  }, { passive: true, capture: true });

  function endPress(e) {
    if (!down || (e && !e.isPrimary)) return;
    if (!down.onUi) {
      if (down.moved > 12) s.drags++;
      else if (performance.now() - down.t < 450) s.taps++;
    }
    down = null;
  }
  addEventListener('pointerup', endPress, { passive: true, capture: true });
  addEventListener('pointercancel', function () { down = null; }, { passive: true, capture: true });

  addEventListener('wheel', function () { s.wheel++; onInput('wheel'); }, { passive: true, capture: true });

  addEventListener('keydown', function (e) {
    if (e.repeat || e.metaKey || e.ctrlKey) return;
    var k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    s.keys++;
    if (!s.distinctKeys[k]) {
      s.distinctKeys[k] = 1;
      capture('key_used', { key: k });
    }
    onInput('key');
  }, { capture: true });

  addEventListener('paste', function () {
    s.pastes++;
    onInput('paste');
    var before = location.hash;
    setTimeout(function () {
      capture('coords_pasted', { moved: location.hash !== before && location.hash !== '', place: location.hash.slice(1, 40) });
    }, 150);
  }, { capture: true });

  addEventListener('hashchange', function () { capture('view_changed', { hash: location.hash.slice(0, 40) }); });

  // in-page controls (buttons) and outbound links
  var exitHref = null;
  document.addEventListener('click', function (e) {
    var el = e.target.closest && e.target.closest('a,button');
    if (!el) return;
    if (el.tagName === 'BUTTON') {
      s.uiClicks++;
      capture('ui_click', { control: el.id || el.textContent.trim().slice(0, 40), label: el.textContent.trim().slice(0, 40) });
      return;
    }
    var href = el.getAttribute('href') || '';
    var dest;
    try { dest = new URL(href, location.href); } catch (err) { return; }
    var outbound = dest.origin !== location.origin || dest.protocol === 'mailto:';
    if (outbound) {
      exitHref = dest.href;
      capture('outbound_click', {
        href: dest.protocol === 'mailto:' ? 'mailto' : dest.href,
        destination: dest.protocol === 'mailto:' ? 'email' : dest.hostname,
        label: (el.dataset.track || el.textContent).trim().slice(0, 40),
        seconds_on_page: Math.round((performance.now() - t0) / 1000),
      }, true);
    }
  }, true);

  // ---- attention clock ------------------------------------------------------
  function tick() {
    var now = performance.now();
    if (s.visibleSince !== null) {
      var dt = now - s.visibleSince;
      s.visibleMs += dt;
      if (s.lastInputAt !== null && now - s.lastInputAt < ATTENTIVE_WINDOW_MS) s.attentiveMs += dt;
      s.visibleSince = now;
    }
    var sec = s.visibleMs / 1000;
    ENGAGED_MILESTONES.forEach(function (m) {
      if (sec >= m && !milestonesHit[m]) {
        milestonesHit[m] = 1;
        capture('engaged', { seconds: m, interacted: s.firstInputAt !== null });
      }
    });
  }
  setInterval(tick, 1000);

  // ---- summary on leave -----------------------------------------------------
  var seq = 0, sentForThisHide = false;
  function summary(reason) {
    tick();
    if (sentForThisHide) return;
    sentForThisHide = true;
    seq++;
    var diag = Math.hypot(innerWidth, innerHeight) || 1;
    var totalGrid = s.grid.reduce(function (a, b) { return a + b; }, 0) || 1;
    var nowS = performance.now();
    var idleTail = nowS - (s.lastInputAt === null ? t0 : s.lastInputAt); // the idle stretch still running at exit
    capture('page_summary', {
      page_id: pageId,               // dedupe: last seq per page_id, then roll up to sessions/visitors
      seq: seq,                      // a visitor who tabs away and back sends several; use the last per session
      reason: reason,                // hidden | pagehide
      exit: exitHref ? 'outbound' : 'left',
      exit_href: exitHref,
      total_s: Math.round((performance.now() - t0) / 1000),
      visible_s: Math.round(s.visibleMs / 1000),
      attentive_s: Math.round(s.attentiveMs / 1000),
      interacted: s.firstInputAt !== null,
      ms_to_first_input: s.firstInputAt === null ? null : Math.round(s.firstInputAt - t0),
      max_idle_s: Math.round(Math.max(s.maxIdleMs, idleTail) / 1000),
      pointer_moves: s.moves,
      pointer_travel_screens: +(s.distancePx / diag).toFixed(2), // distance in screen diagonals
      presses: s.downs,
      taps: s.taps,
      drags: s.drags,
      wheel: s.wheel,
      keys: s.keys,
      distinct_keys: Object.keys(s.distinctKeys).join(' '),
      ui_clicks: s.uiClicks,
      pastes: s.pastes,
      pointer_types: Object.keys(s.pointerTypes).join(' '),
      fps: perf.fps,
      // where the pointer rested: GRID_COLS x GRID_ROWS cells, row-major, % of hover time
      heat_grid: s.grid.map(function (v) { return Math.round(v / totalGrid * 1000) / 10; }),
      heat_grid_shape: GRID_COLS + 'x' + GRID_ROWS,
    }, true);
  }
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) {
      summary('hidden');
      s.visibleSince = null;
    } else {
      s.visibleSince = performance.now();
      sentForThisHide = false;
    }
  });
  addEventListener('pagehide', function () { summary('pagehide'); });
})();
