from __future__ import annotations

import threading
import time

import pytest
from django.test import override_settings
from django.db import close_old_connections, connection, transaction
from django.utils import timezone

from accounts.models import Invitation, User
from accounts.security import token_hash

from .conftest import authenticated

pytestmark = pytest.mark.django_db


def test_user_permissions_and_last_admin_protection(admin, viewer):
    viewer_client = authenticated(viewer)
    assert viewer_client.get("/api/users").status_code == 403
    admin_client = authenticated(admin)
    listing = admin_client.get("/api/users")
    assert listing.status_code == 200
    assert listing.json()["count"] == 2
    self_demote = admin_client.patch(f"/api/users/{admin.id}", {"role": "Viewer"}, format="json")
    assert self_demote.status_code == 400


@pytest.mark.django_db(transaction=True)
def test_concurrent_admin_changes_cannot_remove_every_active_admin(admin):
    if connection.vendor != "postgresql":
        pytest.skip("Row-lock concurrency semantics require PostgreSQL")
    second_admin = User.objects.create_user(
        organization=admin.organization,
        email="second-admin@test.example",
        password="A-strong-second-admin-password-2026!",
        name="Second Admin",
        role=User.Role.ADMIN,
        status=User.Status.ACTIVE,
        email_verified_at=timezone.now(),
    )
    first_change_locked = threading.Event()
    allow_first_change = threading.Event()
    second_change_started = threading.Event()
    outcomes: dict[str, object] = {}

    def demote_second_admin_while_holding_organization_lock():
        close_old_connections()
        try:
            with transaction.atomic():
                organization = admin.organization.__class__.objects.select_for_update().get(
                    pk=admin.organization_id
                )
                member = User.objects.select_for_update().get(
                    pk=second_admin.pk,
                    organization=organization,
                )
                first_change_locked.set()
                if not allow_first_change.wait(timeout=5):
                    raise TimeoutError("Timed out waiting to release the first Admin change")
                member.role = User.Role.VIEWER
                member.save(update_fields=("role", "updated_at"))
        except Exception as exc:  # pragma: no cover - surfaced by the assertion below
            outcomes["first_error"] = exc
        finally:
            close_old_connections()

    def try_to_demote_the_remaining_admin():
        close_old_connections()
        try:
            actor = User.objects.get(pk=second_admin.pk)
            client = authenticated(actor)
            second_change_started.set()
            outcomes["second_status"] = client.patch(
                f"/api/users/{admin.id}",
                {"role": User.Role.VIEWER},
                format="json",
            ).status_code
        except Exception as exc:  # pragma: no cover - surfaced by the assertion below
            outcomes["second_error"] = exc
        finally:
            close_old_connections()

    first = threading.Thread(target=demote_second_admin_while_holding_organization_lock)
    second = threading.Thread(target=try_to_demote_the_remaining_admin)
    first.start()
    assert first_change_locked.wait(timeout=5)
    second.start()
    assert second_change_started.wait(timeout=5)
    time.sleep(0.2)
    allow_first_change.set()
    first.join(timeout=5)
    second.join(timeout=5)

    assert not first.is_alive()
    assert not second.is_alive()
    assert "first_error" not in outcomes
    assert "second_error" not in outcomes
    assert outcomes["second_status"] == 400
    assert (
        User.objects.filter(
            organization=admin.organization,
            role=User.Role.ADMIN,
            status=User.Status.ACTIVE,
        ).count()
        == 1
    )


def test_invitation_accept_and_suspend_revokes_sessions(admin):
    client = authenticated(admin)
    created = client.post(
        "/api/invitations",
        {"name": "Finance Invite", "email": "invite@acme.test", "role": "Finance"},
        format="json",
    )
    assert created.status_code == 201
    invitation = Invitation.objects.get(pk=created.json()["invitation"]["id"])
    raw = "known-invitation-token"
    invitation.token_hash = token_hash(raw)
    invitation.save(update_fields=("token_hash",))
    public = authenticated(admin)
    public.force_authenticate(user=None)
    accepted = public.post(
        "/api/invitations/accept",
        {"token": raw, "password": "A-strong-invite-password-2026!"},
        format="json",
    )
    assert accepted.status_code == 201
    member = User.objects.get(email="invite@acme.test")
    assert member.role == User.Role.FINANCE
    updated = client.patch(f"/api/users/{member.id}", {"status": "suspended"}, format="json")
    assert updated.status_code == 200
    assert updated.json()["user"]["status"] == "suspended"


@override_settings(EMAIL_DELIVERY_BACKEND="disabled")
def test_internal_admin_testing_rejects_email_user_actions_before_mutation(admin):
    client = authenticated(admin)
    invitation = client.post(
        "/api/invitations",
        {"name": "Blocked Invite", "email": "blocked-invite@acme.test", "role": "Viewer"},
        format="json",
    )

    assert invitation.status_code == 503
    assert not Invitation.objects.filter(email="blocked-invite@acme.test").exists()
    assert (
        client.post(f"/api/users/{admin.id}/send-password-reset", format="json").status_code == 503
    )


def test_tenant_scope_hides_other_organization(admin):
    other_org = admin.organization.__class__.objects.create(
        name="Other", registered=True, email="other@test"
    )
    from organizations.models import OrganizationSettings

    OrganizationSettings.objects.create(organization=other_org)
    other = User.objects.create_user(
        organization=other_org,
        email="other-user@test.example",
        password="A-strong-other-password-2026!",
        name="Other User",
        role=User.Role.VIEWER,
        status=User.Status.ACTIVE,
        email_verified_at=timezone.now(),
    )
    client = authenticated(admin)
    assert (
        client.patch(f"/api/users/{other.id}", {"status": "suspended"}, format="json").status_code
        == 404
    )
