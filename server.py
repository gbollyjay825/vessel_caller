#!/usr/bin/env python3
"""
Vessel Caller — launcher shim. The backend now lives in backend/ (see
backend/README.md); this file only keeps the historical entry point alive:

Run:  python3 server.py            (http://localhost:8000)
Env:  PORT=8000  HOST=127.0.0.1  VESSEL_DB=<path to sqlite file>

Serves the frontend from the repo root and keeps the pre-package database
location (repo-root vessel_caller.db) so existing setups keep working.
"""
import os
import sys

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(BASE_DIR, 'backend'))

from vessel_backend.api import main
from vessel_backend.config import Config

if __name__ == '__main__':
    main(Config(
        db_path=os.environ.get('VESSEL_DB', os.path.join(BASE_DIR, 'vessel_caller.db')),
        static_dir=os.environ.get('STATIC_DIR', BASE_DIR),
    ))
