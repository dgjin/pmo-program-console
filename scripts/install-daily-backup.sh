#!/bin/sh
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
NODE_BIN=$(command -v node || true)
if [ -z "$NODE_BIN" ]; then
  echo "找不到 node，请先在当前用户 PATH 中安装 Node 22.5+"
  exit 1
fi
mkdir -p "$ROOT/backups"
chmod 700 "$ROOT/backups"

if [ "$(uname)" = "Darwin" ]; then
  PLIST="$HOME/Library/LaunchAgents/com.pmo.backup.plist"
  mkdir -p "$HOME/Library/LaunchAgents"
  cat > "$PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.pmo.backup</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$ROOT/scripts/backup.js</string>
  </array>
  <key>WorkingDirectory</key><string>$ROOT</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PMO_DB</key><string>$ROOT/data/pmo.db</string>
    <key>PMO_BACKUP_DIR</key><string>$ROOT/backups</string>
    <key>PMO_BACKUP_KEEP_DAYS</key><string>30</string>
  </dict>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key><integer>2</integer>
    <key>Minute</key><integer>0</integer>
  </dict>
  <key>StandardOutPath</key><string>$ROOT/backups/backup.log</string>
  <key>StandardErrorPath</key><string>$ROOT/backups/backup.log</string>
  <key>RunAtLoad</key><false/>
</dict>
</plist>
PLISTEOF
  launchctl bootout "gui/$(id -u)/com.pmo.backup" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$PLIST"
  launchctl enable "gui/$(id -u)/com.pmo.backup"
  echo "已安装每日 02:00 备份：$PLIST"
  echo "查看：launchctl print gui/$(id -u)/com.pmo.backup"
else
  echo "非 macOS：请把下面一行加入 crontab（每天 02:00）："
  echo "0 2 * * * cd '$ROOT' && PMO_DB='$ROOT/data/pmo.db' PMO_BACKUP_DIR='$ROOT/backups' '$NODE_BIN' scripts/backup.js >> '$ROOT/backups/backup.log' 2>&1"
fi
