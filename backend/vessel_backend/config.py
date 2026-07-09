"""Runtime configuration, resolved from environment variables.

Env:
  PORT          listen port                     (default 8000)
  HOST          bind address                    (default 127.0.0.1)
  VESSEL_DB     path to the SQLite file         (default backend/vessel_caller.db)
  STATIC_DIR    directory the frontend is served from  (default the repo root)
  ALLOW_ORIGIN  optional CORS origin, e.g. * or https://app.example.com
                (unset -> no CORS headers; same-origin serving needs none)

Every value can also be overridden programmatically (the root server.py shim
and the test suite pass explicit paths), so env vars are only the fallback.
"""
import os

BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # backend/
REPO_ROOT = os.path.dirname(BACKEND_DIR)


class Config:
    def __init__(self, host=None, port=None, db_path=None, static_dir=None, allow_origin=None):
        env = os.environ
        self.host = host if host is not None else env.get('HOST', '127.0.0.1')
        self.port = int(port if port is not None else env.get('PORT', '8000'))
        self.db_path = db_path if db_path is not None else env.get('VESSEL_DB', os.path.join(BACKEND_DIR, 'vessel_caller.db'))
        self.static_dir = static_dir if static_dir is not None else env.get('STATIC_DIR', REPO_ROOT)
        self.allow_origin = allow_origin if allow_origin is not None else (env.get('ALLOW_ORIGIN') or None)
