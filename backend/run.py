#!/usr/bin/env python3
"""Vessel Caller backend entry point.

Run:  python3 backend/run.py
Env:  PORT=8000  HOST=127.0.0.1  VESSEL_DB=<sqlite path>  STATIC_DIR=<frontend dir>
      ALLOW_ORIGIN=<CORS origin, e.g. * — omit when serving same-origin>
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from vessel_backend.api import main

if __name__ == '__main__':
    main()
