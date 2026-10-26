from __future__ import annotations

import json
from datetime import timedelta
from io import StringIO
from unittest.mock import patch

import pytest
from django.core.management import CommandError, call_command
from django.test import override_settings
from django.utils import timezone

from accounts.models import EmailOutbox, Invitation, PlatformAccessGrant, User
from organizations.models import Organization

pytestmark = pytest.mark.django_db


class EmptyBroker:
    def llen(self, key):
        return 0

    def hlen(self, key):
        return 0

    def zcard(self, key):
        return 0

    def close(self):
        pass


def customer(name):
    return Organization.objects.create(name=name, email="office@example.test", registered=True)


def member(organization, email, **changes):
    data = {
        "organization": organization,
        "name": "Scoped Account",
        "role": User.Role.ADMIN,
        "status": User.Status.ACTIVE,
        "email_verified_at": timezone.now(),
    }
    data.update(changes)
    return User.objects.create_user(email=email, password="Scoped-account-password-2026!", **data)


def operator(organization, email, **changes):
    user = member(
        organization,
        email,
        role=User.Role.VIEWER,
        mfa_secret="isolated-encrypted-secret",
        mfa_enabled_at=timezone.now(),
        **changes,
    )
    PlatformAccessGrant.objects.create(
        user=user,
        role=PlatformAccessGrant.Role.SYSTEM_ADMIN,
        reason="Isolated command verification",
    )
    return user


def user_state(user):
    return User.objects.values().get(pk=user.pk)


def platform_organization():
    return Organization.objects.create(
        kind=Organization.Kind.PLATFORM,
        name="Scoped Platform",
        email="platform@example.test",
        registered=True,
    )


def issue(organization, inviter, email):
    output = StringIO()
    call_command(
        "issue_release_admin_invitation",
        organization_id=organization.pk,
        invited_by=inviter,
        email=email,
        name="Scoped Invitee",
        stdout=output,
    )
    return output.getvalue()


def pending_invitation(organization, inviter, email):
    return Invitation.objects.create(
        organization=organization,
        invited_by=inviter,
        name="Scoped Invitation",
        email=email,
        role=User.Role.ADMIN,
        token_hash=f"scoped-invitation-{organization.pk}",
        expires_at=timezone.now() + timedelta(days=1),
    )


def preflight(*, fails=False):
    output = StringIO()
    with patch(
        "accounts.management.commands.system_admin_rollout_preflight.redis.Redis.from_url",
        return_value=EmptyBroker(),
    ):
        if fails:
            with pytest.raises(CommandError, match="rollout preflight failed"):
                call_command("system_admin_rollout_preflight", evidence_file="-", stdout=output)
        else:
            call_command("system_admin_rollout_preflight", evidence_file="-", stdout=output)
    return json.loads(output.getvalue()), output.getvalue()


def test_release_invitation_uses_target_organization_for_inviter_and_email(admin, organization):
    other = customer("Independent Organization")
    same_inviter = member(other, admin.email, role=User.Role.VIEWER)
    recipient = member(other, "shared-recipient@example.test")
    originals = {user.pk: user_state(user) for user in (admin, same_inviter, recipient)}

    output = issue(organization, admin.email.upper(), recipient.email.upper())

    invitation = Invitation.objects.get(organization=organization, email=recipient.email)
    assert invitation.invited_by_id == admin.pk
    assert invitation.role == User.Role.ADMIN
    assert "token=" not in output
    assert recipient.email not in output
    assert {user.pk: user_state(user) for user in (admin, same_inviter, recipient)} == originals
    assert (
        EmailOutbox.objects.get(
            idempotency_key=f"release-admin-invite:{invitation.pk}"
        ).organization_id
        == organization.pk
    )


def test_release_invitation_rejects_same_organization_existing_email(admin, organization):
    before = user_state(admin)
    with pytest.raises(CommandError, match="already exists"):
        issue(organization, admin.email, admin.email.upper())
    assert user_state(admin) == before
    assert not Invitation.objects.exists()
    assert not EmailOutbox.objects.exists()


def test_release_invitation_never_uses_other_organizations_admin(admin):
    other = customer("No Matching Inviter")
    before = user_state(admin)
    with pytest.raises(CommandError, match="active Admin"):
        issue(other, admin.email, "new-recipient@example.test")
    assert user_state(admin) == before
    assert not Invitation.objects.exists()


@pytest.mark.parametrize("kind", [Organization.Kind.PLATFORM, "suspended"])
def test_release_invitation_requires_active_customer_organization(admin, kind):
    if kind == Organization.Kind.PLATFORM:
        target = platform_organization()
    else:
        target = customer("Suspended Customer")
        target.access_status = Organization.AccessStatus.SUSPENDED
        target.suspended_at = timezone.now()
        target.suspension_reason = "Isolated target-state verification"
        target.save(update_fields=("access_status", "suspended_at", "suspension_reason"))
    with pytest.raises(CommandError, match="Active customer organization"):
        issue(target, admin.email, "blocked@example.test")
    assert not Invitation.objects.exists()


def test_release_invitation_cannot_be_issued_by_pending_temporary_admin(admin, organization):
    admin.password_change_required = True
    admin.save(update_fields=("password_change_required",))
    with pytest.raises(CommandError, match="active Admin"):
        issue(organization, admin.email, "new-recipient@example.test")
    assert not Invitation.objects.exists()


def test_preflight_allows_same_email_existing_only_in_another_customer_org(admin, organization):
    other = customer("Other Customer")
    recipient = member(other, "shared-recipient@example.test")
    invitation = pending_invitation(organization, admin, recipient.email.upper())
    before = user_state(recipient)

    evidence, output = preflight()

    assert evidence["passed"] is True
    assert evidence["counts"]["pendingInvitationEmailCollisions"] == 0
    assert evidence["platformIdentityEmailCollisions"]["count"] == 0
    assert recipient.email not in output.lower()
    assert user_state(recipient) == before
    invitation.refresh_from_db()
    assert invitation.status == Invitation.Status.PENDING


def test_preflight_still_detects_same_org_case_insensitive_invitation_collision(
    admin, organization
):
    invitation = pending_invitation(organization, admin, admin.email.upper())
    before = user_state(admin)

    evidence, output = preflight(fails=True)

    assert evidence["passed"] is False
    assert evidence["counts"]["pendingInvitationEmailCollisions"] == 1
    assert admin.email not in output.lower()
    assert user_state(admin) == before
    invitation.refresh_from_db()
    assert invitation.status == Invitation.Status.PENDING


def test_preflight_fails_closed_for_ambiguous_platform_email_without_mutation(organization):
    platform = platform_organization()
    customer_user = member(organization, "shared-platform@example.test")
    platform_user = operator(platform, customer_user.email)
    originals = {user.pk: user_state(user) for user in (customer_user, platform_user)}

    evidence, output = preflight(fails=True)

    assert evidence["passed"] is False
    assert evidence["platformIdentityEmailCollisions"]["count"] == 1
    assert customer_user.email not in output.lower()
    assert len(evidence["platformIdentityEmailCollisions"]["sha256"]) == 64
    assert {user.pk: user_state(user) for user in (customer_user, platform_user)} == originals


@override_settings(ENVIRONMENT="test", EMAIL_DELIVERY_BACKEND="memory")
@pytest.mark.parametrize("with_platform_identity", [False, True])
def test_platform_provision_never_selects_or_modifies_duplicate_customer_accounts(
    organization, with_platform_identity
):
    email = "shared-operator@example.test"
    first = member(organization, email)
    second = member(customer("Second Customer"), email)
    users = [first, second]
    if with_platform_identity:
        users.append(operator(platform_organization(), email))
    originals = {user.pk: user_state(user) for user in users}
    grant_count = PlatformAccessGrant.objects.count()

    with pytest.raises(CommandError, match="customer organization"):
        call_command(
            "provision_system_admin",
            email=email.upper(),
            name="Must Not Replace Any Identity",
            reason="Isolated ambiguity rejection",
            change_id="CHG-scope-provision",
            environment="test",
            confirm=True,
        )

    assert {user.pk: user_state(user) for user in users} == originals
    assert PlatformAccessGrant.objects.count() == grant_count
    assert User.objects.count() == len(users)
    assert not EmailOutbox.objects.exists()


@override_settings(ENVIRONMENT="test", EMAIL_DELIVERY_BACKEND="memory")
def test_platform_revoke_targets_platform_pk_even_when_customer_emails_overlap(organization):
    platform = platform_organization()
    target = operator(platform, "target-operator@example.test")
    actor = operator(platform, "actor-operator@example.test")
    customer_target = member(organization, target.email)
    customer_actor = member(organization, actor.email)
    originals = {user.pk: user_state(user) for user in (customer_target, customer_actor, actor)}

    call_command(
        "revoke_system_admin",
        email=target.email.upper(),
        actor_email=actor.email.upper(),
        reason="Isolated scoped revocation",
        change_id="CHG-scope-revoke",
        environment="test",
        confirm=True,
        stdout=StringIO(),
    )

    target.refresh_from_db()
    assert target.status == User.Status.SUSPENDED
    assert not target.platform_access_grants.get().active
    assert {
        user.pk: user_state(user) for user in (customer_target, customer_actor, actor)
    } == originals
    event = target.organization.platform_audit_events.get(action="platform.system_admin.revoked")
    assert event.actor_id == actor.pk


@override_settings(ENVIRONMENT="test", EMAIL_DELIVERY_BACKEND="memory")
def test_platform_revoke_does_not_mistake_customer_for_missing_platform_actor(organization):
    platform = platform_organization()
    target = operator(platform, "target-operator@example.test")
    replacement = operator(platform, "replacement-operator@example.test")
    customer_actor = member(organization, "customer-only-actor@example.test")
    originals = {user.pk: user_state(user) for user in (target, replacement, customer_actor)}

    with pytest.raises(CommandError, match="actor identity not found"):
        call_command(
            "revoke_system_admin",
            email=target.email,
            actor_email=customer_actor.email,
            reason="Isolated missing platform actor",
            change_id="CHG-scope-actor",
            environment="test",
            confirm=True,
        )

    assert {
        user.pk: user_state(user) for user in (target, replacement, customer_actor)
    } == originals
    assert target.platform_access_grants.get().active


@override_settings(ENVIRONMENT="test", EMAIL_DELIVERY_BACKEND="memory")
def test_platform_revoke_pending_password_change_is_not_an_usable_replacement():
    platform = platform_organization()
    target = operator(platform, "last-operator@example.test")
    pending = operator(
        platform,
        "pending-operator@example.test",
        password_change_required=True,
    )
    originals = {user.pk: user_state(user) for user in (target, pending)}

    with pytest.raises(CommandError, match="last active System Administrator"):
        call_command(
            "revoke_system_admin",
            email=target.email,
            reason="Isolated last usable operator check",
            change_id="CHG-scope-last-operator",
            environment="test",
            confirm=True,
        )

    assert {user.pk: user_state(user) for user in (target, pending)} == originals
    assert target.platform_access_grants.get().active
