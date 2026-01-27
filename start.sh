#!/bin/bash
set -e

# Load .env if it exists
if [ -f .env ]; then
  export $(grep -v '^#' .env | xargs)
fi

PORT=${PORT:-3000}

echo "Starting tasks enricher on port $PORT..."
node src/server.js &
SERVER_PID=$!

echo "Starting Cloudflare tunnel (enricher.daviddelatorre.dev)..."
cloudflared tunnel run tasks-enricher &
TUNNEL_PID=$!

# Trap to clean up both processes
trap "echo 'Shutting down...'; kill $SERVER_PID $TUNNEL_PID 2>/dev/null" EXIT INT TERM

echo "Both services running. Press Ctrl+C to stop."
wait
