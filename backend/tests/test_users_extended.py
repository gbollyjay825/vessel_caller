from __future__ import annotations

import pytest
from django.utils import timezone

from accounts.models import Invitation, User
from accounts.security import encrypt_secret

from .conftest import authenticated

pytestmark = pytest.mark.django_db


def test_user_lifecycle_admin_actions_and_audit(admin, viewer):
    client = authenticated(admin)
    viewer.mfa_secret = encrypt_secret("JBSWY3DPEHPK3PXP")
    viewer.mfa_enabled_at = timezone.now()
    viewer.save()
    changed = client.patch(
        f"/api/users/{viewer.id}",
        {"name": "Updated Viewer", "role": "Operations"},
        format="json",
    )
    assert changed.status_code == 200
    assert changed.json()["user"]["role"] == "Operations"
    assert client.post(f"/api/users/{viewer.id}/send-password-reset").status_code == 202
    reset_mfa = client.post(f"/api/users/{viewer.id}/reset-mfa")
    assert reset_mfa.status_code == 200
    assert reset_mfa.json()["user"]["mfaEnabled"] is False
    assert client.delete(f"/api/users/{viewer.id}").status_code == 200
    viewer.refresh_from_db()
    assert viewer.status == User.Status.REMOVED
    assert viewer.email.endswith("@invalid.local")
    audit = client.get("/api/audit?search=Viewer")
    assert audit.status_code == 200
    assert audit.json()["count"] >= 1
    exported = client.get("/api/audit/export")
    assert exported.status_code == 200
    assert exported["Content-Type"].startswith("text/csv")


def test_invitation_list_resend_revoke_and_filters(admin):
    client = authenticated(admin)
    first = client.post(
        "/api/invitations",
        {"name": "Invite One", "email": "one@invite.test", "role": "Viewer"},
        format="json",
    ).json()["invitation"]
    listing = client.get("/api/invitations?pageSize=10")
    assert listing.status_code == 200
    assert listing.json()["count"] == 1
    resent = client.post(f"/api/invitations/{first['id']}/resend")
    assert resent.status_code == 200
    assert client.delete(f"/api/invitations/{first['id']}").status_code == 204
    invitation = Invitation.objects.get(pk=first["id"])
    assert invitation.status == Invitation.Status.REVOKED
    filtered = client.get("/api/users?search=admin&role=Admin&status=active")
    assert filtered.status_code == 200
    assert filtered.json()["count"] == 1
