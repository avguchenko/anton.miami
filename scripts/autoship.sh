#!/usr/bin/env bash
# Hourly auto-publish of the page designs (launchd on this Mac).
#
#   npm run autoship            # install: checks every hour
#   npm run autoship -- off     # remove
#   npm run autoship -- status  # is it installed, what happened last
#   npm run autoship -- run     # one check right now (what the hourly job runs)
#
# Each check: if the design files in ../anton.miami changed AND have been left alone
# for SETTLE_MIN minutes (so a page that's mid-edit isn't grabbed), run the same
# sync → check → commit → push as `npm run ship`. Cloudflare deploys on push.
# Safety: skips if this repo has unrelated local changes; refuses truncated pages.
set -euo pipefail
cd "$(dirname "$0")/.."
REPO="$(pwd)"
PAGES_DIR="${PAGES_DIR:-$REPO/../anton.miami}"
SETTLE_MIN="${SETTLE_MIN:-10}"
LABEL="miami.anton.autoship"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$REPO/reports/autoship.log"

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') $*"; }
notify() { [ "$(uname)" = Darwin ] && osascript -e "display notification \"$1\" with title \"anton.miami\"" 2>/dev/null || true; }

run_once() {
  local dawn="$PAGES_DIR/index.html" chart="$PAGES_DIR/alternative1/index.html"
  [[ -f "$dawn" && -f "$chart" ]] || { log "skip: design files not found in $PAGES_DIR"; return 0; }

  # Settled? newest design file (pages + assets beside them) must be older than SETTLE_MIN
  local newest
  newest=$(find "$PAGES_DIR" -maxdepth 2 -type f ! -name '.DS_Store' -exec stat -f %m {} + 2>/dev/null | sort -n | tail -1)
  local age=$(( $(date +%s) - ${newest:-0} ))
  if (( age < SETTLE_MIN * 60 )); then log "skip: designs edited $((age / 60)) min ago (waiting for ${SETTLE_MIN} min of quiet)"; return 0; fi

  # Only ever commit design changes: bail if the repo has other local edits
  if [ -n "$(git status --porcelain)" ]; then log "skip: repo has uncommitted local changes; not auto-publishing over them"; return 0; fi
  [ "$(git branch --show-current)" = main ] || { log "skip: not on main"; return 0; }

  git pull --ff-only --quiet
  python3 scripts/sync_pages.py "$dawn" "$chart" >/dev/null
  if [ -z "$(git status --porcelain)" ]; then log "no changes"; return 0; fi

  # Sanity checks before publishing anything
  local ok=1
  for v in dawn chart; do
    f="public/variants/$v/index.html"
    grep -q "name=\"ab-variant\" content=\"$v\"" "$f" && grep -q '/ab/track.js' "$f" || { log "refuse: $f lost its tracking tags"; ok=0; }
    tail -c 200 "$f" | grep -qi '</html>' || { log "refuse: $f looks truncated (no </html>)"; ok=0; }
    [ "$(wc -c < "$f")" -gt 20000 ] || { log "refuse: $f is suspiciously small"; ok=0; }
  done
  node --check public/ab/track.js || ok=0
  node --test >/dev/null 2>&1 || { log "refuse: tests failed"; ok=0; }
  if (( ok == 0 )); then git checkout -q -- . && git clean -qfd public/variants; notify "Auto-publish skipped: a page failed checks (see reports/autoship.log)"; return 1; fi

  local changed
  changed=$(git status --porcelain | awk '{print $2}' | sed -E 's#public/variants/([^/]+)/.*#\1#' | sort -u | tr '\n' ' ')
  git add -A
  git commit --quiet -m "Auto-publish page designs: ${changed% }"
  git push --quiet
  log "published: ${changed% } ($(git rev-parse --short HEAD))"
  notify "Published new ${changed% } page; live in about a minute"
}

case "${1:-on}" in
  run) mkdir -p reports; run_once ;;
  on)
    mkdir -p "$HOME/Library/LaunchAgents" reports
    cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>/bin/bash</string><string>$REPO/scripts/autoship.sh</string><string>run</string></array>
  <key>WorkingDirectory</key><string>$REPO</string>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>$(dirname "$(command -v node)"):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
  <key>StartInterval</key><integer>3600</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict></plist>
PL
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
    launchctl bootstrap "gui/$(id -u)" "$PLIST"
    echo "✓ checking ../anton.miami every hour; publishes after ${SETTLE_MIN} min of quiet"
    echo "  log: reports/autoship.log · stop: npm run autoship -- off" ;;
  off)
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
    rm -f "$PLIST"; echo "✓ hourly auto-publish removed" ;;
  status)
    launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1 && echo "installed (hourly)" || echo "not installed"
    [ -f "$LOG" ] && tail -5 "$LOG" ;;
  *) echo "usage: npm run autoship [-- on|off|status|run]"; exit 1 ;;
esac
