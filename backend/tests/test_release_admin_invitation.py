from __future__ import annotations

import json
from datetime import timedelta
from io import StringIO
from urllib.parse import parse_qs, urlparse

import pytest
from django.test import override_settings
from django.core.management import CommandError, call_command

from accounts.models import EmailOutbox, Invitation, User
from accounts.security import decrypt_secret

from .conftest import authenticated

pytestmark = pytest.mark.django_db


def issue(admin, organization, *, email="release-admin@example.test"):
    output = StringIO()
    call_command(
        "issue_release_admin_invitation",
        organization_id=organization.id,
        invited_by=admin.email,
        email=email,
        name="Release Administrator",
        stdout=output,
    )
    return output.getvalue()


def test_release_admin_invitation_is_single_use_and_valid_for_24_hours(
    admin, organization
):
    output = issue(admin, organization)
    invitation = Invitation.objects.get(email="release-admin@example.test")
    outbox = EmailOutbox.objects.get(idempotency_key=f"release-admin-invite:{invitation.id}")

    assert invitation.role == User.Role.ADMIN
    assert invitation.status == Invitation.Status.PENDING
    assert timedelta(hours=24) - timedelta(seconds=1) <= (
        invitation.expires_at - invitation.created_at
    ) <= timedelta(hours=24)
    assert "token=" not in output
    assert "no invitation secret was printed" in output
    assert "ciphertext" in outbox.context
    assert "token" not in str(outbox.context).lower()


def test_release_admin_invitation_rotates_an_existing_pending_invitation(
    admin, organization
):
    issue(admin, organization)
    first = Invitation.objects.get(email="release-admin@example.test")
    issue(admin, organization)

    first.refresh_from_db()
    assert first.status == Invitation.Status.REVOKED
    assert Invitation.objects.filter(
        email="release-admin@example.test", status=Invitation.Status.PENDING
    ).count() == 1


def test_release_admin_invitation_refuses_existing_user(admin, organization):
    with pytest.raises(CommandError, match="already exists"):
        issue(admin, organization, email=admin.email)


@override_settings(EMAIL_DELIVERY_BACKEND="disabled", RESEND_API_KEY="")
def test_release_admin_invitation_refuses_unconfigured_delivery(admin, organization):
    with pytest.raises(CommandError, match="Verified Resend delivery"):
        issue(admin, organization)
    assert not Invitation.objects.exists()


def test_release_admin_invitation_requires_active_admin_inviter(
    viewer, organization
):
    with pytest.raises(CommandError, match="active Admin"):
        output = StringIO()
        call_command(
            "issue_release_admin_invitation",
            organization_id=organization.id,
            invited_by=viewer.email,
            email="release-admin@example.test",
            name="Release Administrator",
            stdout=output,
        )
    assert not Invitation.objects.exists()


def test_release_admin_invitation_acceptance_is_single_use_and_sets_password(
    admin, organization
):
    issue(admin, organization)
    invitation = Invitation.objects.get(email="release-admin@example.test")
    outbox = EmailOutbox.objects.get(idempotency_key=f"release-admin-invite:{invitation.id}")
    context = json.loads(decrypt_secret(outbox.context["ciphertext"]))
    token = parse_qs(urlparse(context["actionUrl"]).query)["token"][0]
    client = authenticated(admin)
    payload = {
        "token": token,
        "name": "Release Administrator",
        "password": "A-strong-release-admin-password-2026!",
    }

    accepted = client.post("/api/invitations/accept", payload, format="json")
    repeated = client.post("/api/invitations/accept", payload, format="json")

    assert accepted.status_code == 201
    assert repeated.status_code == 400
    created = User.objects.get(email="release-admin@example.test")
    assert created.role == User.Role.ADMIN
    assert created.check_password(payload["password"])
    invitation.refresh_from_db()
    assert invitation.status == Invitation.Status.ACCEPTED
