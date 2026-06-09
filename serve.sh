#!/usr/bin/env bash
# Serve the Calabar Port Inspection Platform locally.
# ES modules require HTTP (not file://), so we use Python's built-in server.
set -e
cd "$(dirname "$0")"
PORT="${1:-8000}"
echo "Calabar Port — Inspection Platform"
echo "Serving on http://localhost:${PORT}  (Ctrl+C to stop)"
python3 -m http.server "${PORT}"
