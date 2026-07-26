"""Legacy FastAPI application retained only for blue/green rollback."""
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware

from . import __version__
from .config import get_settings
from .db import Base, SessionLocal, engine
from .routers import (analytics, auth, inspections, invoices, organization, settings as settings_router,
                      state, vessel_calls)
from .seed import seed_if_empty

settings = get_settings()
log = logging.getLogger("vessel_caller")

@asynccontextmanager
async def lifespan(_: FastAPI):
    Base.metadata.create_all(bind=engine)
    if settings.is_production and settings.jwt_secret.startswith("dev-insecure"):
        log.warning("VC_JWT_SECRET is still the insecure default — set a strong secret in production!")
    if settings.seed_on_startup:
        db = SessionLocal()
        try:
            seed_if_empty(db)
        finally:
            db.close()
    yield


app = FastAPI(title=settings.app_name, version=__version__, lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

_SECURITY_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Cross-Origin-Opener-Policy": "same-origin",
}


@app.middleware("http")
async def security_headers(request: Request, call_next):
    resp = await call_next(request)
    for k, v in _SECURITY_HEADERS.items():
        resp.headers.setdefault(k, v)
    if settings.is_production:
        resp.headers.setdefault("Strict-Transport-Security", "max-age=63072000; includeSubDomains")
    return resp


for r in (auth.router, state.router, organization.router, vessel_calls.router,
          inspections.router, invoices.router, settings_router.router, analytics.router):
    app.include_router(r)


@app.get("/api/health", tags=["health"])
def health():
    return {"status": "ok", "version": __version__, "environment": settings.environment}
