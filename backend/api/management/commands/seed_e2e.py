from __future__ import annotations

from datetime import timedelta

from django.conf import settings
from django.core.management.base import BaseCommand, CommandError
from django.db import transaction
from django.utils import timezone

from accounts.models import User
from organizations.models import Organization, OrganizationSettings


class Command(BaseCommand):
    help = "Create deterministic, non-production end-to-end test identities."

    def add_arguments(self, parser):
        parser.add_argument("--force", action="store_true")

    @transaction.atomic
    def handle(self, *args, **options):
        if not settings.DEBUG and not options["force"]:
            raise CommandError(
                "seed_e2e is disabled outside DEBUG; pass --force only in isolated CI"
            )
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
            user.set_password("E2E-only-password-2026!")
            user.save()
        self.stdout.write(
            self.style.SUCCESS("Created deterministic E2E organization and four role accounts")
        )
