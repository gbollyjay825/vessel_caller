from __future__ import annotations

import threading

import pytest
from django.db import close_old_connections, connection, transaction
from django.core.cache import cache
from django.utils import timezone
from rest_framework.test import APIClient

from accounts.models import EmailOutbox, OrganizationJoinRequest, User
from audit.models import AuditEvent
from organizations.models import Organization

from .conftest import authenticated
from .test_organization_join import PASSWORD, create_link, verified_request

pytestmark = pytest.mark.django_db(transaction=True)


@pytest.fixture(autouse=True)
def postgres_required(monkeypatch):
    if connection.vendor != "postgresql":
        pytest.skip("Organization join locking and unique-email races require PostgreSQL")
    cache.clear()
    # Exercise database races without eager email delivery consuming/redacting
    # the verification capability before the test can follow it.
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
            outcomes[f"{label}_error"] = exc
        finally:
            close_old_connections()

    first = threading.Thread(target=execute, args=("first", first_call))
    second = threading.Thread(target=execute, args=("second", second_call))
    first.start()
    second.start()
    first.join(timeout=15)
    second.join(timeout=15)
    assert not first.is_alive() and not second.is_alive()
    assert "first_error" not in outcomes, outcomes
    assert "second_error" not in outcomes, outcomes
    return outcomes


def test_simultaneous_approvals_create_one_user_notice_and_audit(admin):
    _, _, join_request = verified_request(admin)

    def approve():
        actor = User.objects.get(pk=admin.pk)
        return (
            authenticated(actor)
            .post(
                f"/api/organization-join-requests/{join_request.id}/approve",
                {"role": "Operations"},
                format="json",
            )
            .status_code
        )

    outcomes = parallel_calls(approve, approve)
    assert outcomes == {"first": 200, "second": 200}
    assert User.objects.filter(email=join_request.email).count() == 1
    assert (
        EmailOutbox.objects.filter(
            idempotency_key=f"organization-join-approved:{join_request.id}"
        ).count()
        == 1
    )
    assert (
        AuditEvent.objects.filter(
            action="organization_join.approved", target_id=join_request.id
        ).count()
        == 1
    )


def test_simultaneous_cross_tenant_signup_cannot_reserve_email_twice(admin):
    _, first_raw, _ = create_link(admin)
    other_org = Organization.objects.create(
        name="Other", email="other@example.test", registered=True
    )
    other = User.objects.create_user(
        email="other@example.test",
        password=PASSWORD,
        name="Other",
        organization=other_org,
        role="Admin",
        status="active",
        email_verified_at=timezone.now(),
    )
    _, second_raw, _ = create_link(other)

    def submit(raw):
        return (
            APIClient()
            .post(
                "/api/organization-join",
                {
                    "token": raw,
                    "name": "Applicant",
                    "email": "concurrent@example.test",
                    "password": PASSWORD,
                },
                format="json",
            )
            .status_code
        )

    outcomes = parallel_calls(lambda: submit(first_raw), lambda: submit(second_raw))
    assert outcomes == {"first": 202, "second": 202}
    assert OrganizationJoinRequest.objects.filter(email="concurrent@example.test").count() == 1
    assert EmailOutbox.objects.filter(to_email="concurrent@example.test").count() == 1
    assert not User.objects.filter(email="concurrent@example.test").exists()


def test_simultaneous_link_creation_leaves_one_unrevoked_link(admin):
    def create():
        actor = User.objects.get(pk=admin.pk)
        return (
            authenticated(actor)
            .post("/api/organization-signup-links", {"expiresInDays": 7}, format="json")
            .status_code
        )

    outcomes = parallel_calls(create, create)
    assert outcomes == {"first": 201, "second": 201}
    assert admin.organization.signup_links.filter(revoked_at__isnull=True).count() == 1
    assert admin.organization.signup_links.count() == 2


def test_waiting_approval_reloads_suspended_tenant_before_access_grant(admin):
    _, _, join_request = verified_request(admin)
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
                organization.suspension_reason = "Concurrent suspension test"
                organization.save(
                    update_fields=("access_status", "suspended_at", "suspension_reason")
                )
                locked.set()
                assert release_lock.wait(timeout=10)
        except Exception as exc:
            outcomes["suspend_error"] = exc
        finally:
            close_old_connections()

    def approve():
        close_old_connections()
        try:
            actor = User.objects.select_related("organization").get(pk=admin.pk)
            started.set()
            outcomes["approval"] = (
                authenticated(actor)
                .post(
                    f"/api/organization-join-requests/{join_request.id}/approve", {}, format="json"
                )
                .status_code
            )
        except Exception as exc:
            outcomes["approval_error"] = exc
        finally:
            close_old_connections()

    first = threading.Thread(target=suspend)
    second = threading.Thread(target=approve)
    first.start()
    assert locked.wait(timeout=10)
    second.start()
    assert started.wait(timeout=10)
    release_lock.set()
    first.join(timeout=15)
    second.join(timeout=15)
    assert not first.is_alive() and not second.is_alive()
    assert outcomes == {"approval": 403}, outcomes
    assert not User.objects.filter(email=join_request.email).exists()
    join_request.refresh_from_db()
    assert join_request.status == "pending"
