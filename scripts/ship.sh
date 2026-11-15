#!/usr/bin/env bash
# One command to publish: pull the latest page designs, re-apply the A/B
# additions, sanity-check, commit and push. Cloudflare (Workers Builds) deploys
# automatically on push, so this is all you run.
#
#   npm run ship                      # pages from ../anton.miami (default)
#   npm run ship -- "new chart page"  # custom commit message
#   PAGES_DIR=~/elsewhere npm run ship
set -euo pipefail

cd "$(dirname "$0")/.."
PAGES_DIR="${PAGES_DIR:-../anton.miami}"
MSG="${1:-Update front pages}"

DAWN="$PAGES_DIR/index.html"
CHART="$PAGES_DIR/alternative1/index.html"
[[ -f "$DAWN" && -f "$CHART" ]] || { echo "ship: can't find $DAWN and $CHART (set PAGES_DIR)"; exit 1; }

echo "→ pulling latest from GitHub"
git pull --ff-only --quiet

echo "→ syncing pages from $PAGES_DIR"
python3 scripts/sync_pages.py "$DAWN" "$CHART"

echo "→ checking"
node --check src/worker.js
node --check public/ab/track.js
for v in dawn chart; do
  f="public/variants/$v/index.html"
  grep -q "name=\"ab-variant\" content=\"$v\"" "$f" || { echo "ship: $f lost its ab-variant tag"; exit 1; }
  grep -q '/ab/track.js' "$f" || { echo "ship: $f lost the tracking script"; exit 1; }
done

if git diff --quiet && git diff --cached --quiet && [[ -z "$(git ls-files --others --exclude-standard)" ]]; then
  echo "✓ nothing changed; site is already up to date"
  exit 0
fi

git add -A
# never publish secrets, even if an ignore rule goes missing
if git diff --cached --name-only | grep -qE '(^|/)\.env($|\.)|(^|/)\.dev\.vars'; then
  git diff --cached --name-only | grep -E '(^|/)\.env($|\.)|(^|/)\.dev\.vars' | grep -v '\.env\.example$' >/dev/null && {
    git reset --quiet
    echo "ship: refusing to commit a .env / .dev.vars file (secrets). Add it to .gitignore."; exit 1; }
fi
git commit --quiet -m "$MSG"
git push --quiet
echo "✓ pushed $(git rev-parse --short HEAD) to $(git branch --show-current); Cloudflare will deploy it in about a minute"
