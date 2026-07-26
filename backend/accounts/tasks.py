from __future__ import annotations

import json

from celery import shared_task
from django.db import transaction
from django.utils import timezone

from .emailing import deliver
from .models import EmailOutbox
from .security import decrypt_secret


@shared_task(
    autoretry_for=(RuntimeError, OSError),
    retry_backoff=True,
    retry_jitter=True,
    max_retries=5,
)
def deliver_outbox_email(outbox_id: str):
    with transaction.atomic():
        outbox = EmailOutbox.objects.select_for_update().get(pk=outbox_id)
        if outbox.status == EmailOutbox.Status.SENT:
            return outbox.provider_id
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
        EmailOutbox.objects.filter(pk=outbox_id).update(
            status=EmailOutbox.Status.FAILED,
            last_error=str(exc)[:2000],
        )
        raise
    EmailOutbox.objects.filter(pk=outbox_id).update(
        status=EmailOutbox.Status.SENT,
        provider_id=provider_id,
        sent_at=timezone.now(),
        last_error="",
        context={"redacted": True},
    )
    return provider_id
