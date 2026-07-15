"""Vercel Python serverless entry — serves the FastAPI app at /api/*.

Vercel's filesystem is read-only except /tmp, so the SQLite DB lives in /tmp
and is (re)seeded per cold start. That makes this a self-contained demo: data
resets when a new serverless instance spins up (comparable to the old
localStorage demo). For durable data, set VC_DATABASE_URL to a hosted Postgres
in the Vercel project env — no code change needed.
"""
import os
import sys

# the backend package lives at ../backend
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "backend"))

os.environ.setdefault("VC_DATABASE_URL", "sqlite:////tmp/vessel_caller.db")
os.environ.setdefault("VC_SEED_ON_STARTUP", "true")
os.environ.setdefault("VC_ENVIRONMENT", "production")
# Override VC_JWT_SECRET in the Vercel project env with a long random string.
os.environ.setdefault("VC_JWT_SECRET", "vercel-demo-secret-please-set-VC_JWT_SECRET-in-project-env-0001")

from app.main import app  # noqa: E402  (exposed to Vercel's ASGI runtime)
from app.db import Base, SessionLocal, engine  # noqa: E402
from app.seed import seed_if_empty  # noqa: E402

# Ensure schema + demo data exist for this (cold-started) instance, in case the
# ASGI lifespan hook doesn't run under the serverless runtime.
Base.metadata.create_all(bind=engine)
_db = SessionLocal()
try:
    seed_if_empty(_db)
finally:
    _db.close()
