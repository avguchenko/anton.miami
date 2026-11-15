"""Pre-publish check for a hackathon entry.

Usage: python3 run_check.py /abs/path/entry.html [--shots DIR] [--no-browser]

Static checks always run. The browser check runs unless --no-browser is given.
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

# ---- Static: no network
for pat in ["://", "fetch(", "XMLHttpRequest", "WebSocket", "EventSource", "sendBeacon",
            "@import", "<script src", "<link", "import(", "<iframe"]:
    if pat.lower() in src.lower():
        errors.append("static: forbidden network pattern found: " + pat)

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

# ---- Runtime: real browser, offline, phone and desktop
if use_browser and not any(e.startswith("syntax") for e in errors):
    try:
        from playwright.sync_api import sync_playwright
    except Exception as e:
        errors.append("runtime: playwright not importable (%s); rerun with --no-browser only if no browser can be installed" % e)
    else:
        try:
          with sync_playwright() as p:
              browser = p.chromium.launch(headless=True, args=["--no-sandbox", "--disable-gpu",
                                                               "--autoplay-policy=no-user-gesture-required"])
              for label, vp, touch in [("phone", {"width": 390, "height": 844}, True),
                                       ("desktop", {"width": 1280, "height": 800}, False)]:
                  page = browser.new_page(viewport=vp, has_touch=touch)
                  errs = []
                  page.on("pageerror", lambda e, errs=errs: errs.append("pageerror: " + str(e)))
                  page.on("console", lambda m, errs=errs: errs.append("console: " + m.text) if m.type == "error" else None)

                  def make_route(errs):
                      def route(r, req=None):
                          if r.request.url.startswith(("file:", "data:", "blob:")):
                              r.continue_()
                          else:
                              errs.append("network request attempted: " + r.request.url[:120])
                              r.abort()
                      return route
                  page.route("**/*", make_route(errs))
                  page.goto("file://" + path, wait_until="load")
                  page.wait_for_timeout(1500)
                  if shots:
                      os.makedirs(shots, exist_ok=True)
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
                    const vis = [...document.querySelectorAll('canvas,svg')].some(n => n.getBoundingClientRect().width > 0)
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
                  errors += [label + " " + e for e in errs]
                  page.close()
              browser.close()
        except Exception as e:
            errors.append("runtime: check crashed: %s" % str(e)[:300])
elif not use_browser:
    notes.append("browser check skipped (--no-browser)")

print(json.dumps({"ok": not errors, "errors": errors, "notes": notes, "screenshots": shots}, indent=1))
sys.exit(0 if not errors else 1)
