from __future__ import annotations

import json
import logging
from datetime import timedelta

from celery import shared_task
from django.db import transaction
from django.db.models import Q
from django.utils import timezone

from .emailing import deliver
from .models import EmailOutbox
from .security import decrypt_secret


log = logging.getLogger(__name__)
OUTBOX_DISPATCH_BATCH_SIZE = 100
OUTBOX_STALE_SENDING_AFTER = timedelta(minutes=10)


@shared_task(
    autoretry_for=(RuntimeError, OSError),
    retry_backoff=True,
    retry_jitter=True,
    max_retries=5,
)
def deliver_outbox_email(outbox_id: str):
    candidate = EmailOutbox.objects.filter(pk=outbox_id).values("organization_id").first()
    if not candidate:
        return ""
    failure = None
    provider_id = ""
    with transaction.atomic():
        if candidate["organization_id"]:
            from organizations.models import Organization

            organization = Organization.objects.select_for_update().get(
                pk=candidate["organization_id"]
            )
        else:
            organization = None
        outbox = EmailOutbox.objects.select_for_update().get(pk=outbox_id)
        if outbox.status == EmailOutbox.Status.SENT:
            return outbox.provider_id
        if organization is None:
            if outbox.status == EmailOutbox.Status.FAILED:
                return ""
            outbox.status = EmailOutbox.Status.FAILED
            outbox.last_error = "Delivery suppressed because organization scope is missing"
            outbox.save(update_fields=("status", "last_error", "updated_at"))
            return ""
        pending_approval_allowed = bool(
            organization.access_status == Organization.AccessStatus.PENDING_APPROVAL
            and outbox.allow_pending_approval_organization
            and outbox.template == "verify_email"
        )
        suspended_allowed = bool(
            organization.access_status == Organization.AccessStatus.SUSPENDED
            and outbox.allow_suspended_organization
        )
        if not organization.is_access_active and not (
            pending_approval_allowed or suspended_allowed
        ):
            outbox.status = EmailOutbox.Status.FAILED
            outbox.last_error = "Delivery suppressed because organization access is not active"
            outbox.save(update_fields=("status", "last_error", "updated_at"))
            return ""
        outbox.status = EmailOutbox.Status.SENDING
        outbox.attempts += 1
        outbox.save(update_fields=("status", "attempts", "updated_at"))
        try:
            stored_context = outbox.context
            if "ciphertext" in stored_context:
                plaintext = decrypt_secret(stored_context["ciphertext"])
                if not plaintext:
                    raise RuntimeError("Email outbox context could not be decrypted")
                delivery_context = json.loads(plaintext)
            else:
                delivery_context = stored_context
            provider_id = deliver(
                to_email=outbox.to_email,
                subject=outbox.subject,
                template=outbox.template,
                context=delivery_context,
                idempotency_key=outbox.idempotency_key,
            )
        except Exception as exc:
            outbox.status = EmailOutbox.Status.FAILED
            outbox.last_error = str(exc)[:2000]
            outbox.save(update_fields=("status", "last_error", "updated_at"))
            failure = exc
        else:
            outbox.status = EmailOutbox.Status.SENT
            outbox.provider_id = provider_id
            outbox.sent_at = timezone.now()
            outbox.last_error = ""
            outbox.context = {"redacted": True}
            outbox.save(
                update_fields=(
                    "status",
                    "provider_id",
                    "sent_at",
                    "last_error",
                    "context",
                    "updated_at",
                )
            )
    if failure is not None:
        raise failure
    return provider_id


@shared_task
def dispatch_pending_outbox() -> int:
    """Republish durable rows missed during broker outages.

    A bounded pass keeps the worker responsive. Failed deliveries are
    deliberately excluded: their task owns the configured retry/backoff and a
    periodic FAILED scan would create an unbounded hot loop. A SENDING row is
    eligible only after a conservative lease, recovering worker crashes while
    avoiding overlap with the 15-second provider request timeout.
    """

    stale_before = timezone.now() - OUTBOX_STALE_SENDING_AFTER
    outbox_ids = list(
        EmailOutbox.objects.filter(
            Q(status=EmailOutbox.Status.PENDING)
            | Q(status=EmailOutbox.Status.SENDING, updated_at__lt=stale_before)
        )
        .order_by("created_at", "id")
        .values_list("id", flat=True)[:OUTBOX_DISPATCH_BATCH_SIZE]
    )
    published = 0
    for outbox_id in outbox_ids:
        try:
            deliver_outbox_email.apply_async(args=(str(outbox_id),), retry=False)
        except Exception:
            log.exception(
                "Could not republish email outbox item %s; a later sweep will retry",
                outbox_id,
            )
            break
        published += 1
    return published
