#!/usr/bin/env bash
# Start Studio Forge on macOS/Linux: ./start.sh
set -e
cd "$(dirname "$0")"
command -v node >/dev/null || { echo "Node.js 20+ is required: https://nodejs.org"; exit 1; }
[ -d node_modules ] || npm install
( sleep 3; if command -v open >/dev/null; then open http://localhost:4317; elif command -v xdg-open >/dev/null; then xdg-open http://localhost:4317; fi ) &
npm start
