#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is required. Install the LTS build from https://nodejs.org , then run again."
  exit 1
fi
[ -d node_modules ] || { echo "First run - installing dependencies..."; npm install; }
echo "Starting U1 Print Hub at http://localhost:4545"
( sleep 1; command -v open >/dev/null && open http://localhost:4545 || (command -v xdg-open >/dev/null && xdg-open http://localhost:4545) ) >/dev/null 2>&1 &
node server.js
