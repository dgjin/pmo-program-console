#!/bin/sh
# 启动 PMO 项目群管理台，并自动打开浏览器
set -e
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "未找到 Node.js，请先安装 Node 22.5+"
  exit 1
fi

PORT="${PMO_PORT:-5177}"
URL="http://127.0.0.1:${PORT}"

if [ "$PMO_NO_OPEN" != "1" ] && command -v open >/dev/null 2>&1; then
  ( sleep 1.2; open "$URL" >/dev/null 2>&1 || true ) &
fi

echo "PMO 项目群管理台 → ${URL}"
exec node server.js
