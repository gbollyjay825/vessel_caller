from __future__ import annotations

import re

from django.conf import settings
from django.core.exceptions import ValidationError as DjangoValidationError
from django.core.management.base import BaseCommand, CommandError
from django.core.validators import validate_email
from django.db import transaction
from django.utils import timezone

from accounts.models import ActionToken, MFAChallenge, PlatformAccessGrant, User
from accounts.security import issue_action_token
from accounts.services import queue_email, revoke_sessions
from audit.services import record_platform_event
from organizations.models import Organization, OrganizationSettings


class Command(BaseCommand):
    help = (
        "Provision one explicit Vessel Caller System Administrator grant and queue "
        "a single-use 24-hour password setup link. No credential is printed."
    )

    def add_arguments(self, parser):
        parser.add_argument("--email", required=True)
        parser.add_argument("--name", required=True)
        parser.add_argument("--reason", required=True)
        parser.add_argument("--change-id", required=True)
        parser.add_argument("--environment", required=True)
        parser.add_argument(
            "--confirm",
            action="store_true",
            help="Required acknowledgement that this grants cross-organization access.",
        )

    @transaction.atomic
    def handle(self, *args, **options):
        if not options["confirm"]:
            raise CommandError("Refusing to grant System Administrator access without --confirm")
        if options["environment"] != settings.ENVIRONMENT:
            raise CommandError(
                f"Environment mismatch: command named {options['environment']!r}, "
                f"runtime is {settings.ENVIRONMENT!r}"
            )
        if settings.EMAIL_DELIVERY_BACKEND not in {"resend", "memory"}:
            raise CommandError(
                "System Administrator setup requires verified Resend or the test memory backend"
            )
        if settings.EMAIL_DELIVERY_BACKEND == "resend" and not settings.RESEND_API_KEY:
            raise CommandError("Resend delivery is selected but VC_RESEND_API_KEY is missing")
        email = options["email"].strip().lower()
        name = options["name"].strip()
        reason = options["reason"].strip()
        change_id = options["change_id"].strip()
        if not email or not name or not reason or len(name) > 255 or len(reason) > 2000:
            raise CommandError("Email, name, and reason are required")
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:/-]{2,127}", change_id):
            raise CommandError("Provide a bounded opaque --change-id")
        try:
            validate_email(email)
        except DjangoValidationError as exc:
            raise CommandError("Provide a valid email address") from exc

        organization, _ = Organization.objects.select_for_update().get_or_create(
            kind=Organization.Kind.PLATFORM,
            defaults={
                "name": "Vessel Caller Platform Administration",
                "email": email,
                "registered": True,
            },
        )
        OrganizationSettings.objects.get_or_create(organization=organization)

        user = User.objects.select_for_update().filter(email=email).first()
        if user and user.organization_id != organization.id:
            raise CommandError(
                "That email belongs to a customer organization; create a dedicated platform identity"
            )
        if user is None:
            user = User(
                organization=organization,
                email=email,
                name=name,
                role=User.Role.VIEWER,
                status=User.Status.INVITED,
                email_verified_at=None,
                mfa_grace_ends_at=timezone.now(),
                is_staff=False,
                is_superuser=False,
            )
            user.set_unusable_password()
            user.save()
        elif user.is_staff or user.is_superuser:
            raise CommandError(
                "Use a dedicated non-staff platform identity for product System Administrator access"
            )

        existing = (
            PlatformAccessGrant.objects.select_for_update()
            .filter(
                user=user,
                role=PlatformAccessGrant.Role.SYSTEM_ADMIN,
                revoked_at__isnull=True,
            )
            .first()
        )
        fully_operational = (
            existing
            and existing.active
            and user.status == User.Status.ACTIVE
            and user.email_verified_at is not None
            and user.mfa_enabled
            and bool(user.mfa_secret)
            and user.has_usable_password()
        )
        if fully_operational:
            self.stdout.write("System Administrator access is already provisioned; no changes made")
            return

        now = timezone.now()
        if existing and not existing.active:
            existing.revoked_at = now
            existing.save(update_fields=("revoked_at",))

        revoke_sessions(user)
        MFAChallenge.objects.filter(user=user, used_at__isnull=True).delete()
        ActionToken.objects.filter(user=user, used_at__isnull=True).delete()

        # Setup-link possession proves the email address. Access remains inactive
        # and every prior password/MFA credential is invalid until that link is used.
        user.status = User.Status.INVITED
        user.email_verified_at = None
        user.role = User.Role.VIEWER
        user.name = name
        user.set_unusable_password()
        user.mfa_secret = ""
        user.mfa_enabled_at = None
        user.mfa_grace_ends_at = now
        user.save(
            update_fields=(
                "status",
                "email_verified_at",
                "role",
                "name",
                "password",
                "mfa_secret",
                "mfa_enabled_at",
                "mfa_grace_ends_at",
                "updated_at",
            )
        )
        user.recovery_codes.all().delete()

        if existing and existing.active:
            grant = existing
            action = "platform.system_admin.setup_resent"
        else:
            grant = PlatformAccessGrant.objects.create(
                user=user,
                role=PlatformAccessGrant.Role.SYSTEM_ADMIN,
                reason=reason,
            )
            action = "platform.system_admin.provisioned"

        token_obj, raw = issue_action_token(
            user,
            ActionToken.Kind.RESET_PASSWORD,
            hours=24,
            metadata={"platformSetup": True},
        )
        queue_email(
            to_email=user.email,
            subject="Set up your Vessel Caller System Administrator account",
            template="reset_password",
            context={"actionUrl": f"{settings.FRONTEND_URL}/reset-password?token={raw}"},
            idempotency_key=f"system-admin-setup:{token_obj.id}",
            organization=organization,
        )

        record_platform_event(
            organization=organization,
            actor=None,
            action=action,
            target=user,
            target_label=user.email,
            reason=reason,
            request_id=change_id,
            after={"role": grant.role, "mfaRequired": True, "status": user.status},
        )
        self.stdout.write(
            self.style.SUCCESS(
                "System Administrator access provisioned; a 24-hour setup email was queued"
            )
        )
