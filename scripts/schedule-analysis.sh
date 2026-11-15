#!/usr/bin/env bash
# Run the A/B analysis every morning on this Mac (launchd), with a notification.
#
#   npm run schedule            # install: daily at 08:17
#   npm run schedule -- off     # remove
#   npm run schedule -- status
set -euo pipefail
cd "$(dirname "$0")/.."
REPO="$(pwd)"
LABEL="miami.anton.ab-analysis"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
NODE="$(command -v node)"

case "${1:-on}" in
  off)
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
    rm -f "$PLIST"; echo "✓ daily analysis removed" ;;
  status)
    launchctl print "gui/$(id -u)/$LABEL" 2>/dev/null | grep -E 'state|last exit' || echo "not scheduled"
    [ -f reports/latest.md ] && echo "latest report: reports/latest.md ($(date -r reports/latest.md))" ;;
  on)
    [ -f .env ] || { echo "schedule: create .env with POSTHOG_PERSONAL_API_KEY first (README → Analysis)"; exit 1; }
    mkdir -p "$HOME/Library/LaunchAgents" reports
    cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array>
    <string>$NODE</string><string>$REPO/scripts/analyze.mjs</string><string>--notify</string>
  </array>
  <key>WorkingDirectory</key><string>$REPO</string>
  <key>StartCalendarInterval</key><dict><key>Hour</key><integer>8</integer><key>Minute</key><integer>17</integer></dict>
  <key>StandardOutPath</key><string>$REPO/reports/analyze.log</string>
  <key>StandardErrorPath</key><string>$REPO/reports/analyze.log</string>
</dict></plist>
PL
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
    launchctl bootstrap "gui/$(id -u)" "$PLIST"
    echo "✓ analysis runs daily at 08:17 (missed runs catch up when the Mac wakes)"
    echo "  report: $REPO/reports/latest.md · log: reports/analyze.log · run now: npm run analyze" ;;
  *) echo "usage: npm run schedule [-- on|off|status]"; exit 1 ;;
esac
