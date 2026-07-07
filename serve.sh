#!/usr/bin/env bash
# Run the Vessel Caller app with its Python backend (stdlib only).
# Frontend + REST API + SQLite persistence on one port.
set -e
cd "$(dirname "$0")"
PORT="${1:-8000}"
echo "Vessel Caller — frontend + Python backend"
echo "http://localhost:${PORT}  (Ctrl+C to stop)"
PORT="${PORT}" python3 server.py
