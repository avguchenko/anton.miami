#!/usr/bin/env python3
"""Copy the latest page designs into public/variants/ and re-apply the A/B additions.

    python3 scripts/sync_pages.py <dawn source.html> <chart source.html>

The design files are edited elsewhere (as plain standalone pages). This script
adds, idempotently: the ab-variant meta, shared Open Graph tags, the tracking
script, and each page's GitHub link. It fails loudly if a page's markup changed
so much that an anchor point is gone, rather than silently skipping something.
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
GITHUB = "https://github.com/avguchenko"

HEAD = """<meta name="ab-variant" content="{variant}">
<meta name="description" content="Anton in Miami: a living chart of the sea off Miami. Geography, mathematics and patterns.">
<meta property="og:type" content="website">
<meta property="og:url" content="https://anton.miami/">
<meta property="og:title" content="Anton Miami">
<meta property="og:description" content="A living chart of the sea off Miami. Geography, mathematics and patterns. Move the pointer and it answers.">
<meta property="og:image" content="https://anton.miami/og.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<link rel="canonical" href="https://anton.miami/">
<script src="/ab/track.js" defer></script>"""


def need(cond, msg):
    if not cond:
        sys.exit(f"sync_pages: {msg}")


def head(s, variant):
    s = re.sub(r'<meta name="description"[^>]*>\n?', "", s)
    need("ab/track.js" not in s, f"{variant}: source already contains tracking; pass the raw design file")
    m = re.search(r'<meta name="viewport"[^>]*>', s)
    need(m, f"{variant}: no <meta name=viewport> to anchor head tags")
    return s[: m.end()] + "\n" + HEAD.format(variant=variant) + s[m.end():]


def dawn(s):
    s = head(s, "dawn")
    css_anchor = "  .tags {"
    need(css_anchor in s, "dawn: '.tags {' CSS rule not found")
    s = s.replace(css_anchor, """  .name a.out { pointer-events: auto; color: var(--foam); text-decoration: none;
    border-bottom: 1px solid rgba(143, 230, 223, 0.35); padding-bottom: 1px; transition: color .4s ease, border-color .4s ease; }
  .name a.out:hover, .name a.out:focus-visible { color: var(--ink); border-color: var(--ink); outline: none; }
""" + css_anchor, 1)
    m = re.search(r'(<header class="name">.*?)(\n\s*</header>)', s, re.S)
    need(m, "dawn: <header class=\"name\"> block not found")
    link = f'\n    <p class="links"><a class="out" href="{GITHUB}" target="_blank" rel="noopener" data-track="github">GitHub ↗</a></p>'
    return s[: m.end(1)] + link + s[m.end(1):]


def chart(s):
    s = head(s, "chart")
    a = "  .notes button:hover"
    need(a in s, "chart: '.notes button:hover' CSS rule not found")
    s = s.replace(a, """  .notes a { all: unset; pointer-events: auto; cursor: none; transition: opacity .5s ease; border-bottom: 1px solid currentColor; }
  .notes a:hover { opacity: .55; }
  .notes a:focus-visible { outline: 1px solid var(--accent); outline-offset: 3px; }
""" + a, 1)
    m = re.search(r'(<button type="button" id="btn-ed"[^>]*>.*?</button>)', s)
    need(m, "chart: #btn-ed button not found")
    link = f'<span class="sep">·</span><a href="{GITHUB}" target="_blank" rel="noopener" data-track="github">GitHub</a>'
    s = s[: m.end()] + link + s[m.end():]
    # the page ignores presses on its own controls; links must be ignored too
    c = "e.target.closest('button')"
    if c in s:
        s = s.replace(c, "e.target.closest('button, a')")
    return s


def main():
    need(len(sys.argv) == 3, __doc__)
    for src, variant, fn in ((sys.argv[1], "dawn", dawn), (sys.argv[2], "chart", chart)):
        out = ROOT / "public" / "variants" / variant / "index.html"
        out.write_text(fn(Path(src).read_text(encoding="utf-8")), encoding="utf-8")
        print(f"{variant}: {src} -> {out.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
