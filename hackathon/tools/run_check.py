"""Pre-publish check for a hackathon entry.

Usage: python3 run_check.py /abs/path/entry.html [--shots DIR] [--no-browser]

Static checks always run. The browser check runs unless --no-browser is given.

Network use is allowed in entries. The main browser check always runs with the
network blocked, so it proves the entry degrades gracefully offline: no uncaught
errors and something visible. If the entry uses the network, an extra online
pass records what it requested and whether each request worked. Online request
failures are notes, not errors, because the sandbox may block some hosts; an
uncaught error in the online pass is still an error.

Prints JSON and exits 0 only if every check passed.
"""
import json, os, re, subprocess, sys, tempfile

args = sys.argv[1:]
if not args:
    print("usage: run_check.py FILE [--shots DIR] [--no-browser]")
    sys.exit(2)
path = os.path.abspath(args[0])
shots = args[args.index("--shots") + 1] if "--shots" in args else None
use_browser = "--no-browser" not in args

errors, notes = [], []
src = open(path, encoding="utf-8").read()
low = src.lower()

# ---- Static: structure
if not src.lstrip().lower().startswith("<!doctype html>"):
    errors.append("static: file must start with <!DOCTYPE html>")
m = re.search(r'<meta\s+name="description"\s+content="([^"]*)"', src, re.I)
if not m or not m.group(1).strip():
    errors.append("static: missing or empty meta description")
if not re.search(r'<meta\s+name="viewport"', src, re.I):
    errors.append("static: missing viewport meta")
t = re.search(r"<title>(.*?)</title>", src, re.I | re.S)
if not t or not re.match(r"Hackathon \d{2,} · .+ · .+", t.group(1).strip()):
    errors.append("static: <title> must look like 'Hackathon NN · Genre · Title'")
if "REPLACE" in src:
    errors.append("static: template placeholder 'REPLACE' still present")

# ---- Static: no libraries, no secrets, no trackers
if re.search(r"<script[^>]*\ssrc\s*=", src, re.I):
    errors.append("static: external <script src> found (no libraries or external scripts)")
for pat in ["api_key", "apikey", "api-key", "access_token", "client_secret", "bearer ", "authorization:"]:
    if pat in low:
        errors.append("static: looks like a key or secret is embedded: " + pat)
for pat in ["google-analytics", "googletagmanager", "gtag(", "plausible.io", "segment.com", "mixpanel",
            "hotjar", "facebook.net", "doubleclick", "clarity.ms"]:
    if pat in low:
        errors.append("static: analytics or tracker found: " + pat)
uses_network = bool(re.search(r"https?:|fetch\(|XMLHttpRequest|WebSocket|EventSource", src))
if uses_network:
    notes.append("entry uses the network: browser checks run offline, plus an online pass")

# ---- Static: JS syntax
scripts = re.findall(r"<script(?:\s[^>]*)?>(.*?)</script>", src, re.I | re.S)
if not scripts:
    errors.append("static: no inline <script> found")
for i, code in enumerate(scripts):
    with tempfile.NamedTemporaryFile("w", suffix=".js", delete=False) as f:
        f.write(code)
        tmp = f.name
    r = subprocess.run(["node", "--check", tmp], capture_output=True, text=True)
    os.unlink(tmp)
    if r.returncode != 0:
        errors.append("syntax (script %d): %s" % (i, (r.stderr or r.stdout).strip()[-600:]))


def is_local(url):
    return url.startswith(("file:", "data:", "blob:"))


def offline_pass(browser, label, vp, touch, blocked):
    page = browser.new_page(viewport=vp, has_touch=touch)
    errs = []
    page.on("pageerror", lambda e: errs.append("pageerror: " + str(e)))
    page.on("console", lambda m: errs.append("console: " + m.text)
            if m.type == "error" and not m.text.startswith("Failed to load resource") else None)

    def route(r, req=None):
        if is_local(r.request.url):
            r.continue_()
        else:
            blocked.append(r.request.url[:120])
            r.abort()
    page.route("**/*", route)
    page.goto("file://" + path, wait_until="load")
    page.wait_for_timeout(1500)
    if shots:
        page.screenshot(path=os.path.join(shots, label + "-loaded.png"))
    cx, cy = vp["width"] // 2, vp["height"] // 2
    page.mouse.click(cx, cy)
    page.wait_for_timeout(400)
    page.keyboard.press("Space")
    page.wait_for_timeout(400)
    page.mouse.move(cx - 80, cy)
    page.mouse.down()
    page.mouse.move(cx + 80, cy + 40, steps=8)
    page.mouse.up()
    for k in ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Enter"]:
        page.keyboard.press(k)
    page.wait_for_timeout(1500)
    if shots:
        page.screenshot(path=os.path.join(shots, label + "-played.png"))
    info = page.evaluate("""() => {
      const e = document.getElementById('err');
      const vis = [...document.querySelectorAll('canvas,svg,img')].some(n => n.getBoundingClientRect().width > 0)
                  || document.body.innerText.trim().length > 0;
      return { errText: e ? e.textContent.trim() : '', visible: vis,
               overflowX: document.documentElement.scrollWidth > innerWidth + 1 };
    }""")
    if info["errText"]:
        errs.append("error box: " + info["errText"][:300])
    if not info["visible"]:
        errs.append("nothing visible on the page")
    if info["overflowX"]:
        notes.append(label + ": page is wider than the viewport (horizontal scroll)")
    errors.extend(label + " offline " + e for e in errs)
    page.close()


def online_pass(browser):
    page = browser.new_page(viewport={"width": 390, "height": 844}, has_touch=True)
    seen, errs = [], []
    page.on("response", lambda r: seen.append("%s %s" % (r.status, r.url[:100])) if not is_local(r.url) else None)
    page.on("requestfailed", lambda r: seen.append("FAILED %s (%s)" % (r.url[:100], r.failure)))
    page.on("pageerror", lambda e: errs.append(str(e)[:200]))
    page.goto("file://" + path, wait_until="load")
    page.wait_for_timeout(4000)
    page.mouse.click(195, 422)
    page.wait_for_timeout(2500)
    if shots:
        page.screenshot(path=os.path.join(shots, "online.png"))
    notes.append("online pass requests: " + ("; ".join(seen[:12]) or "none"))
    if errs:
        errors.append("online pageerror: " + "; ".join(errs[:3]))
    page.close()


if use_browser and not any(e.startswith("syntax") for e in errors):
    if shots:
        os.makedirs(shots, exist_ok=True)
    try:
        from playwright.sync_api import sync_playwright
    except Exception as e:
        errors.append("runtime: playwright not importable (%s); rerun with --no-browser only if no browser can be installed" % e)
    else:
        try:
            with sync_playwright() as p:
                browser = p.chromium.launch(headless=True, args=["--no-sandbox", "--disable-gpu",
                                                                 "--autoplay-policy=no-user-gesture-required"])
                blocked = []
                offline_pass(browser, "phone", {"width": 390, "height": 844}, True, blocked)
                offline_pass(browser, "desktop", {"width": 1280, "height": 800}, False, blocked)
                if blocked:
                    notes.append("offline pass blocked %d request(s)" % len(blocked))
                if uses_network:
                    online_pass(browser)
                browser.close()
        except Exception as e:
            errors.append("runtime: check crashed: %s" % str(e)[:300])
elif not use_browser:
    notes.append("browser check skipped (--no-browser)")

print(json.dumps({"ok": not errors, "errors": errors, "notes": notes, "screenshots": shots}, indent=1))
sys.exit(0 if not errors else 1)
