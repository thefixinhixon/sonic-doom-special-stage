#!/bin/sh
# Start the local server and open the game in your browser.
cd "$(dirname "$0")" || exit 1
PORT="${1:-8090}"
node serve.mjs "$PORT" &
SERVER=$!
sleep 1
xdg-open "http://localhost:$PORT/" >/dev/null 2>&1 || echo "Open http://localhost:$PORT/ in your browser"
echo "Press Ctrl+C to stop the server."
trap 'kill $SERVER 2>/dev/null' INT TERM EXIT
wait $SERVER
