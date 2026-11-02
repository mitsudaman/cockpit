#!/bin/bash
# メニューバーアプリをビルドし、サーバーとメニューを launchd に登録する（何度実行してもよい）
set -euo pipefail
cd "$(dirname "$0")"

BOARD="$(cd .. && pwd)"
APP="$PWD/build/CaseBoard.app"
NODE="$(command -v node)"
AGENTS="$HOME/Library/LaunchAgents"
LOG="$HOME/Library/Logs/case-board.log"
DOMAIN="gui/$(id -u)"
SERVER=local.case-board
MENU=local.case-board.menubar

mkdir -p "$APP/Contents/MacOS" "$AGENTS" "$(dirname "$LOG")"
swiftc -O -swift-version 5 -o "$APP/Contents/MacOS/CaseBoard" CaseBoardMenu.swift
cat > "$APP/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>$MENU</string>
  <key>CFBundleName</key><string>CaseBoard</string>
  <key>CFBundleExecutable</key><string>CaseBoard</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>LSUIElement</key><true/>
</dict></plist>
EOF
codesign --force -s - "$APP" >/dev/null 2>&1

cat > "$AGENTS/$SERVER.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$SERVER</string>
  <key>ProgramArguments</key><array><string>$NODE</string><string>$BOARD/server.mjs</string></array>
  <key>WorkingDirectory</key><string>$BOARD</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict></plist>
EOF

cat > "$AGENTS/$MENU.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$MENU</string>
  <key>ProgramArguments</key><array><string>/usr/bin/open</string><string>-a</string><string>$APP</string></array>
  <key>RunAtLoad</key><true/>
</dict></plist>
EOF

# 手で起動したサーバーがいると launchd 側がポートを取れないので、先に止める
for pid in $(lsof -a -c node -tiTCP:4747 -sTCP:LISTEN || true); do kill "$pid"; done
pkill -x CaseBoard || true
for label in $SERVER $MENU; do launchctl bootout "$DOMAIN/$label" 2>/dev/null || true; done
sleep 1

for label in $SERVER $MENU; do
  launchctl enable "$DOMAIN/$label"
  launchctl bootstrap "$DOMAIN" "$AGENTS/$label.plist"
done

echo "installed: $APP"
echo "server: http://localhost:4747/  log: $LOG"
