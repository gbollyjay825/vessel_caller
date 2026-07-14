"""Test config: isolated temp SQLite, seeding off, fixed secret. Env is set
BEFORE importing the app so the engine binds to the temp DB."""
import os
import tempfile

os.environ["VC_DATABASE_URL"] = f"sqlite:///{tempfile.mkdtemp()}/test.db"
os.environ["VC_SEED_ON_STARTUP"] = "false"
os.environ["VC_JWT_SECRET"] = "test-secret-please-change"
os.environ["VC_ENVIRONMENT"] = "development"

import pytest
from fastapi.testclient import TestClient

from app.main import app


@pytest.fixture()
def client():
    with TestClient(app) as c:   # context-manager triggers startup (create_all)
        yield c


def register(client, email="admin@acme.test", org="Acme Marine"):
    r = client.post("/api/auth/register", json={
        "name": "Admin One", "email": email, "password": "supersecret", "orgName": org,
        "designatedPort": "Port of Calabar",
    })
    assert r.status_code == 201, r.text
    return r.json()


def auth(token):
    return {"Authorization": f"Bearer {token}"}
