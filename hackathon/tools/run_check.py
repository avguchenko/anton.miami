import sys, json
from playwright.sync_api import sync_playwright

path = sys.argv[1]
errors = []
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, args=["--no-sandbox", "--disable-gpu"])
    page = browser.new_page(viewport={"width": 390, "height": 844}, has_touch=True)
    page.on("pageerror", lambda e: errors.append("pageerror: " + str(e)))
    page.on("console", lambda m: errors.append("console: " + m.text) if m.type == "error" else None)
    page.route("**/*", lambda route: route.abort() if not route.request.url.startswith("file://") else route.continue_())
    page.goto("file://" + path, wait_until="load")
    page.wait_for_timeout(2000)
    page.mouse.click(195, 422)
    page.wait_for_timeout(500)
    page.keyboard.press("Space")
    page.wait_for_timeout(1500)
    canvas_ok = page.evaluate("() => { const c = document.querySelector('canvas'); return !!c && c.width > 0 && c.height > 0; }")
    err_box = page.evaluate("() => { const e = document.getElementById('err'); return e ? e.textContent : ''; }")
    if err_box.strip():
        errors.append("error box: " + err_box.strip())
    if not canvas_ok:
        errors.append("no sized canvas found")
    browser.close()

print(json.dumps({"ok": not errors, "errors": errors}))
sys.exit(1 if errors else 0)
