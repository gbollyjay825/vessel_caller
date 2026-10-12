from __future__ import annotations

import json
from datetime import timedelta
from urllib.parse import parse_qs, urlparse

import pytest
from django.core.cache import cache
from django.utils import timezone
from rest_framework.test import APIClient

from accounts.models import EmailOutbox, OrganizationJoinRequest, OrganizationSignupLink, User
from accounts.security import decrypt_secret, token_hash
from accounts.tasks import deliver_outbox_email
from audit.models import AuditEvent
from organizations.models import Organization

from .conftest import authenticated

pytestmark = pytest.mark.django_db
PASSWORD = "A-distinct-applicant-password-2026!"


@pytest.fixture(autouse=True)
def clear_join_throttle_cache():
    cache.clear()
    yield
    cache.clear()


def create_link(admin, *, days=7):
    response = authenticated(admin).post(
        "/api/organization-signup-links", {"expiresInDays": days}, format="json"
    )
    assert response.status_code == 201, response.data
    data = response.json()
    raw = parse_qs(urlparse(data["signupUrl"]).fragment)["token"][0]
    return OrganizationSignupLink.objects.get(pk=data["link"]["id"]), raw, data


def submit(raw, *, email="applicant@example.test", name="New Applicant", password=None):
    return APIClient().post(
        "/api/organization-join",
        {
            "token": raw,
            "name": name,
            "email": email,
            **({"password": password} if password is not None else {}),
        },
        format="json",
    )


def verification_token(join_request):
    outbox = EmailOutbox.objects.get(idempotency_key=f"organization-join-verify:{join_request.id}")
    context = json.loads(decrypt_secret(outbox.context["ciphertext"]))
    return parse_qs(urlparse(context["actionUrl"]).fragment)["token"][0], outbox


def verified_request(admin, *, email="applicant@example.test"):
    link, raw, _ = create_link(admin)
    assert submit(raw, email=email).status_code == 202
    join_request = OrganizationJoinRequest.objects.get(email=email)
    verification, _ = verification_token(join_request)
    response = APIClient().post(
        "/api/organization-join/verify",
        {"token": verification, "password": PASSWORD},
        format="json",
    )
    assert response.status_code == 200, response.data
    join_request.refresh_from_db()
    return link, raw, join_request


@pytest.mark.parametrize("role", User.Role.values)
def test_full_verified_review_login_flow_and_role_permissions(admin, role):
    from api.permissions import ROLE_PERMISSIONS

    _, _, join_request = verified_request(admin)
    assert join_request.status == "pending"
    assert join_request.email_verified_at
    assert join_request.verification_token_hash is None
    assert not User.objects.filter(email=join_request.email).exists()
    public = APIClient()
    assert (
        public.post(
            "/api/auth/login", {"email": join_request.email, "password": PASSWORD}, format="json"
        ).status_code
        == 401
    )
    approval = authenticated(admin).post(
        f"/api/organization-join-requests/{join_request.id}/approve", {"role": role}, format="json"
    )
    assert approval.status_code == 200, approval.data
    member = User.objects.get(email=join_request.email)
    assert member.organization_id == admin.organization_id
    assert member.role == role
    assert member.email_verified_at
    assert member.check_password(PASSWORD)
    assert not member.is_staff and not member.is_superuser
    assert bool(member.mfa_grace_ends_at) == (role in {"Admin", "Finance"})
    join_request.refresh_from_db()
    assert join_request.password_hash == ""
    assert join_request.user_id == member.id
    assert join_request.status == "approved"
    signed_in = public.post(
        "/api/auth/login", {"email": member.email, "password": PASSWORD}, format="json"
    )
    assert signed_in.status_code == 200, signed_in.data
    assert set(signed_in.json()["permissions"]) == ROLE_PERMISSIONS[role]
    me = public.get("/api/auth/me")
    assert me.status_code == 200
    assert me.json()["org"]["id"] == admin.organization_id
    assert public.get("/api/users").status_code == (200 if role == "Admin" else 403)
    assert public.post(
        "/api/organization-signup-links", {"expiresInDays": 7}, format="json"
    ).status_code == (201 if role == "Admin" else 403)
    outbox = EmailOutbox.objects.get(
        idempotency_key=f"organization-join-approved:{join_request.id}"
    )
    assert outbox.organization_id == admin.organization_id


def test_default_approval_is_operations_and_public_role_injection_is_ignored(admin):
    _, raw, _ = create_link(admin)
    response = APIClient().post(
        "/api/organization-join",
        {
            "token": raw,
            "name": "Applicant",
            "email": "applicant@example.test",
            "password": PASSWORD,
            "role": "Admin",
            "organizationId": "other",
        },
        format="json",
    )
    assert response.status_code == 202
    join_request = OrganizationJoinRequest.objects.get(email="applicant@example.test")
    verification, _ = verification_token(join_request)
    assert (
        APIClient()
        .post(
            "/api/organization-join/verify",
            {"token": verification, "password": PASSWORD},
            format="json",
        )
        .status_code
        == 200
    )
    assert (
        authenticated(admin)
        .post(f"/api/organization-join-requests/{join_request.id}/approve", {}, format="json")
        .status_code
        == 200
    )
    assert User.objects.get(email=join_request.email).role == "Operations"


def test_unverified_request_has_no_user_access_and_cannot_be_approved(admin):
    _, raw, _ = create_link(admin)
    assert submit(raw).status_code == 202
    join_request = OrganizationJoinRequest.objects.get(email="applicant@example.test")
    assert join_request.status == "unverified"
    assert join_request.password_hash == ""
    response = authenticated(admin).post(
        f"/api/organization-join-requests/{join_request.id}/approve",
        {"role": "Admin"},
        format="json",
    )
    assert response.status_code == 400
    assert not User.objects.filter(email=join_request.email).exists()
    assert authenticated(admin).get("/api/organization-join-requests").json()["count"] == 0
    assert (
        authenticated(admin).get("/api/organization-join-requests?status=all").json()["count"] == 1
    )


def test_preempting_signup_cannot_set_the_verified_recipients_password(admin):
    _, raw, _ = create_link(admin)
    attacker_password = "Attacker-known-untrusted-password-2026!"
    victim_password = "Recipient-chosen-private-password-2026!"
    # A bearer of the shared link can propose an email, but cannot nominate
    # that recipient's password even if a password field is injected.
    assert submit(raw, password=attacker_password).status_code == 202
    join_request = OrganizationJoinRequest.objects.get(email="applicant@example.test")
    assert join_request.password_hash == ""
    assert submit(raw, password=victim_password).status_code == 202
    join_request.refresh_from_db()
    assert join_request.password_hash == ""
    verification, _ = verification_token(join_request)
    verified = APIClient().post(
        "/api/organization-join/verify",
        {"token": verification, "password": victim_password},
        format="json",
    )
    assert verified.status_code == 200
    join_request.refresh_from_db()
    assert join_request.password_hash != ""
    # Only possession of the emailed verification capability can set the
    # final password, and its replay cannot overwrite the selected hash.
    assert (
        APIClient()
        .post(
            "/api/organization-join/verify",
            {"token": verification, "password": attacker_password},
            format="json",
        )
        .status_code
        == 400
    )
    assert (
        authenticated(admin)
        .post(f"/api/organization-join-requests/{join_request.id}/approve", {}, format="json")
        .status_code
        == 200
    )
    member = User.objects.get(email=join_request.email)
    assert member.check_password(victim_password)
    assert not member.check_password(attacker_password)
    assert (
        APIClient()
        .post(
            "/api/auth/login", {"email": member.email, "password": attacker_password}, format="json"
        )
        .status_code
        == 401
    )
    assert (
        APIClient()
        .post(
            "/api/auth/login", {"email": member.email, "password": victim_password}, format="json"
        )
        .status_code
        == 200
    )


def test_failed_password_or_token_verification_does_not_set_hash_or_consume_token(admin):
    _, raw, _ = create_link(admin)
    assert submit(raw).status_code == 202
    join_request = OrganizationJoinRequest.objects.get(email="applicant@example.test")
    verification, _ = verification_token(join_request)
    public = APIClient()
    assert (
        public.post(
            "/api/organization-join/verify", {"token": verification}, format="json"
        ).status_code
        == 400
    )
    assert (
        public.post(
            "/api/organization-join/verify",
            {"token": verification, "password": "123"},
            format="json",
        ).status_code
        == 400
    )
    assert (
        public.post(
            "/api/organization-join/verify",
            {"token": "wrong-token", "password": PASSWORD},
            format="json",
        ).status_code
        == 400
    )
    join_request.refresh_from_db()
    assert join_request.password_hash == "" and join_request.status == "unverified"
    assert join_request.verification_token_hash == token_hash(verification)
    assert (
        public.post(
            "/api/organization-join/verify",
            {"token": verification, "password": PASSWORD},
            format="json",
        ).status_code
        == 200
    )


def test_link_resolves_organization_only_and_hashes_all_capabilities(admin):
    link, raw, created = create_link(admin)
    assert link.token_hash == token_hash(raw)
    assert "#token=" in created["signupUrl"]
    public = APIClient()
    response = public.post("/api/organization-join/resolve", {"token": raw}, format="json")
    assert response.status_code == 200
    assert response.json()["organization"] == {"name": admin.organization.name}
    assert "email" not in response.json()["organization"]
    listing = authenticated(admin).get("/api/organization-signup-links").json()
    assert raw not in json.dumps(listing)
    assert "signupUrl" not in json.dumps(listing)
    assert "token_hash" not in json.dumps(listing)
    assert raw not in json.dumps(list(AuditEvent.objects.values("before", "after")))
    assert public.get(f"/api/organization-join?token={raw}").status_code == 405


@pytest.mark.parametrize("role_fixture", ["operations", "finance", "viewer"])
def test_only_admin_can_manage_links_and_requests(admin, request, role_fixture):
    _, _, join_request = verified_request(admin)
    client = authenticated(request.getfixturevalue(role_fixture))
    for endpoint in ["/api/organization-signup-links", "/api/organization-join-requests"]:
        assert client.get(endpoint).status_code == 403
    assert client.post("/api/organization-signup-links", {}, format="json").status_code == 403
    assert (
        client.post(
            f"/api/organization-join-requests/{join_request.id}/approve", {}, format="json"
        ).status_code
        == 403
    )
    assert (
        client.post(
            f"/api/organization-join-requests/{join_request.id}/reject", {}, format="json"
        ).status_code
        == 403
    )


def test_tenant_scope_hides_other_organizations_join_records(admin):
    link, _, join_request = verified_request(admin)
    other_org = Organization.objects.create(
        name="Other", email="other@example.test", registered=True
    )
    other = User.objects.create_user(
        email="other@example.test",
        password=PASSWORD,
        name="Other Admin",
        organization=other_org,
        role="Admin",
        status="active",
        email_verified_at=timezone.now(),
    )
    client = authenticated(other)
    assert client.get("/api/organization-signup-links").json()["count"] == 0
    assert client.get("/api/organization-join-requests?status=all").json()["count"] == 0
    assert client.delete(f"/api/organization-signup-links/{link.id}").status_code == 404
    assert (
        client.post(
            f"/api/organization-join-requests/{join_request.id}/approve", {}, format="json"
        ).status_code
        == 404
    )
    assert (
        client.post(
            f"/api/organization-join-requests/{join_request.id}/reject", {}, format="json"
        ).status_code
        == 404
    )


@pytest.mark.parametrize("change", ["expired", "revoked", "replaced", "organization_suspended"])
def test_invalidated_link_rejects_resolve_submit_and_email_verification(admin, change):
    link, raw, _ = create_link(admin)
    assert submit(raw).status_code == 202
    join_request = OrganizationJoinRequest.objects.get(email="applicant@example.test")
    verification, _ = verification_token(join_request)
    if change == "expired":
        link.expires_at = timezone.now() - timedelta(seconds=1)
        link.save(update_fields=("expires_at",))
    elif change == "revoked":
        assert (
            authenticated(admin).delete(f"/api/organization-signup-links/{link.id}").status_code
            == 204
        )
    elif change == "replaced":
        _, replacement, _ = create_link(admin)
        assert replacement != raw
    else:
        admin.organization.access_status = Organization.AccessStatus.SUSPENDED
        admin.organization.suspended_at = timezone.now()
        admin.organization.suspension_reason = "Test lifecycle suspension"
        admin.organization.save(
            update_fields=("access_status", "suspended_at", "suspension_reason")
        )
    public = APIClient()
    assert (
        public.post("/api/organization-join/resolve", {"token": raw}, format="json").status_code
        == 400
    )
    assert submit(raw, email="another@example.test").status_code == 400
    assert (
        public.post(
            "/api/organization-join/verify",
            {"token": verification, "password": PASSWORD},
            format="json",
        ).status_code
        == 400
    )
    assert not User.objects.filter(email=join_request.email).exists()


def test_verification_is_single_use_expiring_and_password_request_retry_is_idempotent(admin):
    _, raw, _ = create_link(admin)
    first = submit(raw)
    join_request = OrganizationJoinRequest.objects.get(email="applicant@example.test")
    original_hash = join_request.password_hash
    verification, _ = verification_token(join_request)
    retry = submit(raw, name="Replaced Name", password="Another-distinct-password-2026!")
    assert first.json() == retry.json()
    join_request.refresh_from_db()
    assert join_request.password_hash == original_hash and join_request.name == "New Applicant"
    assert OrganizationJoinRequest.objects.filter(email=join_request.email).count() == 1
    assert (
        EmailOutbox.objects.filter(
            idempotency_key=f"organization-join-verify:{join_request.id}"
        ).count()
        == 1
    )
    public = APIClient()
    assert (
        public.post(
            "/api/organization-join/verify",
            {"token": verification, "password": PASSWORD},
            format="json",
        ).status_code
        == 200
    )
    assert (
        public.post(
            "/api/organization-join/verify",
            {"token": verification, "password": PASSWORD},
            format="json",
        ).status_code
        == 400
    )


def test_expired_unverified_request_can_be_recreated_without_email_reservation(admin):
    _, raw, _ = create_link(admin)
    assert submit(raw).status_code == 202
    old = OrganizationJoinRequest.objects.get(email="applicant@example.test")
    verification, _ = verification_token(old)
    old.verification_expires_at = timezone.now() - timedelta(seconds=1)
    old.save(update_fields=("verification_expires_at",))
    assert (
        APIClient()
        .post(
            "/api/organization-join/verify",
            {"token": verification, "password": PASSWORD},
            format="json",
        )
        .status_code
        == 400
    )
    assert submit(raw).status_code == 202
    old.refresh_from_db()
    assert (
        old.status == "expired" and old.password_hash == "" and old.verification_token_hash is None
    )
    assert OrganizationJoinRequest.objects.filter(email=old.email, status="unverified").count() == 1


def test_unverified_applicant_can_resubmit_after_replacing_the_shared_link(admin):
    _, raw, _ = create_link(admin)
    assert submit(raw).status_code == 202
    old = OrganizationJoinRequest.objects.get(email="applicant@example.test")
    old_token, _ = verification_token(old)
    _, replacement, _ = create_link(admin)
    expired_display = authenticated(admin).get("/api/organization-join-requests?status=all").json()
    assert expired_display["results"][0]["status"] == "expired"
    assert submit(replacement).status_code == 202
    old.refresh_from_db()
    assert old.status == "expired" and old.password_hash == ""
    fresh = OrganizationJoinRequest.objects.get(email=old.email, status="unverified")
    assert fresh.pk != old.pk
    verification, _ = verification_token(fresh)
    public = APIClient()
    assert (
        public.post(
            "/api/organization-join/verify",
            {"token": old_token, "password": PASSWORD},
            format="json",
        ).status_code
        == 400
    )
    assert (
        public.post(
            "/api/organization-join/verify",
            {"token": verification, "password": PASSWORD},
            format="json",
        ).status_code
        == 200
    )


def test_existing_user_and_cross_org_request_are_private_and_never_transferred(admin, viewer):
    _, raw, _ = create_link(admin)
    existing = submit(raw, email=viewer.email)
    assert existing.status_code == 202
    assert not OrganizationJoinRequest.objects.filter(email=viewer.email).exists()
    assert not EmailOutbox.objects.filter(to_email=viewer.email).exists()
    viewer.refresh_from_db()
    assert viewer.role == "Viewer" and viewer.organization_id == admin.organization_id
    assert submit(raw).status_code == 202
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
    _, other_raw, _ = create_link(other)
    blocked = submit(other_raw)
    assert existing.json() == blocked.json()
    assert (
        OrganizationJoinRequest.objects.get(email="applicant@example.test").organization_id
        == admin.organization_id
    )
    assert not EmailOutbox.objects.filter(organization=other_org).exists()


def test_approval_replay_does_not_change_role_or_duplicate_user_notice_audit(admin):
    _, _, join_request = verified_request(admin)
    client = authenticated(admin)
    endpoint = f"/api/organization-join-requests/{join_request.id}/approve"
    first = client.post(endpoint, {"role": "Viewer"}, format="json")
    replay = client.post(endpoint, {"role": "Viewer"}, format="json")
    assert first.status_code == replay.status_code == 200
    assert first.json()["user"]["id"] == replay.json()["user"]["id"]
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
    assert client.post(endpoint, {"role": "Admin"}, format="json").status_code == 400
    assert (
        client.post(
            f"/api/organization-join-requests/{join_request.id}/reject", {}, format="json"
        ).status_code
        == 400
    )
    assert User.objects.get(email=join_request.email).role == "Viewer"


def test_rejection_clears_password_and_replay_is_safe(admin):
    _, _, join_request = verified_request(admin)
    client = authenticated(admin)
    endpoint = f"/api/organization-join-requests/{join_request.id}/reject"
    assert client.post(endpoint, {}, format="json").status_code == 200
    assert client.post(endpoint, {}, format="json").status_code == 200
    join_request.refresh_from_db()
    assert join_request.status == "rejected" and join_request.password_hash == ""
    assert join_request.reviewed_by_id == admin.id
    assert not User.objects.filter(email=join_request.email).exists()
    assert (
        AuditEvent.objects.filter(
            action="organization_join.rejected", target_id=join_request.id
        ).count()
        == 1
    )
    assert (
        client.post(
            f"/api/organization-join-requests/{join_request.id}/approve", {}, format="json"
        ).status_code
        == 400
    )


def test_approval_conflict_with_later_existing_account_preserves_identity(admin):
    _, _, join_request = verified_request(admin)
    other_org = Organization.objects.create(
        name="Other", email="other@example.test", registered=True
    )
    member = User.objects.create_user(
        email=join_request.email,
        password=PASSWORD,
        name="Existing",
        organization=other_org,
        role="Viewer",
        status="active",
        email_verified_at=timezone.now(),
    )
    response = authenticated(admin).post(
        f"/api/organization-join-requests/{join_request.id}/approve",
        {"role": "Admin"},
        format="json",
    )
    assert response.status_code == 400
    member.refresh_from_db()
    assert member.organization_id == other_org.id and member.role == "Viewer"
    join_request.refresh_from_db()
    assert join_request.status == "pending" and join_request.user_id is None


def test_revoking_link_is_idempotent_and_does_not_cancel_verified_pending_review(admin):
    link, _, join_request = verified_request(admin)
    client = authenticated(admin)
    assert client.delete(f"/api/organization-signup-links/{link.id}").status_code == 204
    assert client.delete(f"/api/organization-signup-links/{link.id}").status_code == 204
    assert (
        AuditEvent.objects.filter(
            action="organization_signup_link.revoked", target_id=link.id
        ).count()
        == 1
    )
    assert (
        client.post(
            f"/api/organization-join-requests/{join_request.id}/approve", {}, format="json"
        ).status_code
        == 200
    )


def test_csrf_is_required_on_public_resolve_submit_verify(admin):
    _, raw, _ = create_link(admin)
    public = APIClient(enforce_csrf_checks=True)
    for endpoint, body in [
        ("/api/organization-join/resolve", {"token": raw}),
        (
            "/api/organization-join",
            {
                "token": raw,
                "name": "Applicant",
                "email": "applicant@example.test",
                "password": PASSWORD,
            },
        ),
        ("/api/organization-join/verify", {"token": raw}),
    ]:
        assert public.post(endpoint, body, format="json").status_code == 403
    csrf = public.get("/api/auth/csrf").json()["csrfToken"]
    assert (
        public.post(
            "/api/organization-join/resolve", {"token": raw}, format="json", HTTP_X_CSRFTOKEN=csrf
        ).status_code
        == 200
    )


def test_validation_and_throttling_do_not_create_accounts_or_send_extra_mail(admin):
    _, raw, _ = create_link(admin)
    weak = APIClient().post(
        "/api/organization-join/verify", {"token": raw, "password": "123"}, format="json"
    )
    assert weak.status_code == 400 and "password" in weak.json()["errors"]
    assert submit(raw, email="invalid").status_code == 400
    assert (
        authenticated(admin)
        .post("/api/organization-signup-links", {"expiresInDays": 100}, format="json")
        .status_code
        == 400
    )
    assert (
        authenticated(admin).get("/api/organization-join-requests?status=garbage").status_code
        == 400
    )
    for index in range(25):
        assert submit(raw, email=f"applicant{index}@example.test").status_code == 202
    assert OrganizationJoinRequest.objects.count() == 20
    assert EmailOutbox.objects.count() == 20
    assert not User.objects.filter(email__startswith="applicant").exists()


def test_email_is_durable_encrypted_and_verification_does_not_leak_credentials(admin):
    _, raw, _ = create_link(admin)
    assert submit(raw).status_code == 202
    join_request = OrganizationJoinRequest.objects.get(email="applicant@example.test")
    verification, outbox = verification_token(join_request)
    assert "ciphertext" in outbox.context and verification not in json.dumps(outbox.context)
    assert outbox.organization_id == admin.organization_id
    provider_id = deliver_outbox_email(str(outbox.pk))
    outbox.refresh_from_db()
    assert outbox.status == "sent" and provider_id.startswith("memory:")
    assert outbox.context == {"redacted": True}
    message = cache.get(f"email:{outbox.idempotency_key}")
    assert message["to"] == join_request.email
    assert "An administrator must approve" in message["html"]
    assert PASSWORD not in message["html"]
    data = authenticated(admin).get("/api/organization-join-requests?status=all").json()
    assert PASSWORD not in json.dumps(data) and verification not in json.dumps(data)
    assert "password_hash" not in json.dumps(data) and "verification_token_hash" not in json.dumps(
        data
    )
