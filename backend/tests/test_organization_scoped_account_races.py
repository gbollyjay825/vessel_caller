from __future__ import annotations

import threading

import pytest
from django.core.cache import cache
from django.db import close_old_connections, connection
from rest_framework.test import APIClient

from accounts.backends import EmailBackend
from accounts.models import ActionToken, User, UserSession
from accounts.security import issue_action_token

from .conftest import authenticated
from .test_organization_scoped_accounts import NEW_PASSWORD, PASSWORD, login, other_account

pytestmark = pytest.mark.django_db(transaction=True)


@pytest.fixture(autouse=True)
def isolated_postgres(monkeypatch):
    assert connection.vendor == "postgresql", "Organization login races require PostgreSQL"
    cache.clear()
    monkeypatch.setattr("accounts.services._publish_outbox_email", lambda outbox_id: None)


@pytest.mark.parametrize("replacement", ["complete", "regenerate", "reset"])
def test_login_cannot_reuse_password_proof_after_concurrent_credential_replacement(
    admin, monkeypatch, replacement
):
    if replacement == "reset":
        member = other_account("race-identity@example.test")
        password = PASSWORD
        _, reset_token = issue_action_token(member, ActionToken.Kind.RESET_PASSWORD, hours=1)
    else:
        created = authenticated(admin).post(
            "/api/users/temporary-password",
            {
                "email": "race-identity@example.test",
                "name": "Race fixture",
                "role": "Operations",
            },
            format="json",
        )
        assert created.status_code == 201
        member = User.objects.get(pk=created.data["user"]["id"])
        password = created.data["temporaryPassword"]
        initial = login(member.email, password, member.organization_id)
        assert initial.status_code == 202
        change_token = initial.data["passwordChangeToken"]

    selected = threading.Event()
    replaced = threading.Event()
    proof = EmailBackend.password_proven_accounts
    outcomes = {}

    def wait_after_initial_proof(*args, **kwargs):
        matches = proof(*args, **kwargs)
        assert len(matches) == 1 and matches[0].pk == member.pk
        selected.set()
        assert replaced.wait(timeout=10), "Concurrent credential replacement did not finish"
        return matches

    monkeypatch.setattr(EmailBackend, "password_proven_accounts", wait_after_initial_proof)

    def old_login():
        close_old_connections()
        try:
            client = APIClient()
            outcomes["login"] = login(
                member.email, password, member.organization_id, client=client
            ).status_code
            outcomes["access"] = client.get("/api/users").status_code
        except Exception as exc:
            outcomes["error"] = type(exc).__name__
        finally:
            close_old_connections()

    thread = threading.Thread(target=old_login)
    thread.start()
    try:
        assert selected.wait(timeout=10), "Initial credential proof did not finish"
        if replacement == "complete":
            result = APIClient().post(
                "/api/auth/complete-temporary-password",
                {
                    "token": change_token,
                    "password": NEW_PASSWORD,
                },
                format="json",
            )
            assert result.status_code == 200
        elif replacement == "regenerate":
            result = authenticated(admin).post(
                f"/api/users/{member.pk}/temporary-password", {}, format="json"
            )
            assert result.status_code == 201
        else:
            result = APIClient().post(
                "/api/auth/reset-password",
                {
                    "token": reset_token,
                    "password": NEW_PASSWORD,
                },
                format="json",
            )
            assert result.status_code == 200
    finally:
        replaced.set()
        thread.join(timeout=15)
    assert not thread.is_alive() and "error" not in outcomes, outcomes
    assert outcomes == {"login": 401, "access": 403}
    # Only the separate successful first-password completion may issue a session.
    assert UserSession.objects.filter(user=member).count() == (replacement == "complete")
