from __future__ import annotations

import threading

import pytest
from django.core.cache import cache
from django.db import close_old_connections, connection, transaction
from django.utils import timezone
from rest_framework.test import APIClient

from accounts.models import User, UserSession
from audit.models import AuditEvent
from organizations.models import Organization

from .conftest import authenticated
from .test_temporary_passwords import NEW_PASSWORD, challenge, complete, provision

pytestmark = pytest.mark.django_db(transaction=True)


@pytest.fixture(autouse=True)
def postgres_required(monkeypatch):
    assert connection.vendor == "postgresql", "Temporary-password races require PostgreSQL"
    cache.clear()
    monkeypatch.setattr("accounts.services._publish_outbox_email", lambda outbox_id: None)


def parallel_calls(first_call, second_call):
    ready = threading.Barrier(2)
    outcomes = {}

    def execute(label, call):
        close_old_connections()
        try:
            ready.wait(timeout=10)
            outcomes[label] = call()
        except Exception as exc:
            outcomes[f"{label}_error"] = type(exc).__name__
        finally:
            close_old_connections()

    first = threading.Thread(target=execute, args=("first", first_call))
    second = threading.Thread(target=execute, args=("second", second_call))
    first.start()
    second.start()
    first.join(timeout=15)
    second.join(timeout=15)
    assert not first.is_alive() and not second.is_alive()
    assert "first_error" not in outcomes and "second_error" not in outcomes, outcomes
    return outcomes


@pytest.mark.parametrize("cross_tenant", [False, True])
def test_duplicate_creation_is_single_user_and_single_audit(admin, cross_tenant):
    second_id = admin.pk
    if cross_tenant:
        organization = Organization.objects.create(
            name="Other", email="other@example.test", registered=True
        )
        second = User.objects.create_user(
            email="other@example.test",
            password=NEW_PASSWORD,
            name="Other Admin",
            organization=organization,
            role="Admin",
            status="active",
            email_verified_at=timezone.now(),
        )
        second_id = second.pk

    def create(actor_id):
        return (
            authenticated(User.objects.get(pk=actor_id))
            .post(
                "/api/users/temporary-password",
                {"name": "Concurrent", "email": "concurrent@example.test", "role": "Operations"},
                format="json",
            )
            .status_code
        )

    outcomes = parallel_calls(lambda: create(admin.pk), lambda: create(second_id))
    assert sorted(outcomes.values()) == [201, 400]
    assert User.objects.filter(email="concurrent@example.test").count() == 1
    assert (
        AuditEvent.objects.filter(
            action="user.admin_provisioned", target_label="concurrent@example.test"
        ).count()
        == 1
    )


def test_password_change_capability_has_only_one_winner_and_session(admin):
    user, raw, _ = provision(admin)
    _, token, _ = challenge(user, raw)
    outcomes = parallel_calls(
        lambda: complete(APIClient(), token).status_code,
        lambda: complete(APIClient(), token).status_code,
    )
    assert sorted(outcomes.values()) == [200, 400]
    assert UserSession.objects.filter(user=user).count() == 1
    assert (
        AuditEvent.objects.filter(
            action="account.temporary_password_replaced", target_id=user.pk
        ).count()
        == 1
    )


def test_regeneration_and_first_password_change_cannot_overwrite_an_activated_user(admin):
    user, raw, _ = provision(admin)
    _, token, _ = challenge(user, raw)

    def regenerate():
        return (
            authenticated(User.objects.get(pk=admin.pk))
            .post(
                f"/api/users/{user.id}/temporary-password",
                {},
                format="json",
            )
            .status_code
        )

    outcomes = parallel_calls(regenerate, lambda: complete(APIClient(), token).status_code)
    assert outcomes in (
        {"first": 201, "second": 400},
        {"first": 400, "second": 200},
    ), outcomes
    user.refresh_from_db()
    if outcomes["second"] == 200:
        assert user.check_password(NEW_PASSWORD) and not user.password_change_required
    else:
        assert user.password_change_required and not user.check_password(raw)


def test_tenant_suspension_wins_before_pending_create_or_password_change(admin):
    user, raw, _ = provision(admin)
    _, token, _ = challenge(user, raw)
    locked = threading.Event()
    release_lock = threading.Event()
    started = threading.Event()
    outcomes = {}

    def suspend():
        close_old_connections()
        try:
            with transaction.atomic():
                organization = Organization.objects.select_for_update().get(
                    pk=admin.organization_id
                )
                organization.access_status = Organization.AccessStatus.SUSPENDED
                organization.suspended_at = timezone.now()
                organization.suspension_reason = "Concurrent temporary-password test"
                organization.save()
                locked.set()
                assert release_lock.wait(timeout=10)
        except Exception as exc:
            outcomes["suspend_error"] = type(exc).__name__
        finally:
            close_old_connections()

    def access():
        close_old_connections()
        try:
            actor = User.objects.select_related("organization").get(pk=admin.pk)
            started.set()
            outcomes["create"] = (
                authenticated(actor)
                .post(
                    "/api/users/temporary-password",
                    {"name": "Blocked", "email": "blocked@example.test", "role": "Admin"},
                    format="json",
                )
                .status_code
            )
            outcomes["complete"] = complete(APIClient(), token).status_code
        except Exception as exc:
            outcomes["access_error"] = type(exc).__name__
        finally:
            close_old_connections()

    first = threading.Thread(target=suspend)
    second = threading.Thread(target=access)
    first.start()
    assert locked.wait(timeout=10)
    second.start()
    assert started.wait(timeout=10)
    release_lock.set()
    first.join(timeout=15)
    second.join(timeout=15)
    assert not first.is_alive() and not second.is_alive()
    assert outcomes == {"create": 403, "complete": 400}, outcomes
    assert not User.objects.filter(email="blocked@example.test").exists()
    assert not UserSession.objects.filter(user=user).exists()
