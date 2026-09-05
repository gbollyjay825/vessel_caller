from __future__ import annotations

import csv
import hashlib
import io
import json
import stat
import uuid
from datetime import timedelta
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from urllib.parse import parse_qs, urlparse

import pyotp
import pytest
from django.contrib import admin as django_admin
from django.contrib.auth import authenticate
from django.core.management import call_command, CommandError
from django.db import connection
from django.test import RequestFactory, override_settings
from django.utils import timezone
from rest_framework.test import APIClient

from accounts.admin import UserAdmin
from accounts.models import (
    ActionToken,
    EmailOutbox,
    Invitation,
    MFAChallenge,
    MFARecoveryCode,
    PlatformAccessGrant,
    PlatformMutationRequest,
    User,
)
from accounts.management.commands.system_admin_rollout_preflight import _atomic_private_write
from accounts.security import (
    decrypt_secret,
    encrypt_secret,
    generate_recovery_codes,
    issue_action_token,
)
from accounts.tasks import deliver_outbox_email
from audit.models import AuditEvent, PlatformAuditEvent
from audit.services import record_platform_event
from billing.models import InvoiceStatusStep
from organizations.admin import OrganizationAdmin
from organizations.models import Organization, OrganizationSettings

pytestmark = pytest.mark.django_db

MFA_SECRET = "JBSWY3DPEHPK3PXP"
SYSTEM_PASSWORD = "A-strong-system-password-2026!"


@pytest.fixture
def platform_organization():
    organization = Organization.objects.create(
        kind=Organization.Kind.PLATFORM,
        name="Vessel Caller Platform Administration",
        email="system@vesselcalls.test",
        registered=True,
    )
    OrganizationSettings.objects.create(organization=organization)
    return organization


@pytest.fixture
def system_admin(platform_organization):
    user = User.objects.create_user(
        email="system@vesselcalls.test",
        password=SYSTEM_PASSWORD,
        organization=platform_organization,
        name="System Operator",
        role=User.Role.VIEWER,
        status=User.Status.ACTIVE,
        email_verified_at=timezone.now(),
        mfa_secret=encrypt_secret(MFA_SECRET),
        mfa_enabled_at=timezone.now(),
        mfa_grace_ends_at=timezone.now(),
    )
    PlatformAccessGrant.objects.create(
        user=user,
        role=PlatformAccessGrant.Role.SYSTEM_ADMIN,
        reason="Test platform operations",
    )
    return user


def system_client(user, *, verified_at=None):
    client = APIClient()
    client.force_authenticate(user=user)
    session = client.session
    session["mfa_verified_at"] = timezone.now().timestamp() if verified_at is None else verified_at
    session.save()
    return client


def create_customer(name="Customer Shipping"):
    organization = Organization.objects.create(
        name=name,
        email=f"{name.lower().replace(' ', '-')}@example.test",
        registered=True,
        primary_port="Port of Calabar",
        ports=["Port of Calabar"],
    )
    OrganizationSettings.objects.create(organization=organization)
    return organization


def create_customer_user(organization, *, email, role=User.Role.ADMIN, status=User.Status.ACTIVE):
    return User.objects.create_user(
        email=email,
        password="A-strong-customer-password-2026!",
        organization=organization,
        name=email.split("@", 1)[0].title(),
        role=role,
        status=status,
        email_verified_at=timezone.now(),
    )


def test_platform_grant_is_explicit_and_never_implied_by_tenant_or_django_flags(
    platform_organization, organization, admin
):
    tenant = system_client(admin)
    assert tenant.get("/api/system/overview").status_code == 403

    staff = User.objects.create_user(
        email="breakglass@vesselcalls.test",
        password=SYSTEM_PASSWORD,
        organization=platform_organization,
        name="Break Glass",
        status=User.Status.ACTIVE,
        role=User.Role.ADMIN,
        email_verified_at=timezone.now(),
        is_staff=True,
        is_superuser=True,
    )
    assert authenticate(email=staff.email, password=SYSTEM_PASSWORD) == staff
    assert system_client(staff).get("/api/system/account").status_code == 403

    granted_staff = PlatformAccessGrant.objects.create(
        user=staff,
        role=PlatformAccessGrant.Role.SYSTEM_ADMIN,
        reason="Must still be denied",
    )
    assert granted_staff.active
    assert system_client(staff).get("/api/system/overview").status_code == 403

    user_admin = UserAdmin(User, django_admin.site)
    request = RequestFactory().get("/staff/accounts/user")
    request.user = staff
    assert user_admin.has_change_permission(request, staff) is False
    assert user_admin.has_delete_permission(request, staff) is False


def test_django_admin_cannot_create_or_rewrite_organization_lifecycle_attribution():
    organization_admin = OrganizationAdmin(Organization, django_admin.site)
    request = RequestFactory().get("/staff/organizations/organization")
    assert organization_admin.has_add_permission(request) is False
    assert {
        "kind",
        "access_status",
        "registered",
        "approved_at",
        "approved_by",
        "approval_reason",
        "suspended_at",
        "suspension_reason",
        "revision",
    }.issubset(set(organization_admin.readonly_fields))


def test_disallowed_and_missing_product_identities_burn_dummy_password_cost(
    platform_organization,
):
    from accounts.backends import EmailBackend

    customer = create_customer("Timing Customer")
    suspended = create_customer_user(customer, email="suspended@timing.test")
    suspended.status = User.Status.SUSPENDED
    suspended.save(update_fields=("status", "updated_at"))
    no_grant = create_customer_user(
        platform_organization,
        email="no-grant@timing.test",
        role=User.Role.VIEWER,
    )
    backend = EmailBackend()
    with patch("accounts.backends._burn_password_hash") as burn:
        assert backend.authenticate(None, email="missing@timing.test", password="wrong") is None
        assert backend.authenticate(None, email=suspended.email, password="wrong") is None
        assert backend.authenticate(None, email=no_grant.email, password="wrong") is None
    assert burn.call_count == 3


def test_new_organization_columns_keep_old_binary_inserts_compatible():
    now = timezone.now()
    organization_id = "org-oldbinary001"
    with connection.cursor() as cursor:
        cursor.execute(
            """
            INSERT INTO organizations_organization
                (id, registered, name, rc_number, email, phone, address,
                 primary_port, ports, logo_object_key, revision, created_at, updated_at)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            """,
            [
                organization_id,
                False,
                "Old Binary Customer",
                "",
                "",
                "",
                "",
                "Port of Calabar",
                json.dumps(["Port of Calabar"]),
                "",
                0,
                now,
                now,
            ],
        )
    organization = Organization.objects.get(pk=organization_id)
    assert organization.kind == Organization.Kind.CUSTOMER
    assert organization.access_status == Organization.AccessStatus.ACTIVE
    assert organization.approved_at is None
    assert organization.approved_by is None
    assert organization.approval_reason == ""
    assert organization.suspension_reason == ""


def test_new_outbox_columns_keep_old_binary_inserts_compatible():
    now = timezone.now()
    outbox_id = uuid.uuid4()
    with connection.cursor() as cursor:
        cursor.execute(
            """
            INSERT INTO accounts_emailoutbox
                (id, to_email, template, subject, context, idempotency_key, status,
                 attempts, provider_id, last_error, sent_at, created_at, updated_at)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            """,
            [
                outbox_id.hex,
                "legacy@example.test",
                "security_notice",
                "Legacy",
                json.dumps({"message": "legacy"}),
                "legacy-old-binary-001",
                EmailOutbox.Status.PENDING,
                0,
                "",
                "",
                None,
                now,
                now,
            ],
        )
    outbox = EmailOutbox.objects.get(pk=outbox_id)
    assert outbox.organization is None
    assert outbox.allow_suspended_organization is False
    assert outbox.allow_pending_approval_organization is False


def test_outbox_suppresses_suspended_org_but_allows_explicit_lifecycle_notice():
    organization = create_customer("Outbox Customer")
    organization.access_status = Organization.AccessStatus.SUSPENDED
    organization.suspended_at = timezone.now()
    organization.suspension_reason = "Test suspension"
    organization.save(
        update_fields=("access_status", "suspended_at", "suspension_reason", "updated_at")
    )
    suppressed = EmailOutbox.objects.create(
        organization=organization,
        to_email="admin@outbox.test",
        subject="Business update",
        template="invoice",
        context={"message": "business"},
        idempotency_key="suspended-business-001",
    )
    allowed = EmailOutbox.objects.create(
        organization=organization,
        allow_suspended_organization=True,
        to_email="admin@outbox.test",
        subject="Access suspended",
        template="security_notice",
        context={"message": "access suspended"},
        idempotency_key="suspended-lifecycle-001",
    )

    assert deliver_outbox_email(str(suppressed.id)) == ""
    suppressed.refresh_from_db()
    assert suppressed.status == EmailOutbox.Status.FAILED
    assert deliver_outbox_email(str(allowed.id)).startswith("memory:")
    allowed.refresh_from_db()
    assert allowed.status == EmailOutbox.Status.SENT


def test_pending_approval_outbox_bypass_is_limited_to_email_verification():
    from accounts.services import queue_email

    organization = create_customer("Pending Approval Outbox Customer")
    organization.access_status = Organization.AccessStatus.PENDING_APPROVAL
    organization.save(update_fields=("access_status", "updated_at"))
    suppressed = EmailOutbox.objects.create(
        organization=organization,
        to_email="admin@pending-outbox.test",
        subject="Verification without authorization",
        template="verify_email",
        context={"message": "must not send"},
        idempotency_key="pending-verify-not-authorized",
    )
    allowed = EmailOutbox.objects.create(
        organization=organization,
        allow_pending_approval_organization=True,
        to_email="admin@pending-outbox.test",
        subject="Verify email",
        template="verify_email",
        context={"message": "verify"},
        idempotency_key="pending-verify-authorized",
    )
    wrong_template = EmailOutbox.objects.create(
        organization=organization,
        allow_pending_approval_organization=True,
        to_email="admin@pending-outbox.test",
        subject="Business message",
        template="invoice",
        context={"message": "must not send"},
        idempotency_key="pending-wrong-template",
    )

    assert deliver_outbox_email(str(suppressed.id)) == ""
    assert deliver_outbox_email(str(allowed.id)).startswith("memory:")
    assert deliver_outbox_email(str(wrong_template.id)) == ""
    with pytest.raises(ValueError, match="Only email-verification delivery"):
        queue_email(
            organization=organization,
            allow_pending_approval_organization=True,
            to_email="admin@pending-outbox.test",
            subject="Unsafe bypass",
            template="security_notice",
            context={"message": "must not queue"},
            idempotency_key="pending-unsafe-helper-bypass",
        )
    assert not EmailOutbox.objects.filter(idempotency_key="pending-unsafe-helper-bypass").exists()

    organization.access_status = Organization.AccessStatus.SUSPENDED
    organization.suspended_at = timezone.now()
    organization.suspension_reason = "Suspended after pending verification test"
    organization.save(
        update_fields=("access_status", "suspended_at", "suspension_reason", "updated_at")
    )
    suspended_verify = EmailOutbox.objects.create(
        organization=organization,
        allow_pending_approval_organization=True,
        to_email="admin@pending-outbox.test",
        subject="Must remain blocked",
        template="verify_email",
        context={"message": "must not send"},
        idempotency_key="suspended-pending-bypass-denied",
    )
    assert deliver_outbox_email(str(suspended_verify.id)) == ""


def test_application_outbox_requires_scope_and_worker_never_replays_unscoped_failed_rows():
    scope_a = "scope-a"
    scope_b = "scope-b"
    scope_c = "scope-c"
    with pytest.raises(ValueError, match="organization scope"):
        from accounts.services import queue_email

        queue_email(
            to_email="unscoped@example.test",
            subject="Must not queue",
            template="security_notice",
            context={"message": "must not send"},
            idempotency_key=scope_a,
            organization=None,  # type: ignore[arg-type]
        )
    assert not EmailOutbox.objects.filter(idempotency_key=scope_a).exists()

    pending = EmailOutbox.objects.create(
        to_email="legacy-pending@example.test",
        subject="Legacy pending",
        template="security_notice",
        context={"message": "must not send"},
        idempotency_key=scope_b,
    )
    failed = EmailOutbox.objects.create(
        to_email="legacy-failed@example.test",
        subject="Legacy failed",
        template="security_notice",
        context={"message": "must remain exhausted"},
        idempotency_key=scope_c,
        status=EmailOutbox.Status.FAILED,
        attempts=5,
        last_error="historical exhausted failure",
    )
    with patch("accounts.tasks.deliver") as provider:
        assert deliver_outbox_email(str(pending.id)) == ""
        assert deliver_outbox_email(str(failed.id)) == ""
    provider.assert_not_called()
    pending.refresh_from_db()
    failed.refresh_from_db()
    assert pending.status == EmailOutbox.Status.FAILED
    assert pending.last_error == "Delivery suppressed because organization scope is missing"
    assert failed.status == EmailOutbox.Status.FAILED
    assert failed.attempts == 5
    assert failed.last_error == "historical exhausted failure"


def test_scoped_outbox_retries_a_transient_provider_failure():
    organization = create_customer("Retry Outbox Customer")
    outbox = EmailOutbox.objects.create(
        organization=organization,
        to_email="retry@example.test",
        subject="Retry",
        template="security_notice",
        context={"message": "retry safely"},
        idempotency_key="scoped-retry-001",
    )
    with patch("accounts.tasks.deliver", side_effect=RuntimeError("temporary provider failure")):
        with pytest.raises(RuntimeError, match="temporary provider failure"):
            deliver_outbox_email(str(outbox.id))
    outbox.refresh_from_db()
    assert outbox.status == EmailOutbox.Status.FAILED
    assert outbox.attempts == 1
    with patch("accounts.tasks.deliver", return_value="provider-retry-001") as provider:
        assert deliver_outbox_email(str(outbox.id)) == "provider-retry-001"
    provider.assert_called_once()
    outbox.refresh_from_db()
    assert outbox.status == EmailOutbox.Status.SENT
    assert outbox.attempts == 2


class FakeRolloutRedis:
    def __init__(self, *, celery=0, unacked=0, unacked_index=0):
        self.counts = {
            "celery": celery,
            "unacked": unacked,
            "unacked_index": unacked_index,
        }
        self.closed = False

    def llen(self, key):
        return self.counts.get(key, 0)

    def hlen(self, key):
        return self.counts[key]

    def zcard(self, key):
        return self.counts[key]

    def close(self):
        self.closed = True


@override_settings(
    ENVIRONMENT="staging",
    RELEASE_TAG="v-system-admin-test",
    RELEASE_SHA="a" * 40,
    CELERY_BROKER_URL="redis://example.invalid/0",
)
def test_rollout_preflight_writes_private_read_only_evidence(tmp_path):
    historical = EmailOutbox.objects.create(
        to_email="historical@example.test",
        subject="Historical failure",
        template="security_notice",
        context={"redacted": True},
        idempotency_key="historical-unscoped-failed-preflight",
        status=EmailOutbox.Status.FAILED,
        attempts=5,
        last_error="historical provider failure",
    )
    before = EmailOutbox.objects.values().get(pk=historical.pk)
    evidence_path = tmp_path / "system-admin-preflight.json"
    broker = FakeRolloutRedis()
    with patch(
        "accounts.management.commands.system_admin_rollout_preflight.redis.Redis.from_url",
        return_value=broker,
    ):
        call_command("system_admin_rollout_preflight", evidence_file=str(evidence_path))
    assert broker.closed is True
    evidence = json.loads(evidence_path.read_text(encoding="utf-8"))
    assert evidence["passed"] is True
    assert evidence["environment"] == "staging"
    assert evidence["release"] == {"tag": "v-system-admin-test", "sha": "a" * 40}
    assert evidence["counts"] == {
        "celery": 0,
        "pendingInvitationEmailCollisions": 0,
        "unacked": 0,
        "unackedIndex": 0,
        "unscopedPendingOrSending": 0,
    }
    assert evidence["historicalUnscopedFailed"]["count"] == 1
    assert len(evidence["historicalUnscopedFailed"]["sha256"]) == 64
    assert stat.S_IMODE(evidence_path.stat().st_mode) == 0o600
    sidecar = evidence_path.with_name(f"{evidence_path.name}.sha256")
    expected_digest = hashlib.sha256(evidence_path.read_bytes()).hexdigest()
    assert sidecar.read_text(encoding="ascii") == f"{expected_digest}  {evidence_path.name}\n"
    assert stat.S_IMODE(sidecar.stat().st_mode) == 0o600
    assert EmailOutbox.objects.values().get(pk=historical.pk) == before


@override_settings(
    ENVIRONMENT="production",
    RELEASE_TAG="v-system-admin-stdout",
    RELEASE_SHA="b" * 40,
    CELERY_BROKER_URL="redis://example.invalid/0",
)
def test_rollout_preflight_stdout_is_canonical_json_only():
    output = io.StringIO()
    with patch(
        "accounts.management.commands.system_admin_rollout_preflight.redis.Redis.from_url",
        return_value=FakeRolloutRedis(),
    ):
        call_command("system_admin_rollout_preflight", evidence_file="-", stdout=output)

    raw = output.getvalue()
    assert raw.endswith("\n")
    assert raw.count("\n") == 1
    evidence = json.loads(raw)
    assert evidence["passed"] is True
    assert evidence["environment"] == "production"
    assert evidence["release"] == {"tag": "v-system-admin-stdout", "sha": "b" * 40}


def test_rollout_preflight_counts_nondefault_celery_priority_queue(tmp_path):
    evidence_path = tmp_path / "priority-preflight.json"
    broker = FakeRolloutRedis()
    broker.counts["celery\x06\x163"] = 1
    with patch(
        "accounts.management.commands.system_admin_rollout_preflight.redis.Redis.from_url",
        return_value=broker,
    ):
        with pytest.raises(CommandError, match="rollout preflight failed"):
            call_command("system_admin_rollout_preflight", evidence_file=str(evidence_path))
    evidence = json.loads(evidence_path.read_text(encoding="utf-8"))
    assert evidence["counts"]["celery"] == 1


def test_rollout_preflight_rejects_relative_evidence_path_without_queries():
    with patch(
        "accounts.management.commands.system_admin_rollout_preflight.EmailOutbox.objects.filter"
    ) as query:
        with pytest.raises(CommandError, match="must be an absolute path"):
            call_command("system_admin_rollout_preflight", evidence_file="relative.json")
    query.assert_not_called()


def test_rollout_preflight_closes_broker_when_read_fails(tmp_path):
    class BrokenRolloutRedis(FakeRolloutRedis):
        def llen(self, key):
            raise RuntimeError("broker read failed")

    broker = BrokenRolloutRedis()
    with patch(
        "accounts.management.commands.system_admin_rollout_preflight.redis.Redis.from_url",
        return_value=broker,
    ):
        with pytest.raises(CommandError, match="Could not read"):
            call_command(
                "system_admin_rollout_preflight",
                evidence_file=str(tmp_path / "broker-failure.json"),
            )
    assert broker.closed is True


def test_atomic_private_write_removes_temporary_file_after_replace_failure(tmp_path):
    destination = tmp_path / "evidence.json"
    with patch(
        "accounts.management.commands.system_admin_rollout_preflight.os.replace",
        side_effect=OSError("replace failed"),
    ):
        with pytest.raises(OSError, match="replace failed"):
            _atomic_private_write(destination, b"evidence\n")
    assert not destination.exists()
    assert list(tmp_path.iterdir()) == []


def test_atomic_private_write_tolerates_disappearing_temporary_file(tmp_path):
    destination = tmp_path / "evidence.json"

    def remove_then_fail(source, target):
        Path(source).unlink()
        raise OSError("replace raced")

    with patch(
        "accounts.management.commands.system_admin_rollout_preflight.os.replace",
        side_effect=remove_then_fail,
    ):
        with pytest.raises(OSError, match="replace raced"):
            _atomic_private_write(destination, b"evidence\n")
    assert not destination.exists()


@pytest.mark.parametrize(
    ("broker_counts", "create_unscoped"),
    [
        ({"celery": 1}, False),
        ({"unacked": 1}, False),
        ({"unacked_index": 1}, False),
        ({}, True),
    ],
)
def test_rollout_preflight_fails_on_any_retryable_work(tmp_path, broker_counts, create_unscoped):
    if create_unscoped:
        pending = EmailOutbox.objects.create(
            to_email="pending@example.test",
            subject="Pending",
            template="security_notice",
            context={"redacted": True},
            idempotency_key="unscoped-pending-preflight",
        )
    broker = FakeRolloutRedis(**broker_counts)
    evidence_path = tmp_path / "failed-preflight.json"
    with patch(
        "accounts.management.commands.system_admin_rollout_preflight.redis.Redis.from_url",
        return_value=broker,
    ):
        with pytest.raises(CommandError, match="rollout preflight failed"):
            call_command("system_admin_rollout_preflight", evidence_file=str(evidence_path))
    assert json.loads(evidence_path.read_text(encoding="utf-8"))["passed"] is False
    if create_unscoped:
        pending.refresh_from_db()
        assert pending.status == EmailOutbox.Status.PENDING


def test_rollout_preflight_detects_invitation_collisions_without_exposing_or_mutating_email(
    tmp_path, organization, admin, viewer
):
    suppressed_user = create_customer_user(
        organization,
        email="suppressed-collision@example.test",
        role=User.Role.VIEWER,
    )
    suppressed = Invitation.objects.create(
        organization=organization,
        name="Runtime anti-enumeration record",
        email=suppressed_user.email,
        role=User.Role.ADMIN,
        token_hash="runtime-suppressed-collision",
        invited_by=admin,
        expires_at=timezone.now() + timedelta(days=1),
        deliverable=False,
    )
    invitation = Invitation.objects.create(
        organization=organization,
        name="Historical collision",
        email=viewer.email.upper(),
        role=User.Role.ADMIN,
        token_hash="historical-cross-account",
        invited_by=admin,
        expires_at=timezone.now() + timedelta(days=1),
    )
    evidence_path = tmp_path / "invitation-collision.json"
    with patch(
        "accounts.management.commands.system_admin_rollout_preflight.redis.Redis.from_url",
        return_value=FakeRolloutRedis(),
    ):
        with pytest.raises(CommandError, match="rollout preflight failed"):
            call_command("system_admin_rollout_preflight", evidence_file=str(evidence_path))
    evidence_text = evidence_path.read_text(encoding="utf-8")
    evidence = json.loads(evidence_text)
    assert evidence["counts"]["pendingInvitationEmailCollisions"] == 1
    assert evidence["pendingInvitationEmailCollisions"]["count"] == 1
    assert len(evidence["pendingInvitationEmailCollisions"]["sha256"]) == 64
    assert viewer.email not in evidence_text
    invitation.refresh_from_db()
    suppressed.refresh_from_db()
    assert invitation.status == Invitation.Status.PENDING
    assert invitation.deliverable is True
    assert suppressed.status == Invitation.Status.PENDING
    assert suppressed.deliverable is False


def test_platform_enrollment_account_has_no_tenant_permissions(platform_organization):
    user = User.objects.create_user(
        email="enroll@vesselcalls.test",
        password=SYSTEM_PASSWORD,
        organization=platform_organization,
        name="Enrollment User",
        role=User.Role.ADMIN,
        status=User.Status.ACTIVE,
        email_verified_at=timezone.now(),
    )
    PlatformAccessGrant.objects.create(
        user=user,
        role=PlatformAccessGrant.Role.SYSTEM_ADMIN,
        reason="Enroll MFA",
    )
    client = APIClient()
    client.force_authenticate(user=user)

    account = client.get("/api/system/account")
    assert account.status_code == 200
    assert account.json()["platformAccess"]["mfaEnrollmentRequired"] is True
    assert account.json()["platformAccess"]["permissions"] == []
    assert account.json()["platformAccess"]["environment"] in {"development", "test"}
    assert account.json()["platformAccess"]["emailDeliveryReady"] is True
    assert account.json()["platformAccess"]["mutationsEnabled"] is True
    assert client.get("/api/system/overview").status_code == 403
    assert client.get("/api/vessel-calls").status_code == 403
    assert client.get("/api/state").status_code == 403
    assert not InvoiceStatusStep.objects.filter(organization=platform_organization).exists()


@override_settings(SYSTEM_ADMIN_MUTATIONS_ENABLED=True)
def test_pending_customer_requires_audited_system_approval_before_tenant_login(system_admin):
    organization = create_customer("Approval Customer")
    organization.registered = True
    organization.access_status = Organization.AccessStatus.PENDING_APPROVAL
    organization.save(update_fields=("registered", "access_status", "updated_at"))
    tenant_admin = create_customer_user(organization, email="admin@approval.test")
    client = system_client(system_admin)

    overview = client.get("/api/system/overview")
    assert overview.status_code == 200
    assert overview.json()["pendingApprovalOrganizationCount"] == 1
    listing = client.get(
        "/api/system/organizations",
        {"status": Organization.AccessStatus.PENDING_APPROVAL},
    )
    assert listing.status_code == 200
    assert listing.json()["results"][0]["status"] == "pending_approval"
    assert listing.json()["results"][0]["approvedAt"] is None
    detail = client.get(f"/api/system/organizations/{organization.id}")
    assert detail.json()["organization"]["approvedBy"] is None
    assert detail.json()["organization"]["approvalReason"] is None

    tenant_client = APIClient()
    assert (
        tenant_client.post(
            "/api/auth/login",
            {"email": tenant_admin.email, "password": "A-strong-customer-password-2026!"},
            format="json",
        ).status_code
        == 401
    )

    approval_url = f"/api/system/organizations/{organization.id}/approve"
    stale = client.post(
        approval_url,
        {"reason": "Verified customer onboarding", "revision": organization.revision + 1},
        format="json",
        HTTP_IDEMPOTENCY_KEY="approve-customer-stale-001",
    )
    assert stale.status_code == 409
    approved = client.post(
        approval_url,
        {"reason": "Verified customer onboarding", "revision": organization.revision},
        format="json",
        HTTP_IDEMPOTENCY_KEY="approve-customer-001",
    )
    assert approved.status_code == 200
    organization.refresh_from_db()
    assert organization.access_status == Organization.AccessStatus.ACTIVE
    assert organization.approved_at is not None
    assert organization.approved_by == system_admin
    assert organization.approval_reason == "Verified customer onboarding"
    assert approved.json()["organization"]["approvedBy"]["id"] == system_admin.id
    assert approved.json()["organization"]["approvalReason"] == "Verified customer onboarding"
    assert (
        PlatformAuditEvent.objects.filter(
            organization=organization,
            action="platform.organization.approved",
            actor=system_admin,
        ).count()
        == 1
    )
    platform_event = PlatformAuditEvent.objects.get(
        organization=organization,
        action="platform.organization.approved",
    )
    assert platform_event.reason == "Verified customer onboarding"
    assert platform_event.before == {"status": Organization.AccessStatus.PENDING_APPROVAL}
    assert platform_event.after == {"status": Organization.AccessStatus.ACTIVE}
    tenant_event = AuditEvent.objects.get(
        organization=organization,
        action="platform.organization.approved",
    )
    assert tenant_event.actor is None
    assert tenant_event.before == {"status": Organization.AccessStatus.PENDING_APPROVAL}
    assert tenant_event.after == {"status": Organization.AccessStatus.ACTIVE}
    assert "reason" not in json.dumps(tenant_event.before | tenant_event.after).lower()
    assert (
        EmailOutbox.objects.filter(
            organization=organization,
            idempotency_key__startswith=f"notice:organization-approved:{organization.id}:",
        ).count()
        == 1
    )

    replay = client.post(
        approval_url,
        {"reason": "Verified customer onboarding", "revision": approved.json()["rev"] - 1},
        format="json",
        HTTP_IDEMPOTENCY_KEY="approve-customer-001",
    )
    assert replay.status_code == 200
    assert replay.json() == approved.json()
    assert (
        PlatformAuditEvent.objects.filter(
            organization=organization,
            action="platform.organization.approved",
        ).count()
        == 1
    )
    assert (
        tenant_client.post(
            "/api/auth/login",
            {"email": tenant_admin.email, "password": "A-strong-customer-password-2026!"},
            format="json",
        ).status_code
        == 200
    )

    invalid_state = client.post(
        approval_url,
        {"reason": "Cannot approve twice", "revision": organization.revision},
        format="json",
        HTTP_IDEMPOTENCY_KEY="approve-customer-invalid-state",
    )
    assert invalid_state.status_code == 400


@override_settings(SYSTEM_ADMIN_MUTATIONS_ENABLED=True)
def test_approval_preconditions_and_other_lifecycle_routes_fail_closed(
    system_admin, platform_organization
):
    organization = create_customer("Approval Preconditions Customer")
    organization.registered = False
    organization.access_status = Organization.AccessStatus.PENDING_APPROVAL
    organization.save(update_fields=("registered", "access_status", "updated_at"))
    tenant_admin = create_customer_user(
        organization,
        email="admin@approval-preconditions.test",
        status=User.Status.INVITED,
    )
    tenant_admin.email_verified_at = None
    tenant_admin.save(update_fields=("email_verified_at", "updated_at"))
    client = system_client(system_admin)
    approval_url = f"/api/system/organizations/{organization.id}/approve"

    missing_idempotency = client.post(
        approval_url,
        {"reason": "Verified onboarding", "revision": organization.revision},
        format="json",
    )
    assert missing_idempotency.status_code == 400
    missing_reason = client.post(
        approval_url,
        {"revision": organization.revision},
        format="json",
        HTTP_IDEMPOTENCY_KEY="approve-missing-reason-001",
    )
    assert missing_reason.status_code == 400
    unverified = client.post(
        approval_url,
        {"reason": "Email is not verified", "revision": organization.revision},
        format="json",
        HTTP_IDEMPOTENCY_KEY="approve-unverified-001",
    )
    assert unverified.status_code == 400
    assert "Email verification" in str(unverified.json())

    tenant_admin.status = User.Status.ACTIVE
    tenant_admin.save(update_fields=("status", "updated_at"))
    organization.registered = True
    organization.save(update_fields=("registered", "updated_at"))
    detail = client.get(f"/api/system/organizations/{organization.id}")
    assert detail.status_code == 200
    assert detail.json()["organization"]["adminCount"] == 0
    still_unverified = client.post(
        approval_url,
        {
            "reason": "Active but unverified Admin must not unlock approval",
            "revision": organization.revision,
        },
        format="json",
        HTTP_IDEMPOTENCY_KEY="approve-active-unverified-001",
    )
    assert still_unverified.status_code == 400
    assert "Email verification" in str(still_unverified.json())

    stale_mfa_client = system_client(
        system_admin,
        verified_at=timezone.now().timestamp() - 901,
    )
    stale_mfa = stale_mfa_client.post(
        approval_url,
        {"reason": "Recent MFA is required", "revision": organization.revision},
        format="json",
        HTTP_IDEMPOTENCY_KEY="approve-stale-mfa-001",
    )
    assert stale_mfa.status_code == 403
    assert stale_mfa.json()["errors"]["code"] == "system_mfa_step_up_required"

    with override_settings(SYSTEM_ADMIN_MUTATIONS_ENABLED=False):
        disabled = client.post(
            approval_url,
            {"reason": "Runtime gate is disabled", "revision": organization.revision},
            format="json",
            HTTP_IDEMPOTENCY_KEY="approve-disabled-gate-001",
        )
    assert disabled.status_code == 503
    assert disabled.json()["errors"]["code"] == "system_mutations_disabled"

    pending_suspend = client.post(
        f"/api/system/organizations/{organization.id}/suspend",
        {"reason": "Cannot skip approval", "revision": organization.revision},
        format="json",
        HTTP_IDEMPOTENCY_KEY="suspend-pending-approval-001",
    )
    pending_reactivate = client.post(
        f"/api/system/organizations/{organization.id}/reactivate",
        {"reason": "Cannot skip approval", "revision": organization.revision},
        format="json",
        HTTP_IDEMPOTENCY_KEY="reactivate-pending-approval-001",
    )
    assert pending_suspend.status_code == 400
    assert pending_reactivate.status_code == 400

    platform_target = client.post(
        f"/api/system/organizations/{platform_organization.id}/approve",
        {"reason": "Platform container is immutable", "revision": platform_organization.revision},
        format="json",
        HTTP_IDEMPOTENCY_KEY="approve-platform-container-001",
    )
    assert platform_target.status_code == 404

    organization.refresh_from_db()
    assert organization.access_status == Organization.AccessStatus.PENDING_APPROVAL
    assert organization.approved_at is None
    assert organization.approved_by is None
    assert organization.approval_reason == ""
    assert not PlatformAuditEvent.objects.filter(
        organization=organization,
        action="platform.organization.approved",
    ).exists()
    assert not EmailOutbox.objects.filter(
        organization=organization,
        idempotency_key__startswith=f"notice:organization-approved:{organization.id}:",
    ).exists()

    organization.registered = True
    organization.access_status = Organization.AccessStatus.SUSPENDED
    organization.suspended_at = timezone.now()
    organization.suspension_reason = "Already suspended"
    organization.save(
        update_fields=(
            "registered",
            "access_status",
            "suspended_at",
            "suspension_reason",
            "updated_at",
        )
    )
    suspended = client.post(
        approval_url,
        {"reason": "Suspension is not approval", "revision": organization.revision},
        format="json",
        HTTP_IDEMPOTENCY_KEY="approve-suspended-001",
    )
    assert suspended.status_code == 400
    organization.refresh_from_db()
    assert organization.access_status == Organization.AccessStatus.SUSPENDED


@pytest.mark.parametrize("privileged_field", ["is_staff", "is_superuser"])
@override_settings(SYSTEM_ADMIN_MUTATIONS_ENABLED=True)
def test_privileged_customer_admin_cannot_satisfy_approval_readiness(
    system_admin, privileged_field
):
    organization = create_customer(f"Privileged {privileged_field} Customer")
    organization.registered = True
    organization.access_status = Organization.AccessStatus.PENDING_APPROVAL
    organization.save(update_fields=("registered", "access_status", "updated_at"))
    tenant_admin = create_customer_user(
        organization,
        email=f"{privileged_field}@approval.test",
    )
    setattr(tenant_admin, privileged_field, True)
    tenant_admin.save(update_fields=(privileged_field, "updated_at"))
    client = system_client(system_admin)

    detail = client.get(f"/api/system/organizations/{organization.id}")
    assert detail.status_code == 200
    assert detail.json()["organization"]["adminCount"] == 0
    approval = client.post(
        f"/api/system/organizations/{organization.id}/approve",
        {
            "reason": "Privileged Django accounts are not tenant identities",
            "revision": organization.revision,
        },
        format="json",
        HTTP_IDEMPOTENCY_KEY=f"approve-{privileged_field}-admin-001",
    )
    assert approval.status_code == 400
    organization.refresh_from_db()
    assert organization.access_status == Organization.AccessStatus.PENDING_APPROVAL


@override_settings(SYSTEM_ADMIN_MUTATIONS_ENABLED=True)
def test_email_verification_invalidates_a_prepared_approval_revision(system_admin):
    organization = create_customer("Approval Revision Customer")
    organization.registered = False
    organization.access_status = Organization.AccessStatus.PENDING_APPROVAL
    organization.save(update_fields=("registered", "access_status", "updated_at"))
    tenant_admin = create_customer_user(
        organization,
        email="admin@approval-revision.test",
        status=User.Status.INVITED,
    )
    tenant_admin.email_verified_at = None
    tenant_admin.save(update_fields=("email_verified_at", "updated_at"))
    _, raw = issue_action_token(
        tenant_admin,
        ActionToken.Kind.VERIFY_EMAIL,
        hours=24,
        allow_pending_approval=True,
    )
    prepared_revision = organization.revision

    verified = APIClient().post("/api/auth/verify-email", {"token": raw}, format="json")
    assert verified.status_code == 200
    organization.refresh_from_db()
    assert organization.registered is True
    assert organization.revision == prepared_revision + 1

    client = system_client(system_admin)
    approval_url = f"/api/system/organizations/{organization.id}/approve"
    stale = client.post(
        approval_url,
        {"reason": "Review prepared before verification", "revision": prepared_revision},
        format="json",
        HTTP_IDEMPOTENCY_KEY="approval-pre-verification-revision-001",
    )
    assert stale.status_code == 409

    approved = client.post(
        approval_url,
        {"reason": "Review refreshed after verification", "revision": organization.revision},
        format="json",
        HTTP_IDEMPOTENCY_KEY="approval-post-verification-revision-001",
    )
    assert approved.status_code == 200
    assert approved.json()["organization"]["status"] == Organization.AccessStatus.ACTIVE


def test_recent_mfa_step_up_is_distinct_and_invalid_code_preserves_session(system_admin):
    old = timezone.now().timestamp() - 901
    client = system_client(system_admin, verified_at=old)
    assert client.get("/api/system/overview").status_code == 200

    denied = client.patch(
        "/api/system/organizations/missing",
        {"name": "Nope", "revision": 0},
        format="json",
        HTTP_IDEMPOTENCY_KEY="step-up-required-1",
    )
    assert denied.status_code == 403
    assert denied.json()["errors"]["code"] == "system_mfa_step_up_required"
    assert client.get("/api/system/audit/export").status_code == 403

    invalid = client.post("/api/system/step-up", {"code": "000000"}, format="json")
    assert invalid.status_code == 400
    assert client.get("/api/system/account").status_code == 200

    valid = client.post(
        "/api/system/step-up",
        {"code": pyotp.TOTP(MFA_SECRET).now()},
        format="json",
    )
    assert valid.status_code == 200
    assert valid.json()["platformAccess"]["stepUpRequired"] is False
    assert PlatformAuditEvent.objects.filter(
        action="platform.system_admin.step_up",
        actor=system_admin,
    ).exists()


@override_settings(SYSTEM_ADMIN_MUTATIONS_ENABLED=True)
def test_create_customer_is_idempotent_private_and_onboarding(system_admin):
    client = system_client(system_admin)
    payload = {
        "name": "New Shipping Co",
        "rcNumber": "RC-100",
        "email": "office@newshipping.test",
        "primaryPort": "Apapa Port",
        "ports": ["Apapa Port"],
        "initialAdmin": {"name": "First Admin", "email": "first@newshipping.test"},
    }
    missing = client.post("/api/system/organizations", payload, format="json")
    assert missing.status_code == 400

    response = client.post(
        "/api/system/organizations",
        payload,
        format="json",
        HTTP_IDEMPOTENCY_KEY="create-new-shipping-001",
    )
    assert response.status_code == 201
    organization = Organization.objects.get(name="New Shipping Co")
    invitation = Invitation.objects.get(organization=organization)
    assert organization.registered is False
    assert organization.kind == Organization.Kind.CUSTOMER
    assert organization.access_status == Organization.AccessStatus.ACTIVE
    assert organization.approved_at is not None
    assert organization.approved_by == system_admin
    assert organization.approval_reason == "Provisioned by a System Administrator"
    assert response.json()["organization"]["approvedAt"] is not None
    assert response.json()["organization"]["approvedBy"]["id"] == system_admin.id
    assert invitation.role == User.Role.ADMIN
    assert timedelta(hours=23, minutes=59) < invitation.expires_at - timezone.now()
    assert InvoiceStatusStep.objects.filter(organization=organization).exists()
    assert EmailOutbox.objects.filter(to_email=invitation.email).count() == 1

    replay = client.post(
        "/api/system/organizations",
        payload,
        format="json",
        HTTP_IDEMPOTENCY_KEY="create-new-shipping-001",
    )
    assert replay.status_code == 201
    assert replay.json() == response.json()
    assert Organization.objects.filter(name="New Shipping Co").count() == 1
    assert Invitation.objects.filter(organization=organization).count() == 1

    conflicting = client.post(
        "/api/system/organizations",
        {**payload, "name": "Different Organization"},
        format="json",
        HTTP_IDEMPOTENCY_KEY="create-new-shipping-001",
    )
    assert conflicting.status_code == 409
    assert PlatformMutationRequest.objects.filter(actor=system_admin).count() == 1

    unavailable_name = "Unavailable Admin Customer"
    unavailable = client.post(
        "/api/system/organizations",
        {
            **payload,
            "name": unavailable_name,
            "initialAdmin": {"name": "Existing", "email": system_admin.email},
        },
        format="json",
        HTTP_IDEMPOTENCY_KEY="create-unavailable-admin-001",
    )
    assert unavailable.status_code == 400
    unavailable_body = unavailable.json()
    assert unavailable_body["detail"] == "The request could not be completed"
    assert unavailable_body["errors"] == {
        "initialAdmin": ["An invitation could not be created for this email"]
    }
    assert "exists" not in json.dumps(unavailable_body).lower()
    assert system_admin.email not in json.dumps(unavailable_body)
    assert not Organization.objects.filter(name=unavailable_name).exists()
    assert PlatformMutationRequest.objects.filter(actor=system_admin).count() == 1


@override_settings(SYSTEM_ADMIN_MUTATIONS_ENABLED=True)
def test_list_minimizes_bulk_data_and_profile_update_is_safe(system_admin):
    organization = create_customer("Private Customer")
    organization.rc_number = "SECRET-RC"
    organization.phone = "+2348000000000"
    organization.address = "Private address"
    organization.save()
    create_customer_user(organization, email="admin@private.test")
    Invitation.objects.create(
        organization=organization,
        name="Viewer Invite",
        email="viewer-invite@private.test",
        role=User.Role.VIEWER,
        token_hash="viewer-hash",
        invited_by=system_admin,
        expires_at=timezone.now() + timedelta(days=1),
    )
    client = system_client(system_admin)

    listing = client.get(f"/api/system/organizations?search={organization.id}")
    assert listing.status_code == 200
    summary = listing.json()["results"][0]
    assert set(summary) == {
        "id",
        "name",
        "status",
        "registered",
        "primaryPort",
        "createdAt",
        "updatedAt",
        "approvedAt",
        "userCount",
        "activeUserCount",
        "adminCount",
        "pendingInvitationCount",
    }
    assert summary["status"] == Organization.AccessStatus.ACTIVE
    assert summary["approvedAt"] is None
    assert summary["pendingInvitationCount"] == 0
    assert "address" not in summary and "suspensionReason" not in summary

    detail = client.get(f"/api/system/organizations/{organization.id}")
    assert detail.status_code == 200
    assert detail.json()["organization"]["rcNumber"] == "SECRET-RC"
    assert detail.json()["organization"]["approvedBy"] is None
    assert detail.json()["organization"]["approvalReason"] is None
    revision = detail.json()["organization"]["revision"]
    audit_before = PlatformAuditEvent.objects.count()
    no_op = client.patch(
        f"/api/system/organizations/{organization.id}",
        {"name": organization.name, "revision": revision},
        format="json",
        HTTP_IDEMPOTENCY_KEY="profile-no-op-001",
    )
    assert no_op.status_code == 200
    assert no_op.json()["rev"] == revision
    assert PlatformAuditEvent.objects.count() == audit_before

    duplicate_ports = client.patch(
        f"/api/system/organizations/{organization.id}",
        {"ports": ["Apapa", " apapa "], "revision": revision},
        format="json",
        HTTP_IDEMPOTENCY_KEY="profile-bad-ports-001",
    )
    assert duplicate_ports.status_code == 400
    updated = client.patch(
        f"/api/system/organizations/{organization.id}",
        {"primaryPort": "Onne Port", "ports": ["Port of Calabar"], "revision": revision},
        format="json",
        HTTP_IDEMPOTENCY_KEY="profile-update-ports-001",
    )
    assert updated.status_code == 200
    assert updated.json()["organization"]["ports"] == ["Port of Calabar", "Onne Port"]
    organization.refresh_from_db()
    assert organization.primary_port == "Onne Port"
    assert organization.ports == ["Port of Calabar", "Onne Port"]


@override_settings(SYSTEM_ADMIN_MUTATIONS_ENABLED=True)
def test_suspend_revokes_access_and_separates_private_from_tenant_audit(system_admin):
    organization = create_customer("Suspend Customer")
    active_admin = create_customer_user(organization, email="active-admin@suspend.test")
    create_customer_user(
        organization,
        email="suspended-admin@suspend.test",
        status=User.Status.SUSPENDED,
    )
    create_customer_user(
        organization,
        email="viewer@suspend.test",
        role=User.Role.VIEWER,
    )
    invitation = Invitation.objects.create(
        organization=organization,
        name="Pending Admin",
        email="pending@suspend.test",
        role=User.Role.ADMIN,
        token_hash="pending-hash",
        invited_by=system_admin,
        expires_at=timezone.now() + timedelta(days=1),
    )
    token, _ = issue_action_token(active_admin, ActionToken.Kind.RESET_PASSWORD, hours=1)
    challenge = MFAChallenge.objects.create(
        user=active_admin,
        expires_at=timezone.now() + timedelta(minutes=5),
    )
    recovery_code = MFARecoveryCode.objects.create(
        user=active_admin,
        code_hash="historical-recovery-code",
    )
    client = system_client(system_admin)
    response = client.post(
        f"/api/system/organizations/{organization.id}/suspend",
        {"reason": "Internal fraud review", "revision": organization.revision},
        format="json",
        HTTP_IDEMPOTENCY_KEY="suspend-customer-001",
    )
    assert response.status_code == 200
    organization.refresh_from_db()
    invitation.refresh_from_db()
    assert organization.access_status == Organization.AccessStatus.SUSPENDED
    assert invitation.status == Invitation.Status.REVOKED
    assert not ActionToken.objects.filter(pk=token.pk).exists()
    assert not MFAChallenge.objects.filter(pk=challenge.pk).exists()
    assert not MFARecoveryCode.objects.filter(pk=recovery_code.pk).exists()
    assert (
        EmailOutbox.objects.filter(
            idempotency_key__startswith=f"notice:organization-suspended:{organization.id}:"
        ).count()
        == 1
    )

    private = PlatformAuditEvent.objects.get(action="platform.organization.suspended")
    tenant = AuditEvent.objects.get(action="platform.organization.suspended")
    assert private.actor == system_admin
    assert private.reason == "Internal fraud review"
    assert tenant.actor is None
    assert tenant.target_label == "Vessel Caller System"
    assert "reason" not in (tenant.after or {})
    assert system_client(active_admin).get("/api/auth/me").status_code == 403


def test_expired_or_revoked_product_grant_cannot_authenticate_or_keep_session(system_admin):
    assert authenticate(email=system_admin.email, password=SYSTEM_PASSWORD) == system_admin
    real_client = APIClient()
    login = real_client.post(
        "/api/auth/login",
        {"email": system_admin.email, "password": SYSTEM_PASSWORD},
        format="json",
    )
    assert login.status_code == 202
    verified = real_client.post(
        "/api/auth/mfa/verify",
        {
            "challengeId": login.json()["challengeId"],
            "code": pyotp.TOTP(MFA_SECRET).now(),
        },
        format="json",
    )
    assert verified.status_code == 200
    assert real_client.get("/api/auth/me").status_code == 200
    grant = system_admin.platform_access_grants.get(revoked_at__isnull=True)
    grant.expires_at = timezone.now() - timedelta(seconds=1)
    grant.save(update_fields=("expires_at",))
    assert authenticate(email=system_admin.email, password=SYSTEM_PASSWORD) is None
    assert real_client.get("/api/auth/me").status_code in {401, 403}


def test_mfa_failed_attempts_persist_and_lock_the_challenge(system_admin):
    client = APIClient()
    login = client.post(
        "/api/auth/login",
        {"email": system_admin.email, "password": SYSTEM_PASSWORD},
        format="json",
    )
    challenge_id = login.json()["challengeId"]
    for _ in range(5):
        assert (
            client.post(
                "/api/auth/mfa/verify",
                {"challengeId": challenge_id, "code": "not-a-code"},
                format="json",
            ).status_code
            == 401
        )
    challenge = MFAChallenge.objects.get(pk=challenge_id)
    assert challenge.attempts == 5
    sixth = client.post(
        "/api/auth/mfa/verify",
        {"challengeId": challenge_id, "code": pyotp.TOTP(MFA_SECRET).now()},
        format="json",
    )
    assert sixth.status_code == 401
    challenge.refresh_from_db()
    assert challenge.attempts == 5


def test_step_up_supports_recovery_code_and_throttles_failures(system_admin):
    from django.core.cache import cache

    cache.clear()
    recovery = generate_recovery_codes(system_admin)[0]
    client = system_client(system_admin, verified_at=timezone.now().timestamp() - 901)
    assert client.post("/api/system/step-up", {"code": recovery}, format="json").status_code == 200

    cache.clear()
    for _ in range(5):
        assert (
            client.post("/api/system/step-up", {"code": "not-a-code"}, format="json").status_code
            == 400
        )
    assert (
        client.post("/api/system/step-up", {"code": "not-a-code"}, format="json").status_code == 429
    )


def test_step_up_atomic_user_budget_cannot_be_reset_by_ip_rotation(system_admin):
    from concurrent.futures import ThreadPoolExecutor

    from django.core.cache import cache

    from accounts.services import record_mfa_failure

    cache.clear()
    client = system_client(system_admin)
    for attempt in range(5):
        response = client.post(
            "/api/system/step-up",
            {"code": "not-a-code"},
            format="json",
            REMOTE_ADDR=f"198.51.100.{attempt + 1}",
        )
        assert response.status_code == 400
    rotated_ip = client.post(
        "/api/system/step-up",
        {"code": "not-a-code"},
        format="json",
        REMOTE_ADDR="203.0.113.200",
    )
    assert rotated_ip.status_code == 429

    cache.clear()
    with ThreadPoolExecutor(max_workers=12) as pool:
        reservations = list(pool.map(lambda _index: record_mfa_failure(system_admin.id), range(20)))
    assert sorted(reservations) == list(range(1, 21))
    assert sum(value <= 5 for value in reservations) == 5
    cache.clear()


def test_step_up_has_an_independent_trusted_ip_budget(system_admin):
    from django.core.cache import cache

    cache.clear()
    operators = [system_admin]
    for index in range(4):
        operator = User.objects.create_user(
            email=f"system-ip-budget-{index}@vesselcalls.test",
            password=SYSTEM_PASSWORD,
            organization=system_admin.organization,
            name=f"System IP Budget {index}",
            role=User.Role.VIEWER,
            status=User.Status.ACTIVE,
            email_verified_at=timezone.now(),
            mfa_secret=encrypt_secret(MFA_SECRET),
            mfa_enabled_at=timezone.now(),
            mfa_grace_ends_at=timezone.now(),
        )
        PlatformAccessGrant.objects.create(
            user=operator,
            role=PlatformAccessGrant.Role.SYSTEM_ADMIN,
            reason="Independent IP throttle test",
        )
        operators.append(operator)

    responses = []
    for operator in operators:
        client = system_client(operator)
        for _ in range(5):
            responses.append(
                client.post(
                    "/api/system/step-up",
                    {"code": "not-a-code"},
                    format="json",
                    REMOTE_ADDR="198.51.100.210",
                ).status_code
            )
    assert responses[:24] == [400] * 24
    assert responses[24] == 429
    cache.clear()


def test_spoofed_forwarded_prefix_cannot_evade_step_up_throttle(system_admin):
    from django.core.cache import cache

    cache.clear()
    client = system_client(system_admin)
    for attempt in range(5):
        response = client.post(
            "/api/system/step-up",
            {"code": "not-a-code"},
            format="json",
            REMOTE_ADDR="127.0.0.1",
            HTTP_X_FORWARDED_FOR=f"203.0.113.{attempt}, 198.51.100.44",
        )
        assert response.status_code == 400
    blocked = client.post(
        "/api/system/step-up",
        {"code": "not-a-code"},
        format="json",
        REMOTE_ADDR="127.0.0.1",
        HTTP_X_FORWARDED_FOR="192.0.2.99, 198.51.100.44",
    )
    assert blocked.status_code == 429


def test_login_throttle_uses_trusted_peer_ip_not_spoofed_forwarded_prefix():
    from api.auth_views import _throttle_key

    factory = RequestFactory()
    first = factory.post(
        "/api/auth/login",
        REMOTE_ADDR="127.0.0.1",
        HTTP_X_FORWARDED_FOR="203.0.113.1, 198.51.100.44",
    )
    same_peer = factory.post(
        "/api/auth/login",
        REMOTE_ADDR="127.0.0.1",
        HTTP_X_FORWARDED_FOR="192.0.2.99, 198.51.100.44",
    )
    different_peer = factory.post(
        "/api/auth/login",
        REMOTE_ADDR="127.0.0.1",
        HTTP_X_FORWARDED_FOR="203.0.113.1, 198.51.100.45",
    )
    direct = factory.post(
        "/api/auth/login",
        REMOTE_ADDR="203.0.113.20",
        HTTP_X_FORWARDED_FOR="192.0.2.10",
    )
    direct_spoof_changed = factory.post(
        "/api/auth/login",
        REMOTE_ADDR="203.0.113.20",
        HTTP_X_FORWARDED_FOR="192.0.2.11",
    )
    assert _throttle_key("operator@example.test", first) == _throttle_key(
        "operator@example.test", same_peer
    )
    assert _throttle_key("operator@example.test", first) != _throttle_key(
        "operator@example.test", different_peer
    )
    assert _throttle_key("operator@example.test", direct) == _throttle_key(
        "operator@example.test", direct_spoof_changed
    )


def test_auth_rate_keys_are_private_and_independent_for_account_and_ip(admin):
    from django.core.cache import cache

    from api.auth_views import _login_throttle_keys

    cache.clear()
    factory = RequestFactory()
    request = factory.post("/api/auth/login", REMOTE_ADDR="198.51.100.44")
    account_key, ip_key = _login_throttle_keys(admin.email, request)
    assert admin.email not in account_key
    assert "198.51.100.44" not in ip_key
    assert account_key != ip_key

    client = APIClient()
    for attempt in range(8):
        response = client.post(
            "/api/auth/login",
            {"email": admin.email, "password": "wrong-password"},
            format="json",
            REMOTE_ADDR=f"198.51.100.{attempt + 1}",
        )
        assert response.status_code == 401
    blocked_account = client.post(
        "/api/auth/login",
        {"email": admin.email, "password": "A-strong-admin-password-2026!"},
        format="json",
        REMOTE_ADDR="203.0.113.250",
    )
    assert blocked_account.status_code == 401
    assert blocked_account.json()["detail"] == "Too many attempts. Try again later"

    cache.clear()
    for attempt in range(24):
        response = client.post(
            "/api/auth/login",
            {"email": f"missing-{attempt}@example.test", "password": "wrong-password"},
            format="json",
            REMOTE_ADDR="198.51.100.99",
        )
        assert response.status_code == 401
    blocked_ip = client.post(
        "/api/auth/login",
        {"email": admin.email, "password": "A-strong-admin-password-2026!"},
        format="json",
        REMOTE_ADDR="198.51.100.99",
    )
    assert blocked_ip.status_code == 401
    assert blocked_ip.json()["detail"] == "Too many attempts. Try again later"


def test_public_auth_budget_reservation_is_atomic_and_throttled_requests_do_not_mutate(admin):
    from concurrent.futures import ThreadPoolExecutor

    from django.core.cache import cache

    from api.auth_views import _consume_public_budget

    cache.clear()
    factory = RequestFactory()

    def reserve(_index):
        request = factory.post("/api/auth/forgot-password", REMOTE_ADDR="198.51.100.50")
        return _consume_public_budget(
            "parallel-recovery",
            "private-target@example.test",
            request,
            account_limit=5,
            ip_limit=20,
        )

    with ThreadPoolExecutor(max_workers=12) as pool:
        results = list(pool.map(reserve, range(20)))
    assert sum(results) == 5

    cache.clear()
    client = APIClient()
    before_tokens = ActionToken.objects.filter(
        user=admin, kind=ActionToken.Kind.RESET_PASSWORD
    ).count()
    before_mail = EmailOutbox.objects.filter(
        to_email=admin.email, template="reset_password"
    ).count()
    for _ in range(5):
        response = client.post(
            "/api/auth/forgot-password",
            {"email": admin.email},
            format="json",
            REMOTE_ADDR="198.51.100.51",
        )
        assert response.status_code == 202
    active_token = ActionToken.objects.get(
        user=admin,
        kind=ActionToken.Kind.RESET_PASSWORD,
        used_at__isnull=True,
    )
    sent_before_throttled_request = EmailOutbox.objects.filter(
        to_email=admin.email, template="reset_password"
    ).count()
    throttled = client.post(
        "/api/auth/forgot-password",
        {"email": admin.email},
        format="json",
        REMOTE_ADDR="198.51.100.51",
    )
    assert throttled.status_code == 202
    assert (
        ActionToken.objects.get(
            user=admin,
            kind=ActionToken.Kind.RESET_PASSWORD,
            used_at__isnull=True,
        ).pk
        == active_token.pk
    )
    assert before_tokens == 0
    assert (
        EmailOutbox.objects.filter(to_email=admin.email, template="reset_password").count()
        == sent_before_throttled_request
        == before_mail + 5
    )
    cache.clear()


def test_public_registration_and_recovery_endpoints_fail_closed_at_budget(organization, admin):
    pending = User.objects.create_user(
        email="pending-budget@example.test",
        password="A-strong-pending-password-2026!",
        organization=organization,
        name="Pending Budget",
        status=User.Status.INVITED,
        email_verified_at=None,
    )
    client = APIClient()
    with patch("api.auth_views._consume_public_budget", return_value=False) as budget:
        registration = client.post(
            "/api/auth/register",
            {
                "name": "Rate Limited Admin",
                "email": "rate-limited-registration@example.test",
                "password": "A-unique-production-password-2026!",
                "orgName": "Must Not Be Created",
                "designatedPort": "Port of Calabar",
            },
            format="json",
        )
        resend = client.post(
            "/api/auth/resend-verification",
            {"email": pending.email},
            format="json",
        )
        forgot = client.post(
            "/api/auth/forgot-password",
            {"email": admin.email},
            format="json",
        )

    assert registration.status_code == resend.status_code == forgot.status_code == 202
    assert not User.objects.filter(email="rate-limited-registration@example.test").exists()
    assert not Organization.objects.filter(name="Must Not Be Created").exists()
    assert not ActionToken.objects.filter(user__in=(pending, admin)).exists()
    assert not EmailOutbox.objects.filter(to_email__in=(pending.email, admin.email)).exists()
    assert [call.args[0] for call in budget.call_args_list] == [
        "register",
        "resend-verification",
        "forgot-password",
    ]


def test_mfa_failure_budget_survives_challenge_rotation_and_has_ip_budget(system_admin):
    from django.core.cache import cache

    cache.clear()
    client = APIClient()
    first = client.post(
        "/api/auth/login",
        {"email": system_admin.email, "password": SYSTEM_PASSWORD},
        format="json",
        REMOTE_ADDR="198.51.100.60",
    )
    first_id = first.json()["challengeId"]
    for _ in range(2):
        assert (
            client.post(
                "/api/auth/mfa/verify",
                {"challengeId": first_id, "code": "not-a-code"},
                format="json",
                REMOTE_ADDR="198.51.100.60",
            ).status_code
            == 401
        )
    second = client.post(
        "/api/auth/login",
        {"email": system_admin.email, "password": SYSTEM_PASSWORD},
        format="json",
        REMOTE_ADDR="198.51.100.60",
    )
    second_id = second.json()["challengeId"]
    assert second_id != first_id
    assert not MFAChallenge.objects.filter(pk=first_id).exists()
    for _ in range(3):
        assert (
            client.post(
                "/api/auth/mfa/verify",
                {"challengeId": second_id, "code": "not-a-code"},
                format="json",
                REMOTE_ADDR="198.51.100.60",
            ).status_code
            == 401
        )
    third = client.post(
        "/api/auth/login",
        {"email": system_admin.email, "password": SYSTEM_PASSWORD},
        format="json",
        REMOTE_ADDR="198.51.100.60",
    )
    assert (
        client.post(
            "/api/auth/mfa/verify",
            {
                "challengeId": third.json()["challengeId"],
                "code": pyotp.TOTP(MFA_SECRET).now(),
            },
            format="json",
            REMOTE_ADDR="198.51.100.60",
        ).status_code
        == 401
    )

    cache.clear()
    fresh = client.post(
        "/api/auth/login",
        {"email": system_admin.email, "password": SYSTEM_PASSWORD},
        format="json",
        REMOTE_ADDR="198.51.100.61",
    )
    for attempt in range(24):
        assert (
            client.post(
                "/api/auth/mfa/verify",
                {"challengeId": f"missing-{attempt}", "code": "not-a-code"},
                format="json",
                REMOTE_ADDR="198.51.100.61",
            ).status_code
            == 401
        )
    blocked = client.post(
        "/api/auth/mfa/verify",
        {
            "challengeId": fresh.json()["challengeId"],
            "code": pyotp.TOTP(MFA_SECRET).now(),
        },
        format="json",
        REMOTE_ADDR="198.51.100.61",
    )
    assert blocked.status_code == 401
    assert blocked.json()["detail"] == "Too many attempts. Try again later"
    cache.clear()


@override_settings(SYSTEM_ADMIN_MUTATIONS_ENABLED=False)
def test_mutation_feature_flag_fails_closed_without_state_change(system_admin):
    client = system_client(system_admin)
    response = client.post(
        "/api/system/organizations",
        {
            "name": "Must Not Exist",
            "initialAdmin": {"name": "No Admin", "email": "no-admin@example.test"},
        },
        format="json",
        HTTP_IDEMPOTENCY_KEY="disabled-mutation-001",
    )
    assert response.status_code == 503
    assert not Organization.objects.filter(name="Must Not Exist").exists()
    assert not PlatformMutationRequest.objects.filter(actor=system_admin).exists()


def test_mutation_flag_file_toggles_immediately_and_fails_closed(tmp_path, system_admin):
    from api.system_admin_views import SystemMutationsDisabled, require_system_mutations

    flag = tmp_path / "system-admin-mutations-test.flag"
    client = system_client(system_admin)
    with override_settings(
        SYSTEM_ADMIN_MUTATION_FLAG_FILE=str(flag),
        SYSTEM_ADMIN_MUTATIONS_ENABLED=True,
    ):
        with pytest.raises(SystemMutationsDisabled):
            require_system_mutations()
        access = client.get("/api/system/account")
        assert access.status_code == 200
        assert access.json()["platformAccess"]["mutationsEnabled"] is False
        flag.write_text("malformed\n", encoding="utf-8")
        with pytest.raises(SystemMutationsDisabled):
            require_system_mutations()
        flag.write_bytes(b"\xff\xfe")
        with pytest.raises(SystemMutationsDisabled):
            require_system_mutations()
        flag.write_text("enabled\n", encoding="utf-8")
        require_system_mutations()
        access = client.get("/api/system/account")
        assert access.json()["platformAccess"]["mutationsEnabled"] is True
        flag.write_text("disabled\n", encoding="utf-8")
        with pytest.raises(SystemMutationsDisabled):
            require_system_mutations()
        access = client.get("/api/system/account")
        assert access.json()["platformAccess"]["mutationsEnabled"] is False


def test_unknown_runtime_environment_fails_system_mutations_closed(system_admin):
    from api.system_admin_views import SystemMutationsDisabled, require_system_mutations

    client = system_client(system_admin)
    with override_settings(
        ENVIRONMENT="qa-typo",
        EMAIL_DELIVERY_BACKEND="resend",
        RESEND_API_KEY="re_test_ready",
        EMAIL_FROM="Vessel Caller <staging@example.test>",
        SYSTEM_ADMIN_MUTATION_FLAG_FILE="",
        SYSTEM_ADMIN_MUTATIONS_ENABLED=True,
    ):
        with pytest.raises(SystemMutationsDisabled):
            require_system_mutations()
        access = client.get("/api/system/account")
        assert access.status_code == 200
        assert access.json()["platformAccess"]["environment"] == "qa-typo"
        assert access.json()["platformAccess"]["emailDeliveryReady"] is True
        assert access.json()["platformAccess"]["mutationsEnabled"] is False


@override_settings(SYSTEM_ADMIN_MUTATIONS_ENABLED=True)
def test_platform_container_and_cross_organization_targets_are_hidden(system_admin):
    client = system_client(system_admin)
    assert (
        client.get(f"/api/system/organizations/{system_admin.organization_id}").status_code == 404
    )
    assert client.get("/api/system/organizations").json()["count"] == 0

    first = create_customer("First Customer")
    second = create_customer("Second Customer")
    second_user = create_customer_user(second, email="admin@second.test")
    invitation = Invitation.objects.create(
        organization=second,
        name="Second Invite",
        email="invite@second.test",
        role=User.Role.ADMIN,
        token_hash="second-invite-hash",
        invited_by=system_admin,
        expires_at=timezone.now() + timedelta(days=1),
    )
    assert (
        client.post(
            f"/api/system/organizations/{first.id}/invitations/{invitation.id}/resend",
            format="json",
            HTTP_IDEMPOTENCY_KEY="cross-org-invite-001",
        ).status_code
        == 404
    )
    assert (
        client.post(
            f"/api/system/organizations/{first.id}/users/{second_user.id}/send-password-reset",
            {"reason": "Support request"},
            format="json",
            HTTP_IDEMPOTENCY_KEY="cross-org-user-001",
        ).status_code
        == 404
    )


def test_system_control_plane_read_filters_and_scoped_audit(system_admin):
    active = create_customer("Alpha Shipping")
    active.rc_number = "RC-ALPHA"
    active.email = "office@alpha.test"
    active.save(update_fields=("rc_number", "email", "updated_at"))
    suspended = create_customer("Beta Shipping")
    suspended.access_status = Organization.AccessStatus.SUSPENDED
    suspended.registered = False
    suspended.suspended_at = timezone.now()
    suspended.suspension_reason = "Private review"
    suspended.save(
        update_fields=(
            "access_status",
            "registered",
            "suspended_at",
            "suspension_reason",
            "updated_at",
        )
    )
    alpha_admin = create_customer_user(active, email="admin@alpha.test")
    create_customer_user(active, email="viewer@alpha.test", role=User.Role.VIEWER)
    create_customer_user(
        active,
        email="old-admin@alpha.test",
        status=User.Status.SUSPENDED,
    )
    Invitation.objects.create(
        organization=active,
        name="Pending Admin",
        email="pending-admin@alpha.test",
        role=User.Role.ADMIN,
        token_hash="alpha-admin-pending",
        invited_by=system_admin,
        expires_at=timezone.now() + timedelta(days=1),
    )
    Invitation.objects.create(
        organization=active,
        name="Pending Viewer",
        email="pending-viewer@alpha.test",
        role=User.Role.VIEWER,
        token_hash="alpha-viewer-pending",
        invited_by=system_admin,
        expires_at=timezone.now() + timedelta(days=1),
    )
    event = record_platform_event(
        organization=active,
        actor=system_admin,
        action="platform.organization.read_filter_test",
        target=alpha_admin,
        target_label=alpha_admin.email,
    )
    client = system_client(system_admin)

    overview = client.get("/api/system/overview")
    assert overview.status_code == 200
    assert overview.json()["organizationCount"] == 2
    assert overview.json()["activeOrganizationCount"] == 1
    assert overview.json()["suspendedOrganizationCount"] == 1
    assert overview.json()["activeUserCount"] == 2
    assert overview.json()["pendingInvitationCount"] == 1
    assert len(overview.json()["recentOrganizations"]) == 2

    filtered = client.get(
        "/api/system/organizations",
        {
            "search": "RC-ALPHA",
            "status": Organization.AccessStatus.ACTIVE,
            "registered": "true",
            "primaryPort": "Port of Calabar",
        },
    )
    assert filtered.status_code == 200
    assert [item["id"] for item in filtered.json()["results"]] == [active.id]
    assert client.get("/api/system/organizations", {"registered": "false"}).json()["count"] == 1

    users = client.get(
        f"/api/system/organizations/{active.id}/users",
        {"search": "admin@alpha", "role": User.Role.ADMIN, "status": User.Status.ACTIVE},
    )
    assert users.status_code == 200
    assert [item["id"] for item in users.json()["results"]] == [alpha_admin.id]
    invitations = client.get(f"/api/system/organizations/{active.id}/invitations")
    assert invitations.status_code == 200
    assert [item["role"] for item in invitations.json()["results"]] == [User.Role.ADMIN]

    by_path = client.get(f"/api/system/organizations/{active.id}/audit")
    assert by_path.status_code == 200 and by_path.json()["count"] == 1
    by_query = client.get(
        "/api/system/audit",
        {"organizationId": active.id, "action": event.action, "actor": system_admin.id},
    )
    assert by_query.status_code == 200 and by_query.json()["count"] == 1


@override_settings(SYSTEM_ADMIN_MUTATIONS_ENABLED=True)
def test_system_admin_invitation_and_recovery_actions_cover_success_and_fail_closed_paths(
    system_admin,
):
    organization = create_customer("Admin Recovery Customer")
    tenant_admin = create_customer_user(organization, email="tenant-admin@recovery.test")
    viewer = create_customer_user(
        organization,
        email="tenant-viewer@recovery.test",
        role=User.Role.VIEWER,
    )
    tenant_admin.mfa_secret = encrypt_secret(MFA_SECRET)
    tenant_admin.mfa_enabled_at = timezone.now()
    tenant_admin.save(update_fields=("mfa_secret", "mfa_enabled_at", "updated_at"))
    generate_recovery_codes(tenant_admin)
    MFAChallenge.objects.create(
        user=tenant_admin,
        expires_at=timezone.now() + timedelta(minutes=5),
    )
    client = system_client(system_admin)
    invitations_url = f"/api/system/organizations/{organization.id}/invitations"

    created = client.post(
        invitations_url,
        {"name": "New Tenant Admin", "email": "new-admin@recovery.test"},
        format="json",
        HTTP_IDEMPOTENCY_KEY="system-invite-create-001",
    )
    assert created.status_code == 201
    invitation_id = created.json()["invitation"]["id"]
    duplicate = client.post(
        invitations_url,
        {"name": "Duplicate", "email": "new-admin@recovery.test"},
        format="json",
        HTTP_IDEMPOTENCY_KEY="system-invite-duplicate-001",
    )
    assert duplicate.status_code == 400
    existing_user = client.post(
        invitations_url,
        {"name": "Existing", "email": tenant_admin.email},
        format="json",
        HTTP_IDEMPOTENCY_KEY="system-invite-existing-001",
    )
    assert existing_user.status_code == 400
    duplicate_body = duplicate.json()
    existing_user_body = existing_user.json()
    assert (
        duplicate_body["detail"]
        == existing_user_body["detail"]
        == ("The request could not be completed")
    )
    assert (
        duplicate_body["errors"]
        == existing_user_body["errors"]
        == {"email": ["An invitation could not be created for this email"]}
    )
    serialized_errors = json.dumps([duplicate_body, existing_user_body]).lower()
    assert "exists" not in serialized_errors
    assert "pending" not in serialized_errors
    assert tenant_admin.email not in serialized_errors
    assert "new-admin@recovery.test" not in serialized_errors

    resent = client.post(
        f"{invitations_url}/{invitation_id}/resend",
        format="json",
        HTTP_IDEMPOTENCY_KEY="system-invite-resend-001",
    )
    assert resent.status_code == 200
    assert (
        client.post(
            f"{invitations_url}/missing/resend",
            format="json",
            HTTP_IDEMPOTENCY_KEY="system-invite-resend-missing",
        ).status_code
        == 404
    )
    revoked = client.delete(
        f"{invitations_url}/{invitation_id}",
        HTTP_IDEMPOTENCY_KEY="system-invite-revoke-001",
    )
    assert revoked.status_code == 200
    assert (
        client.delete(
            f"{invitations_url}/missing",
            HTTP_IDEMPOTENCY_KEY="system-invite-revoke-missing",
        ).status_code
        == 404
    )

    reset = client.post(
        f"/api/system/organizations/{organization.id}/users/{tenant_admin.id}/send-password-reset",
        {"reason": "Customer requested account recovery"},
        format="json",
        HTTP_IDEMPOTENCY_KEY="system-password-reset-001",
    )
    assert reset.status_code == 202
    assert ActionToken.objects.filter(
        user=tenant_admin,
        kind=ActionToken.Kind.RESET_PASSWORD,
    ).exists()
    assert (
        client.post(
            f"/api/system/organizations/{organization.id}/users/{viewer.id}/send-password-reset",
            {"reason": "Must be an Admin"},
            format="json",
            HTTP_IDEMPOTENCY_KEY="system-password-reset-viewer",
        ).status_code
        == 404
    )

    mfa_reset = client.post(
        f"/api/system/organizations/{organization.id}/users/{tenant_admin.id}/reset-mfa",
        {"reason": "Verified customer support recovery"},
        format="json",
        HTTP_IDEMPOTENCY_KEY="system-mfa-reset-001",
    )
    assert mfa_reset.status_code == 200
    tenant_admin.refresh_from_db()
    assert tenant_admin.mfa_enabled is False
    assert tenant_admin.recovery_codes.count() == 0
    assert not MFAChallenge.objects.filter(user=tenant_admin).exists()
    assert (
        client.post(
            f"/api/system/organizations/{organization.id}/users/{viewer.id}/reset-mfa",
            {"reason": "Must be an Admin"},
            format="json",
            HTTP_IDEMPOTENCY_KEY="system-mfa-reset-viewer",
        ).status_code
        == 404
    )


@override_settings(SYSTEM_ADMIN_MUTATIONS_ENABLED=True)
def test_system_organization_lifecycle_conflicts_noops_and_suspended_recovery_denials(
    system_admin,
):
    from organizations.services import (
        reactivate_customer_organization,
        suspend_customer_organization,
    )

    organization = create_customer("Lifecycle Customer")
    tenant_admin = create_customer_user(organization, email="admin@lifecycle.test")
    pending = Invitation.objects.create(
        organization=organization,
        name="Pending Lifecycle Admin",
        email="pending@lifecycle.test",
        role=User.Role.ADMIN,
        token_hash="lifecycle-pending",
        invited_by=system_admin,
        expires_at=timezone.now() + timedelta(days=1),
    )
    client = system_client(system_admin)
    suspend_url = f"/api/system/organizations/{organization.id}/suspend"
    reactivate_url = f"/api/system/organizations/{organization.id}/reactivate"
    assert (
        client.post(
            suspend_url,
            {"reason": "Verified lifecycle test", "revision": organization.revision + 1},
            format="json",
            HTTP_IDEMPOTENCY_KEY="system-suspend-conflict-001",
        ).status_code
        == 409
    )
    suspended = client.post(
        suspend_url,
        {"reason": "Verified lifecycle test", "revision": organization.revision},
        format="json",
        HTTP_IDEMPOTENCY_KEY="system-suspend-001",
    )
    assert suspended.status_code == 200
    organization.refresh_from_db()
    assert (
        client.post(
            suspend_url,
            {"reason": "Already suspended", "revision": organization.revision},
            format="json",
            HTTP_IDEMPOTENCY_KEY="system-suspend-noop-001",
        ).status_code
        == 200
    )
    assert (
        client.post(
            f"/api/system/organizations/{organization.id}/invitations",
            {"name": "Blocked", "email": "blocked@lifecycle.test"},
            format="json",
            HTTP_IDEMPOTENCY_KEY="system-suspended-invite-001",
        ).status_code
        == 400
    )
    assert (
        client.post(
            f"/api/system/organizations/{organization.id}/invitations/{pending.id}/resend",
            format="json",
            HTTP_IDEMPOTENCY_KEY="system-suspended-resend-001",
        ).status_code
        == 400
    )
    for action, key in (
        ("send-password-reset", "system-suspended-password-reset"),
        ("reset-mfa", "system-suspended-mfa-reset"),
    ):
        assert (
            client.post(
                f"/api/system/organizations/{organization.id}/users/{tenant_admin.id}/{action}",
                {"reason": "Blocked while suspended"},
                format="json",
                HTTP_IDEMPOTENCY_KEY=key,
            ).status_code
            == 400
        )
    assert (
        client.post(
            reactivate_url,
            {"reason": "Review complete", "revision": organization.revision + 1},
            format="json",
            HTTP_IDEMPOTENCY_KEY="system-reactivate-conflict-001",
        ).status_code
        == 409
    )
    reactivated = client.post(
        reactivate_url,
        {"reason": "Review complete", "revision": organization.revision},
        format="json",
        HTTP_IDEMPOTENCY_KEY="system-reactivate-001",
    )
    assert reactivated.status_code == 200
    organization.refresh_from_db()
    assert (
        client.post(
            reactivate_url,
            {"reason": "Already active", "revision": organization.revision},
            format="json",
            HTTP_IDEMPOTENCY_KEY="system-reactivate-noop-001",
        ).status_code
        == 200
    )
    assert suspend_customer_organization(
        organization=Organization.objects.get(pk=organization.pk),
        actor=system_admin,
        reason="Direct service coverage",
    )
    assert (
        suspend_customer_organization(
            organization=Organization.objects.get(pk=organization.pk),
            actor=system_admin,
            reason="Already suspended",
        )
        is False
    )
    assert reactivate_customer_organization(
        organization=Organization.objects.get(pk=organization.pk),
        actor=system_admin,
        reason="Direct service coverage",
    )
    assert (
        reactivate_customer_organization(
            organization=Organization.objects.get(pk=organization.pk),
            actor=system_admin,
            reason="Already active",
        )
        is False
    )
    with pytest.raises(ValueError, match="customer organizations"):
        suspend_customer_organization(
            organization=system_admin.organization,
            actor=system_admin,
            reason="Must fail",
        )
    with pytest.raises(ValueError, match="customer organizations"):
        reactivate_customer_organization(
            organization=system_admin.organization,
            actor=system_admin,
            reason="Must fail",
        )


def test_platform_audit_events_are_immutable(system_admin):
    organization = create_customer("Immutable Audit Customer")
    event = record_platform_event(
        organization=organization,
        actor=system_admin,
        action="platform.test.immutable",
        target=organization,
    )
    event.reason = "changed"
    with pytest.raises(TypeError):
        event.save()
    with pytest.raises(TypeError):
        event.delete()
    with pytest.raises(TypeError):
        PlatformAuditEvent.objects.filter(pk=event.pk).update(reason="changed")


@override_settings(ENVIRONMENT="test", EMAIL_DELIVERY_BACKEND="memory")
def test_revoke_command_refuses_last_operational_system_admin(system_admin):
    from django.core.management.base import CommandError

    with pytest.raises(CommandError, match="last active System Administrator"):
        call_command(
            "revoke_system_admin",
            email=system_admin.email,
            reason="Should be blocked",
            change_id="CHG-last-admin-001",
            environment="test",
            confirm=True,
        )
    assert system_admin.platform_access_grants.get().active


@pytest.mark.parametrize(
    ("option_overrides", "setting_overrides", "error"),
    [
        ({"confirm": False}, {}, "without --confirm"),
        ({"environment": "production"}, {}, "Environment mismatch"),
        ({}, {"EMAIL_DELIVERY_BACKEND": "console"}, "requires verified Resend"),
        (
            {},
            {"EMAIL_DELIVERY_BACKEND": "resend", "RESEND_API_KEY": ""},
            "VC_RESEND_API_KEY is missing",
        ),
        ({"name": ""}, {}, "Email, name, and reason are required"),
        ({"change_id": "?"}, {}, "bounded opaque --change-id"),
        ({"email": "not-an-email"}, {}, "valid email address"),
    ],
)
@override_settings(ENVIRONMENT="test", EMAIL_DELIVERY_BACKEND="memory")
def test_provision_command_validation_fails_before_state_change(
    option_overrides, setting_overrides, error
):
    options = {
        "email": "validation-operator@vesselcalls.test",
        "name": "Validation Operator",
        "reason": "Approved validation test",
        "change_id": "CHG-validation-001",
        "environment": "test",
        "confirm": True,
    }
    options.update(option_overrides)
    with override_settings(**setting_overrides):
        with pytest.raises(CommandError, match=error):
            call_command("provision_system_admin", **options)
    assert not PlatformAccessGrant.objects.exists()


@override_settings(ENVIRONMENT="test", EMAIL_DELIVERY_BACKEND="memory")
def test_provision_command_rejects_customer_and_staff_identities_and_repairs_expired_setup():
    customer = create_customer("Provision Conflict Customer")
    customer_user = create_customer_user(customer, email="customer-conflict@vesselcalls.test")
    with pytest.raises(CommandError, match="customer organization"):
        call_command(
            "provision_system_admin",
            email=customer_user.email,
            name="Wrong Boundary",
            reason="Must be rejected",
            change_id="CHG-customer-conflict",
            environment="test",
            confirm=True,
        )

    platform = Organization.objects.create(
        kind=Organization.Kind.PLATFORM,
        name="Vessel Caller Platform Administration",
        email="platform@vesselcalls.test",
        registered=True,
    )
    OrganizationSettings.objects.create(organization=platform)
    staff = User.objects.create_user(
        organization=platform,
        email="staff-conflict@vesselcalls.test",
        password=SYSTEM_PASSWORD,
        name="Staff Conflict",
        role=User.Role.VIEWER,
        status=User.Status.ACTIVE,
        email_verified_at=timezone.now(),
        is_staff=True,
    )
    with pytest.raises(CommandError, match="dedicated non-staff"):
        call_command(
            "provision_system_admin",
            email=staff.email,
            name=staff.name,
            reason="Must be rejected",
            change_id="CHG-staff-conflict",
            environment="test",
            confirm=True,
        )

    pending = User.objects.create_user(
        organization=platform,
        email="pending-setup@vesselcalls.test",
        password=None,
        name="Pending Setup",
        role=User.Role.VIEWER,
        status=User.Status.INVITED,
    )
    active_grant = PlatformAccessGrant.objects.create(
        user=pending,
        role=PlatformAccessGrant.Role.SYSTEM_ADMIN,
        reason="Pending initial setup",
    )
    with patch("accounts.services.deliver_outbox_email.delay"):
        call_command(
            "provision_system_admin",
            email=pending.email,
            name=pending.name,
            reason="Resend approved setup",
            change_id="CHG-resend-setup",
            environment="test",
            confirm=True,
        )
    active_grant.refresh_from_db()
    assert active_grant.active
    assert PlatformAuditEvent.objects.filter(action="platform.system_admin.setup_resent").exists()

    expired = User.objects.create_user(
        organization=platform,
        email="expired-setup@vesselcalls.test",
        password=None,
        name="Expired Setup",
        role=User.Role.VIEWER,
        status=User.Status.INVITED,
    )
    expired_grant = PlatformAccessGrant.objects.create(
        user=expired,
        role=PlatformAccessGrant.Role.SYSTEM_ADMIN,
        reason="Expired setup",
        expires_at=timezone.now() - timedelta(minutes=1),
    )
    with patch("accounts.services.deliver_outbox_email.delay"):
        call_command(
            "provision_system_admin",
            email=expired.email,
            name=expired.name,
            reason="Re-approved after expiry",
            change_id="CHG-expired-setup",
            environment="test",
            confirm=True,
        )
    expired_grant.refresh_from_db()
    assert expired_grant.revoked_at is not None
    assert PlatformAccessGrant.objects.filter(user=expired, revoked_at__isnull=True).count() == 1

    inconsistent = User.objects.create_user(
        organization=platform,
        email="inconsistent-setup@vesselcalls.test",
        password=SYSTEM_PASSWORD,
        name="Inconsistent Setup",
        role=User.Role.VIEWER,
        status=User.Status.SUSPENDED,
        email_verified_at=None,
        mfa_secret=encrypt_secret(MFA_SECRET),
        mfa_enabled_at=timezone.now(),
    )
    PlatformAccessGrant.objects.create(
        user=inconsistent,
        role=PlatformAccessGrant.Role.SYSTEM_ADMIN,
        reason="Inconsistent legacy grant",
    )
    with patch("accounts.services.deliver_outbox_email.delay"):
        call_command(
            "provision_system_admin",
            email=inconsistent.email,
            name=inconsistent.name,
            reason="Securely repair inconsistent grant",
            change_id="CHG-inconsistent-setup",
            environment="test",
            confirm=True,
        )
    inconsistent.refresh_from_db()
    assert inconsistent.status == User.Status.INVITED
    assert not inconsistent.has_usable_password()
    assert inconsistent.mfa_enabled is False


@pytest.mark.parametrize(
    ("option_overrides", "error"),
    [
        ({"confirm": False}, "without --confirm"),
        ({"environment": "production"}, "Environment mismatch"),
        ({"reason": ""}, "revocation reason"),
        ({"change_id": "?"}, "bounded opaque --change-id"),
        ({}, "Platform organization not found"),
    ],
)
@override_settings(ENVIRONMENT="test", EMAIL_DELIVERY_BACKEND="memory")
def test_revoke_command_validation_fails_closed(option_overrides, error):
    options = {
        "email": "missing-operator@vesselcalls.test",
        "reason": "Approved revocation",
        "change_id": "CHG-revoke-validation",
        "environment": "test",
        "confirm": True,
    }
    options.update(option_overrides)
    with pytest.raises(CommandError, match=error):
        call_command("revoke_system_admin", **options)


@override_settings(ENVIRONMENT="test", EMAIL_DELIVERY_BACKEND="memory")
def test_revoke_command_missing_inactive_actor_and_notice_failure_paths(platform_organization):
    with pytest.raises(CommandError, match="identity not found"):
        call_command(
            "revoke_system_admin",
            email="missing@vesselcalls.test",
            reason="Missing identity",
            change_id="CHG-missing-identity",
            environment="test",
            confirm=True,
        )
    inactive = User.objects.create_user(
        organization=platform_organization,
        email="inactive@vesselcalls.test",
        password=SYSTEM_PASSWORD,
        name="Inactive Grant",
        role=User.Role.VIEWER,
        status=User.Status.ACTIVE,
        email_verified_at=timezone.now(),
    )
    call_command(
        "revoke_system_admin",
        email=inactive.email,
        reason="Already inactive",
        change_id="CHG-already-inactive",
        environment="test",
        confirm=True,
    )

    target = create_customer_user(
        platform_organization,
        email="revoke-target@vesselcalls.test",
        role=User.Role.VIEWER,
    )
    target.mfa_secret = encrypt_secret(MFA_SECRET)
    target.mfa_enabled_at = timezone.now()
    target.save(update_fields=("mfa_secret", "mfa_enabled_at", "updated_at"))
    PlatformAccessGrant.objects.create(
        user=target,
        role=PlatformAccessGrant.Role.SYSTEM_ADMIN,
        reason="Target",
    )
    replacement = create_customer_user(
        platform_organization,
        email="revoke-replacement@vesselcalls.test",
        role=User.Role.VIEWER,
    )
    replacement.mfa_secret = encrypt_secret(MFA_SECRET)
    replacement.mfa_enabled_at = timezone.now()
    replacement.save(update_fields=("mfa_secret", "mfa_enabled_at", "updated_at"))
    PlatformAccessGrant.objects.create(
        user=replacement,
        role=PlatformAccessGrant.Role.SYSTEM_ADMIN,
        reason="Replacement",
    )
    with pytest.raises(CommandError, match="actor identity not found"):
        call_command(
            "revoke_system_admin",
            email=target.email,
            reason="Bad actor",
            change_id="CHG-bad-actor",
            actor_email="missing-actor@vesselcalls.test",
            environment="test",
            confirm=True,
        )
    with patch(
        "accounts.management.commands.revoke_system_admin.queue_security_notice",
        side_effect=RuntimeError("provider unavailable"),
    ):
        call_command(
            "revoke_system_admin",
            email=target.email,
            reason="Approved revocation despite notice outage",
            change_id="CHG-notice-outage",
            actor_email=replacement.email,
            environment="test",
            confirm=True,
        )
    target.refresh_from_db()
    assert target.status == User.Status.SUSPENDED


def test_platform_audit_search_and_export_are_filtered_and_formula_safe(system_admin):
    organization = create_customer("Audit Customer")
    request = SimpleNamespace(
        request_id="request-fragment-123",
        META={
            "REMOTE_ADDR": "127.0.0.1",
            "HTTP_X_FORWARDED_FOR": "203.0.113.9, 198.51.100.77",
            "HTTP_USER_AGENT": "pytest",
        },
    )
    record_platform_event(
        organization=organization,
        actor=system_admin,
        action="=platform.audit.test",
        target=organization,
        target_label="@dangerous-label",
        reason="-formula reason",
        request=request,
    )
    client = system_client(system_admin)
    searched = client.get("/api/system/audit?search=request-fragment")
    assert searched.status_code == 200
    assert searched.json()["count"] == 1
    action_search = client.get("/api/system/audit?search=platform.audit")
    assert action_search.json()["count"] == 1

    exported = client.get("/api/system/audit/export?search=request-fragment")
    assert exported.status_code == 200
    rows = list(csv.reader(io.StringIO(exported.content.decode())))
    assert len(rows) == 2
    row = dict(zip(rows[0], rows[1], strict=True))
    assert row["action"].startswith("'")
    assert row["target_label"].startswith("'")
    assert row["reason"].startswith("'")
    assert row["ip_address"] == "198.51.100.77"


@override_settings(ENVIRONMENT="test", EMAIL_DELIVERY_BACKEND="memory")
def test_provision_and_revoke_commands_enforce_controlled_identity_lifecycle():
    with patch("accounts.services.deliver_outbox_email.delay"):
        call_command(
            "provision_system_admin",
            email="operator@vesselcalls.test",
            name="Platform Operator",
            reason="Approved operations role",
            change_id="CHG-provision-001",
            environment="test",
            confirm=True,
        )
    user = User.objects.get(email="operator@vesselcalls.test")
    grant = PlatformAccessGrant.objects.get(user=user, revoked_at__isnull=True)
    token = ActionToken.objects.get(user=user, kind=ActionToken.Kind.RESET_PASSWORD)
    assert user.organization.kind == Organization.Kind.PLATFORM
    assert user.role == User.Role.VIEWER
    assert not user.is_staff and not user.is_superuser
    assert not user.has_usable_password()
    assert user.status == User.Status.INVITED
    assert user.email_verified_at is None
    assert timedelta(hours=23, minutes=59) < token.expires_at - timezone.now()
    assert grant.active

    outbox = EmailOutbox.objects.get(idempotency_key=f"system-admin-setup:{token.id}")
    context = json.loads(decrypt_secret(outbox.context["ciphertext"]))
    raw = parse_qs(urlparse(context["actionUrl"]).query)["token"][0]
    completed = APIClient().post(
        "/api/auth/reset-password",
        {"token": raw, "password": SYSTEM_PASSWORD},
        format="json",
    )
    assert completed.status_code == 200
    user.refresh_from_db()
    assert user.status == User.Status.ACTIVE
    assert user.email_verified_at is not None
    user.mfa_secret = encrypt_secret(MFA_SECRET)
    user.mfa_enabled_at = timezone.now()
    user.save(update_fields=("mfa_secret", "mfa_enabled_at", "updated_at"))
    outbox_count = EmailOutbox.objects.count()
    with patch("accounts.services.deliver_outbox_email.delay"):
        call_command(
            "provision_system_admin",
            email=user.email,
            name="Silently Changed Name",
            reason="Idempotent rerun",
            change_id="CHG-provision-002",
            environment="test",
            confirm=True,
        )
    user.refresh_from_db()
    assert user.name == "Platform Operator"
    assert EmailOutbox.objects.count() == outbox_count

    replacement = User.objects.create_user(
        email="replacement@vesselcalls.test",
        password=SYSTEM_PASSWORD,
        organization=user.organization,
        name="Replacement Operator",
        role=User.Role.VIEWER,
        status=User.Status.ACTIVE,
        email_verified_at=timezone.now(),
        mfa_secret=encrypt_secret(MFA_SECRET),
        mfa_enabled_at=timezone.now(),
    )
    PlatformAccessGrant.objects.create(
        user=replacement,
        role=PlatformAccessGrant.Role.SYSTEM_ADMIN,
        reason="Replacement",
    )
    user.set_password(SYSTEM_PASSWORD)
    user.mfa_secret = encrypt_secret(MFA_SECRET)
    user.mfa_enabled_at = timezone.now()
    user.save(update_fields=("password", "mfa_secret", "mfa_enabled_at", "updated_at"))
    generate_recovery_codes(user)

    with patch("accounts.services.deliver_outbox_email.delay"):
        call_command(
            "revoke_system_admin",
            email=user.email,
            reason="Role ended",
            change_id="CHG-revoke-001",
            actor_email=replacement.email,
            environment="test",
            confirm=True,
        )
    user.refresh_from_db()
    grant.refresh_from_db()
    assert user.status == User.Status.SUSPENDED
    assert not user.mfa_enabled
    assert user.recovery_codes.count() == 0
    assert grant.revoked_at is not None
    assert authenticate(email=user.email, password=SYSTEM_PASSWORD) is None
    assert PlatformAuditEvent.objects.filter(
        action="platform.system_admin.revoked",
        actor=replacement,
    ).exists()

    with patch("accounts.services.deliver_outbox_email.delay"):
        call_command(
            "provision_system_admin",
            email=user.email,
            name="Reprovisioned Operator",
            reason="Approved return",
            change_id="CHG-provision-003",
            environment="test",
            confirm=True,
        )
    user.refresh_from_db()
    assert user.status == User.Status.INVITED
    assert user.email_verified_at is None
    assert not user.has_usable_password()
    assert authenticate(email=user.email, password=SYSTEM_PASSWORD) is None


def test_platform_identity_login_and_mfa_are_mirrored_to_platform_audit(system_admin):
    client = APIClient()
    login = client.post(
        "/api/auth/login",
        {"email": system_admin.email, "password": SYSTEM_PASSWORD},
        format="json",
    )
    assert login.status_code == 202
    verified = client.post(
        "/api/auth/mfa/verify",
        {
            "challengeId": login.json()["challengeId"],
            "code": pyotp.TOTP(MFA_SECRET).now(),
        },
        format="json",
    )
    assert verified.status_code == 200
    assert verified.json()["org"] is None
    assert client.get("/api/state").status_code == 403
    assert PlatformAuditEvent.objects.filter(
        action="session.login_mfa",
        actor=system_admin,
    ).exists()
    assert AuditEvent.objects.filter(action="session.login_mfa", actor=system_admin).exists()


def test_platform_mfa_cannot_be_disabled_or_rotated_with_password_only(system_admin):
    first = APIClient()
    second = APIClient()
    for client in (first, second):
        login = client.post(
            "/api/auth/login",
            {"email": system_admin.email, "password": SYSTEM_PASSWORD},
            format="json",
        )
        assert login.status_code == 202
        assert (
            client.post(
                "/api/auth/mfa/verify",
                {
                    "challengeId": login.json()["challengeId"],
                    "code": pyotp.TOTP(MFA_SECRET).now(),
                },
                format="json",
            ).status_code
            == 200
        )
    session = first.session
    session["mfa_verified_at"] = timezone.now().timestamp() - 901
    session.save()
    stale_password_only = first.post(
        "/api/auth/mfa/setup",
        {"currentPassword": SYSTEM_PASSWORD},
        format="json",
    )
    assert stale_password_only.status_code == 403
    assert stale_password_only.json()["errors"]["code"] == "system_mfa_step_up_required"
    assert (
        first.delete(
            "/api/auth/mfa",
            {"password": SYSTEM_PASSWORD, "code": pyotp.TOTP(MFA_SECRET).now()},
            format="json",
        ).status_code
        == 400
    )

    original_secret = system_admin.mfa_secret
    setup = first.post(
        "/api/auth/mfa/setup",
        {
            "currentPassword": SYSTEM_PASSWORD,
            "currentCode": pyotp.TOTP(MFA_SECRET).now(),
        },
        format="json",
    )
    assert setup.status_code == 200
    system_admin.refresh_from_db()
    assert system_admin.mfa_secret == original_secret
    confirmed = first.post(
        "/api/auth/mfa/confirm",
        {"code": pyotp.TOTP(setup.json()["secret"]).now()},
        format="json",
    )
    assert confirmed.status_code == 200
    system_admin.refresh_from_db()
    assert system_admin.mfa_secret != original_secret
    assert first.get("/api/auth/me").status_code == 200
    assert second.get("/api/auth/me").status_code in {401, 403}
    assert PlatformAuditEvent.objects.filter(
        actor=system_admin,
        action="account.mfa_enabled",
    ).exists()


def test_public_product_auth_and_recovery_reject_django_staff(platform_organization):
    staff = User.objects.create_user(
        email="staff-public-denied@vesselcalls.test",
        password=SYSTEM_PASSWORD,
        organization=platform_organization,
        name="Staff Only",
        role=User.Role.ADMIN,
        status=User.Status.ACTIVE,
        email_verified_at=timezone.now(),
        is_staff=True,
        is_superuser=True,
    )
    client = APIClient()
    assert (
        client.post(
            "/api/auth/login",
            {"email": staff.email, "password": SYSTEM_PASSWORD},
            format="json",
        ).status_code
        == 401
    )
    before = EmailOutbox.objects.count()
    assert (
        client.post(
            "/api/auth/resend-verification",
            {"email": staff.email},
            format="json",
        ).status_code
        == 202
    )
    assert (
        client.post("/api/auth/forgot-password", {"email": staff.email}, format="json").status_code
        == 202
    )
    assert EmailOutbox.objects.count() == before
    token, raw = issue_action_token(staff, ActionToken.Kind.RESET_PASSWORD, hours=1)
    reset = client.post(
        "/api/auth/reset-password",
        {"token": raw, "password": "A-different-password-2026!"},
        format="json",
    )
    assert reset.status_code == 400
    token.refresh_from_db()
    staff.refresh_from_db()
    assert token.used_at is None
    assert staff.check_password(SYSTEM_PASSWORD)
    verify_token, verify_raw = issue_action_token(
        staff,
        ActionToken.Kind.VERIFY_EMAIL,
        hours=24,
    )
    staff.email_verified_at = None
    staff.status = User.Status.INVITED
    staff.save(update_fields=("email_verified_at", "status", "updated_at"))
    verify = client.post("/api/auth/verify-email", {"token": verify_raw}, format="json")
    assert verify.status_code == 400
    verify_token.refresh_from_db()
    staff.refresh_from_db()
    assert verify_token.used_at is None
    assert staff.status == User.Status.INVITED
