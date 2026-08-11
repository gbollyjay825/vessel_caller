from __future__ import annotations

import logging
import re

from django.conf import settings
from django.core.management.base import BaseCommand, CommandError
from django.db import transaction
from django.db.models import Q
from django.utils import timezone

from accounts.models import ActionToken, MFAChallenge, PlatformAccessGrant, User
from accounts.notifications import queue_security_notice
from accounts.services import revoke_sessions
from audit.services import record_platform_event
from organizations.models import Organization


log = logging.getLogger(__name__)


class Command(BaseCommand):
    help = "Revoke one explicit System Administrator grant and all active authentication state."

    def add_arguments(self, parser):
        parser.add_argument("--email", required=True)
        parser.add_argument("--reason", required=True)
        parser.add_argument("--change-id", required=True)
        parser.add_argument("--actor-email")
        parser.add_argument("--environment", required=True)
        parser.add_argument(
            "--confirm",
            action="store_true",
            help="Required acknowledgement that this revokes cross-organization access.",
        )

    @transaction.atomic
    def handle(self, *args, **options):
        if not options["confirm"]:
            raise CommandError("Refusing to revoke System Administrator access without --confirm")
        if options["environment"] != settings.ENVIRONMENT:
            raise CommandError(
                f"Environment mismatch: command named {options['environment']!r}, "
                f"runtime is {settings.ENVIRONMENT!r}"
            )
        reason = options["reason"].strip()
        change_id = options["change_id"].strip()
        if not reason:
            raise CommandError("A revocation reason is required")
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:/-]{2,127}", change_id):
            raise CommandError("Provide a bounded opaque --change-id")
        platform_organization = (
            Organization.objects.select_for_update().filter(kind=Organization.Kind.PLATFORM).first()
        )
        if not platform_organization:
            raise CommandError("Platform organization not found")
        user = (
            User.objects.select_for_update()
            .select_related("organization")
            .filter(
                email=options["email"].strip().lower(),
                organization=platform_organization,
            )
            .first()
        )
        if not user:
            raise CommandError("System Administrator identity not found")
        grant = (
            PlatformAccessGrant.objects.select_for_update()
            .filter(
                user=user,
                role=PlatformAccessGrant.Role.SYSTEM_ADMIN,
                revoked_at__isnull=True,
            )
            .first()
        )
        if not grant or not grant.active:
            self.stdout.write("System Administrator access is already inactive; no changes made")
            return
        replacement_grants = list(
            PlatformAccessGrant.objects.select_for_update()
            .select_related("user")
            .filter(
                role=PlatformAccessGrant.Role.SYSTEM_ADMIN,
                revoked_at__isnull=True,
                user__status=User.Status.ACTIVE,
                user__email_verified_at__isnull=False,
                user__organization=platform_organization,
                user__mfa_enabled_at__isnull=False,
                user__is_staff=False,
                user__is_superuser=False,
            )
            .exclude(user=user)
            .exclude(user__mfa_secret="")
            .filter(Q(expires_at__isnull=True) | Q(expires_at__gt=timezone.now()))
        )
        if not any(item.user.has_usable_password() for item in replacement_grants):
            raise CommandError(
                "Refusing to revoke the last active System Administrator; provision a replacement first"
            )

        actor = None
        if options.get("actor_email"):
            actor = User.objects.filter(
                email=options["actor_email"].strip().lower(),
                organization=platform_organization,
            ).first()
            actor_grant = (
                PlatformAccessGrant.objects.filter(
                    user=actor,
                    role=PlatformAccessGrant.Role.SYSTEM_ADMIN,
                    revoked_at__isnull=True,
                )
                .filter(Q(expires_at__isnull=True) | Q(expires_at__gt=timezone.now()))
                .exists()
                if actor
                else False
            )
            if not actor or not actor.is_active or not actor.mfa_enabled or not actor_grant:
                raise CommandError("Revoking actor identity not found")

        grant.revoked_at = timezone.now()
        grant.revoked_by = actor
        grant.save(update_fields=("revoked_at", "revoked_by"))
        user.status = User.Status.SUSPENDED
        user.mfa_secret = ""
        user.mfa_enabled_at = None
        user.mfa_grace_ends_at = None
        user.save(
            update_fields=(
                "status",
                "mfa_secret",
                "mfa_enabled_at",
                "mfa_grace_ends_at",
                "updated_at",
            )
        )
        user.recovery_codes.all().delete()
        revoke_sessions(user)
        MFAChallenge.objects.filter(user=user, used_at__isnull=True).delete()
        ActionToken.objects.filter(user=user, used_at__isnull=True).delete()
        record_platform_event(
            organization=user.organization,
            actor=actor,
            action="platform.system_admin.revoked",
            target=user,
            target_label=user.email,
            reason=reason,
            request_id=change_id,
            before={"role": grant.role, "active": True},
            after={"role": grant.role, "active": False},
        )
        try:
            queue_security_notice(
                user,
                event_key=f"system-admin-revoked:{grant.id}",
                subject="Your Vessel Caller System Administrator access was revoked",
                message="Your Vessel Caller System Administrator access was revoked and your active sessions were signed out.",
            )
        except Exception:
            log.exception("Could not queue System Administrator revocation notice")
        self.stdout.write(self.style.SUCCESS("System Administrator access revoked"))
