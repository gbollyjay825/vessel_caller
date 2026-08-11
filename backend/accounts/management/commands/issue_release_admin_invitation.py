from __future__ import annotations

from datetime import timedelta

from django.conf import settings
from django.core.management.base import BaseCommand, CommandError
from django.db import transaction
from django.utils import timezone

from accounts.models import Invitation, User
from accounts.security import token_hash
from accounts.services import opaque_token, queue_email
from audit.services import record_event
from organizations.models import Organization


class Command(BaseCommand):
    help = (
        "Issue a single-use, 24-hour Admin invitation after a verified release. "
        "The invitation secret is encrypted in the outbox and is never printed."
    )

    def add_arguments(self, parser):
        parser.add_argument("--organization-id", required=True)
        parser.add_argument("--invited-by", required=True)
        parser.add_argument("--email", required=True)
        parser.add_argument("--name", required=True)

    @transaction.atomic
    def handle(self, *args, **options):
        self._require_delivery()
        organization = self._organization(options["organization_id"])
        inviter = self._inviter(organization, options["invited_by"])
        email = User.objects.normalize_email(options["email"]).strip().lower()
        name = options["name"].strip()
        if not name:
            raise CommandError("--name must not be blank")
        if User.objects.filter(email=email).exists():
            raise CommandError("A user with this email already exists")

        now = timezone.now()
        Invitation.objects.select_for_update().filter(
            organization=organization,
            email=email,
            status=Invitation.Status.PENDING,
        ).update(status=Invitation.Status.REVOKED, revoked_at=now)

        raw = opaque_token()
        invitation = Invitation.objects.create(
            organization=organization,
            name=name,
            email=email,
            role=User.Role.ADMIN,
            token_hash=token_hash(raw),
            invited_by=inviter,
            expires_at=now + timedelta(hours=24),
        )
        queue_email(
            to_email=email,
            subject=f"Join {organization.name} on Vessel Caller",
            template="invitation",
            context={"actionUrl": f"{settings.FRONTEND_URL}/accept-invitation?token={raw}"},
            idempotency_key=f"release-admin-invite:{invitation.id}",
            organization=organization,
        )
        record_event(
            organization=organization,
            actor=inviter,
            action="invitation.release_admin_created",
            category="identity",
            target=invitation,
            target_label=email,
            after={
                "email": email,
                "role": User.Role.ADMIN,
                "validityHours": 24,
                "singleUse": True,
            },
        )
        self.stdout.write(
            self.style.SUCCESS(
                "Queued one single-use Admin invitation valid for exactly 24 hours; "
                "no invitation secret was printed."
            )
        )

    @staticmethod
    def _require_delivery() -> None:
        backend = settings.EMAIL_DELIVERY_BACKEND
        if backend == "memory":
            return
        if backend != "resend" or not settings.RESEND_API_KEY:
            raise CommandError(
                "Verified Resend delivery must be enabled before issuing this invitation"
            )

    @staticmethod
    def _organization(organization_id: str) -> Organization:
        try:
            return Organization.objects.select_for_update().get(pk=organization_id)
        except Organization.DoesNotExist as exc:
            raise CommandError("Organization not found") from exc

    @staticmethod
    def _inviter(organization: Organization, email: str) -> User:
        inviter = (
            User.objects.select_for_update()
            .filter(
                organization=organization,
                email__iexact=email.strip(),
                role=User.Role.ADMIN,
                status=User.Status.ACTIVE,
            )
            .first()
        )
        if not inviter:
            raise CommandError("Inviter must be an active Admin in the organization")
        return inviter
