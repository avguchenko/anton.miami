"""Stress probe for a hackathon entry. Used by the reviewer, not the builder.

Usage: python3 probe.py /abs/path/entry.html --shots DIR

Runs the page offline in headless Chromium across awkward viewports and abuse
patterns, and reports what it observed. Findings are evidence for a human-style
judgement, not a pass/fail gate. Each probe is isolated so one crash does not
hide the rest.
"""
import json, os, sys, random
from playwright.sync_api import sync_playwright

path = os.path.abspath(sys.argv[1])
shots = sys.argv[sys.argv.index("--shots") + 1] if "--shots" in sys.argv else "/tmp/probe-shots"
os.makedirs(shots, exist_ok=True)
report = {"viewports": {}, "probes": {}, "dom_audit": {}}

VIEWPORTS = [
    ("small-phone", 320, 568, True),
    ("phone", 390, 844, True),
    ("phone-landscape", 844, 390, True),
    ("desktop", 1280, 800, False),
    ("ultrawide", 2560, 1080, False),
]

DOM_AUDIT_JS = """() => {
  function lum(c){const m=c.match(/[\\d.]+/g); if(!m) return null;
    const [r,g,b]=m.slice(0,3).map(v=>{v/=255; return v<=0.03928?v/12.92:Math.pow((v+0.055)/1.055,2.4)});
    return 0.2126*r+0.7152*g+0.0722*b;}
  function bgOf(el){while(el){const c=getComputedStyle(el).backgroundColor; const m=c&&c.match(/[\\d.]+/g);
    const alpha=m&&m.length>3?+m[3]:1;
    if(c && c!=='transparent' && alpha>=0.5) return c; el=el.parentElement;}
    return getComputedStyle(document.documentElement).backgroundColor||'rgb(255,255,255)';}
  const lowContrast=[], tinyText=[], smallTargets=[];
  for (const el of document.querySelectorAll('body *')) {
    const r=el.getBoundingClientRect(); if(!r.width||!r.height) continue;
    const cs=getComputedStyle(el); if(cs.visibility==='hidden'||cs.display==='none'||+cs.opacity===0) continue;
    const ownText=[...el.childNodes].some(n=>n.nodeType===3&&n.textContent.trim());
    if (ownText) {
      const fs=parseFloat(cs.fontSize); if(fs<12) tinyText.push((el.textContent.trim().slice(0,30))+' @'+fs+'px');
      const a=lum(cs.color), b=lum(bgOf(el));
      if(a!=null&&b!=null){const ratio=(Math.max(a,b)+0.05)/(Math.min(a,b)+0.05);
        const large=fs>=24||(fs>=18.66&&+cs.fontWeight>=700);
        if(ratio<(large?3:4.5)) lowContrast.push(el.textContent.trim().slice(0,30)+' ratio '+ratio.toFixed(2));}
    }
    const interactive=el.matches('button,a,input,select,textarea,[role=button],[onclick],[tabindex]');
    if(interactive&&(r.width<44||r.height<44)) smallTargets.push((el.id||el.tagName)+' '+Math.round(r.width)+'x'+Math.round(r.height));
  }
  return {lowContrast:lowContrast.slice(0,10), tinyText:tinyText.slice(0,10), smallTargets:smallTargets.slice(0,10),
          note:'Canvas-drawn text and buttons are not covered; judge those from screenshots.'};
}"""


def new_page(browser, w, h, touch):
    page = browser.new_page(viewport={"width": w, "height": h}, has_touch=touch, is_mobile=touch)
    errs = []
    page.on("pageerror", lambda e: errs.append("pageerror: " + str(e)[:200]))
    page.on("console", lambda m: errs.append("console: " + m.text[:200]) if m.type == "error" else None)

    def route(r, req=None):
        if r.request.url.startswith(("file:", "data:", "blob:")):
            r.continue_()
        else:
            errs.append("network: " + r.request.url[:120]); r.abort()
    page.route("**/*", route)
    page.goto("file://" + path, wait_until="load")
    page.wait_for_timeout(1200)
    return page, errs


def err_box(page):
    try:
        return page.evaluate("() => { const e=document.getElementById('err'); return e ? e.textContent.trim() : ''; }")
    except Exception:
        return ""


def tap(page, x, y, touch):
    if touch:
        page.touchscreen.tap(x, y)
    else:
        page.mouse.click(x, y)


def run(name, fn):
    try:
        report["probes"][name] = fn()
    except Exception as e:
        report["probes"][name] = {"probe_crashed": str(e)[:300]}


with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, args=["--no-sandbox", "--disable-gpu",
                                                     "--autoplay-policy=no-user-gesture-required",
                                                     "--enable-precise-memory-info"])

    # 1. Every viewport: first screen, then after a tap. Overflow and DOM audit.
    for label, w, h, touch in VIEWPORTS:
        try:
            page, errs = new_page(browser, w, h, touch)
            page.screenshot(path=f"{shots}/{label}-1-loaded.png")
            tap(page, w // 2, h // 2, touch)
            page.wait_for_timeout(1200)
            page.screenshot(path=f"{shots}/{label}-2-after-tap.png")
            ov = page.evaluate("() => ({x: document.documentElement.scrollWidth > innerWidth + 1, y: document.documentElement.scrollHeight > innerHeight + 1})")
            report["viewports"][label] = {"errors": errs, "error_box": err_box(page), "scroll_overflow": ov}
            if label == "phone":
                report["dom_audit"] = page.evaluate(DOM_AUDIT_JS)
            page.close()
        except Exception as e:
            report["viewports"][label] = {"probe_crashed": str(e)[:300]}

    # 2. Input before the game is ready: keys and taps spammed during load.
    def early_input():
        page = browser.new_page(viewport={"width": 390, "height": 844}, has_touch=True)
        errs = []
        page.on("pageerror", lambda e: errs.append(str(e)[:200]))
        page.goto("file://" + path, wait_until="commit")
        for k in ["Space", "Enter", "ArrowUp", "a", "Escape"]:
            try: page.keyboard.press(k)
            except Exception: pass
        page.wait_for_timeout(1500)
        r = {"errors": errs, "error_box": err_box(page)}
        page.close(); return r
    run("early_input", early_input)

    # 3. Rapid and random abuse: 40 fast taps, a long press, a multi-step drag, key mashing.
    def abuse():
        page, errs = new_page(browser, 390, 844, True)
        rnd = random.Random(7)
        for _ in range(40):
            page.touchscreen.tap(rnd.randint(5, 385), rnd.randint(5, 839))
        page.mouse.move(195, 600); page.mouse.down(); page.wait_for_timeout(900); page.mouse.up()
        page.mouse.move(20, 20); page.mouse.down()
        for i in range(30): page.mouse.move(20 + i * 12, 20 + i * 27)
        page.mouse.up()
        for k in ["ArrowLeft", "ArrowRight", "Space", "Enter", "Escape", "r", "z", "Tab"] * 4:
            page.keyboard.press(k)
        page.wait_for_timeout(800)
        page.screenshot(path=f"{shots}/abuse-after.png")
        r = {"errors": errs, "error_box": err_box(page)}
        page.close(); return r
    run("abuse", abuse)

    # 4. Rotate mid-session: portrait to landscape and back.
    def rotate():
        page, errs = new_page(browser, 390, 844, True)
        page.touchscreen.tap(195, 422); page.wait_for_timeout(600)
        page.set_viewport_size({"width": 844, "height": 390}); page.wait_for_timeout(700)
        page.screenshot(path=f"{shots}/rotate-landscape.png")
        page.set_viewport_size({"width": 390, "height": 844}); page.wait_for_timeout(700)
        page.screenshot(path=f"{shots}/rotate-back.png")
        canvas = page.evaluate("() => [...document.querySelectorAll('canvas')].map(c => [c.width, c.height, Math.round(c.getBoundingClientRect().width), Math.round(c.getBoundingClientRect().height)])")
        r = {"errors": errs, "error_box": err_box(page), "canvas_backing_vs_css": canvas}
        page.close(); return r
    run("rotate", rotate)

    # 5. Sustained play: 20 s of random input. Frame rate and memory over time.
    def sustained():
        page, errs = new_page(browser, 390, 844, True)
        page.evaluate("""() => { window.__f = 0; (function c(){ window.__f++; requestAnimationFrame(c); })();
                                  window.__m0 = performance.memory ? performance.memory.usedJSHeapSize : 0; }""")
        rnd = random.Random(11)
        samples = []
        for sec in range(20):
            f0 = page.evaluate("() => window.__f")
            for _ in range(4):
                page.touchscreen.tap(rnd.randint(10, 380), rnd.randint(10, 830))
                page.keyboard.press(rnd.choice(["Space", "ArrowLeft", "ArrowRight", "ArrowUp"]))
                page.wait_for_timeout(240)
            samples.append(page.evaluate("() => window.__f") - f0)
        mem = page.evaluate("() => performance.memory ? [window.__m0, performance.memory.usedJSHeapSize] : null")
        page.screenshot(path=f"{shots}/sustained-after-20s.png")
        r = {"fps_first_5s": round(sum(samples[:5]) / 5), "fps_last_5s": round(sum(samples[-5:]) / 5),
             "heap_bytes_start_end": mem, "errors": errs, "error_box": err_box(page)}
        page.close(); return r
    run("sustained", sustained)

    # 6. Restart consistency: does a fresh load look the same twice? (state that leaks via storage)
    def reload_twice():
        page, errs = new_page(browser, 390, 844, True)
        page.touchscreen.tap(195, 422); page.wait_for_timeout(800)
        page.reload(wait_until="load"); page.wait_for_timeout(1200)
        page.screenshot(path=f"{shots}/reload-1.png")
        storage = page.evaluate("() => { try { return Object.keys(localStorage); } catch (e) { return 'unavailable'; } }")
        r = {"errors": errs, "error_box": err_box(page), "localStorage_keys": storage}
        page.close(); return r
    run("reload", reload_twice)

    # 7. Reduced motion preference honored?
    def reduced_motion():
        ctx = browser.new_context(viewport={"width": 390, "height": 844}, has_touch=True, reduced_motion="reduce")
        page = ctx.new_page()
        errs = []
        page.on("pageerror", lambda e: errs.append(str(e)[:200]))
        page.goto("file://" + path, wait_until="load"); page.wait_for_timeout(1200)
        page.touchscreen.tap(195, 422); page.wait_for_timeout(1000)
        page.screenshot(path=f"{shots}/reduced-motion.png")
        flag = page.evaluate("() => window.matchMedia('(prefers-reduced-motion: reduce)').matches")
        r = {"media_query_active": flag, "errors": errs, "error_box": err_box(page)}
        ctx.close(); return r
    run("reduced_motion", reduced_motion)

    # 8. Static code smells worth a human look.
    def code_smells():
        src = open(path, encoding="utf-8").read()
        checks = {
            "uses_100vh_only (iOS address bar can crop)": "100vh" in src and "dvh" not in src and "innerHeight" not in src,
            "no_touch_action_none (page may scroll or zoom while playing)": "touch-action" not in src,
            "hover_only_styles (no hover on touch)": ":hover" in src and "@media (hover" not in src,
            "no_safe_area_insets (notch can cover edges)": "safe-area-inset" not in src,
            "mousedown_without_pointer_or_touch": "mousedown" in src and "pointerdown" not in src and "touchstart" not in src,
            "audio_without_mute_control": ("AudioContext" in src) and not any(w in src.lower() for w in ["mute", "sound off", "sound: off", "🔇"]),
            "uses_Math_random_for_core_rules (check fairness)": "Math.random" in src,
            "localStorage_without_try": "localStorage" in src and "try" not in src,
        }
        return {k: v for k, v in checks.items() if v}
    run("code_smells", code_smells)

    browser.close()

report["screenshots_dir"] = shots
print(json.dumps(report, indent=1))
