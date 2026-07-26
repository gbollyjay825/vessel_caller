from __future__ import annotations

import os
from datetime import timedelta

from django.conf import settings
from django.contrib.auth.password_validation import validate_password
from django.core.exceptions import ValidationError
from django.core.management.base import BaseCommand, CommandError
from django.db import transaction
from django.utils import timezone

from accounts.models import User
from organizations.models import Organization, OrganizationSettings

MIN_E2E_PASSWORD_LENGTH = 20
MAX_E2E_PASSWORD_LENGTH = 256


def _validated_password(password: str) -> str:
    categories_present = (
        any(character.islower() for character in password),
        any(character.isupper() for character in password),
        any(character.isdigit() for character in password),
        any(not character.isalnum() for character in password),
    )
    if (
        not MIN_E2E_PASSWORD_LENGTH <= len(password) <= MAX_E2E_PASSWORD_LENGTH
        or not all(categories_present)
        or len(set(password)) < 12
    ):
        raise CommandError("VC_E2E_PASSWORD does not meet the E2E password strength policy")
    try:
        validate_password(password)
    except ValidationError as exc:
        raise CommandError(
            "VC_E2E_PASSWORD does not meet the E2E password strength policy"
        ) from exc
    return password


class Command(BaseCommand):
    help = "Create deterministic, non-production end-to-end test identities."

    def add_arguments(self, parser):
        parser.add_argument("--force", action="store_true")
        parser.add_argument(
            "--password",
            help="Explicit password for local DEBUG use only; staging/CI must use VC_E2E_PASSWORD.",
        )

    @transaction.atomic
    def handle(self, *args, **options):
        environment = str(getattr(settings, "ENVIRONMENT", "")).strip().lower()
        if environment == "production":
            raise CommandError("seed_e2e is permanently disabled in production")
        if not settings.DEBUG and not options["force"]:
            raise CommandError(
                "seed_e2e is disabled outside DEBUG; pass --force only in isolated CI"
            )
        protected_use = options["force"] or not settings.DEBUG
        if protected_use:
            if options["password"]:
                raise CommandError(
                    "--password is allowed only for local DEBUG use; set VC_E2E_PASSWORD"
                )
            password = os.getenv("VC_E2E_PASSWORD", "")
            if not password:
                raise CommandError("VC_E2E_PASSWORD is required for forced or non-DEBUG seeding")
        else:
            password = options["password"] or os.getenv("VC_E2E_PASSWORD", "")
            if not password:
                raise CommandError("Supply --password for local DEBUG use or set VC_E2E_PASSWORD")
        password = _validated_password(password)
        organization, _ = Organization.objects.get_or_create(
            id="org-e2e000000001",
            defaults={
                "registered": True,
                "name": "E2E Harbour Services",
                "email": "admin@e2e.vesselcalls.test",
                "primary_port": "Port of Calabar",
                "ports": ["Port of Calabar"],
            },
        )
        OrganizationSettings.objects.get_or_create(
            organization=organization,
            defaults={
                "port_name": "Port of Calabar",
                "terminals": ["E2E Government Jetty", "E2E Private Jetty"],
            },
        )
        now = timezone.now()
        credentials = {
            "Admin": ("u-e2eadmin00001", "admin@e2e.vesselcalls.test"),
            "Operations": ("u-e2eops0000001", "operations@e2e.vesselcalls.test"),
            "Finance": ("u-e2efin0000001", "finance@e2e.vesselcalls.test"),
            "Viewer": ("u-e2eview000001", "viewer@e2e.vesselcalls.test"),
        }
        for role, (user_id, email) in credentials.items():
            user, _ = User.objects.get_or_create(
                id=user_id,
                defaults={
                    "organization": organization,
                    "name": f"E2E {role}",
                    "email": email,
                    "role": role,
                    "status": User.Status.ACTIVE,
                    "email_verified_at": now,
                    "mfa_grace_ends_at": now + timedelta(days=7),
                },
            )
            user.name = f"E2E {role}"
            user.email = email
            user.role = role
            user.status = User.Status.ACTIVE
            user.email_verified_at = now
            user.set_password(password)
            user.save()
        self.stdout.write(
            self.style.SUCCESS("Created deterministic E2E organization and four role accounts")
        )
