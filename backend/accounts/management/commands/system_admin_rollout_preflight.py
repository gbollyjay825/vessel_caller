from __future__ import annotations

import hashlib
import json
import os
import tempfile
from pathlib import Path
from typing import cast

import redis
from django.conf import settings
from django.core.management.base import BaseCommand, CommandError
from django.db.models import Subquery
from django.db.models.functions import Lower
from django.utils import timezone

from accounts.models import EmailOutbox, Invitation, User


CELERY_PRIORITY_QUEUE_KEYS = (
    "celery",
    "celery\x06\x163",
    "celery\x06\x166",
    "celery\x06\x169",
)


def _sha256(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _atomic_private_write(path: Path, content: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    file_descriptor, temporary_name = tempfile.mkstemp(
        dir=path.parent,
        prefix=f".{path.name}.",
    )
    try:
        os.fchmod(file_descriptor, 0o600)
        with os.fdopen(file_descriptor, "wb") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary_name, path)
        os.chmod(path, 0o600)
    except BaseException:
        try:
            os.unlink(temporary_name)
        except FileNotFoundError:
            pass
        raise


class Command(BaseCommand):
    help = (
        "Read-only System Administrator rollout preflight. It proves no unscoped "
        "retryable mail or queued Redis broker work remains and writes non-secret evidence."
    )

    def add_arguments(self, parser):
        parser.add_argument(
            "--evidence-file",
            required=True,
            help="Absolute private evidence path, or '-' for canonical JSON on stdout",
        )

    def handle(self, *args, **options):
        evidence_target = str(options["evidence_file"])
        evidence_path = None if evidence_target == "-" else Path(evidence_target)
        if evidence_path is not None and not evidence_path.is_absolute():
            raise CommandError("--evidence-file must be an absolute path")

        unscoped_retryable = EmailOutbox.objects.filter(
            organization__isnull=True,
            status__in=(EmailOutbox.Status.PENDING, EmailOutbox.Status.SENDING),
        ).count()
        historical_failed = list(
            EmailOutbox.objects.filter(
                organization__isnull=True,
                status=EmailOutbox.Status.FAILED,
            )
            .order_by("id")
            .values(
                "id",
                "created_at",
                "updated_at",
                "template",
                "status",
                "idempotency_key",
                "last_error",
            )
        )
        canonical_history = [
            [
                str(row["id"]),
                row["created_at"].isoformat(),
                row["updated_at"].isoformat(),
                row["template"],
                row["status"],
                _sha256(row["idempotency_key"]),
                _sha256(row["last_error"]),
            ]
            for row in historical_failed
        ]
        historical_fingerprint = _sha256(
            json.dumps(canonical_history, separators=(",", ":"), ensure_ascii=True)
        )
        existing_emails = User.objects.annotate(normalized_email=Lower("email")).values(
            "normalized_email"
        )
        invitation_collision_ids = [
            str(invitation_id)
            for invitation_id in Invitation.objects.filter(
                status=Invitation.Status.PENDING,
                deliverable=True,
            )
            .annotate(normalized_email=Lower("email"))
            .filter(normalized_email__in=Subquery(existing_emails))
            .order_by("id")
            .values_list("id", flat=True)
        ]
        invitation_collision_fingerprint = _sha256(
            json.dumps(invitation_collision_ids, separators=(",", ":"), ensure_ascii=True)
        )

        client = redis.Redis.from_url(settings.CELERY_BROKER_URL)
        try:
            broker_counts = {
                "celery": sum(cast(int, client.llen(key)) for key in CELERY_PRIORITY_QUEUE_KEYS),
                "unacked": cast(int, client.hlen("unacked")),
                "unackedIndex": cast(int, client.zcard("unacked_index")),
            }
        except Exception as exc:
            raise CommandError("Could not read the Celery Redis broker state") from exc
        finally:
            client.close()

        counts = {
            "unscopedPendingOrSending": unscoped_retryable,
            "pendingInvitationEmailCollisions": len(invitation_collision_ids),
            **broker_counts,
        }
        passed = all(value == 0 for value in counts.values())
        evidence = {
            "environment": settings.ENVIRONMENT,
            "release": {
                "tag": settings.RELEASE_TAG,
                "sha": settings.RELEASE_SHA,
            },
            "generatedAt": timezone.now().isoformat(),
            "passed": passed,
            "counts": counts,
            "historicalUnscopedFailed": {
                "count": len(historical_failed),
                "sha256": historical_fingerprint,
            },
            "pendingInvitationEmailCollisions": {
                "count": len(invitation_collision_ids),
                "sha256": invitation_collision_fingerprint,
            },
        }
        payload = (json.dumps(evidence, sort_keys=True, separators=(",", ":")) + "\n").encode(
            "utf-8"
        )
        if evidence_path is None:
            self.stdout.write(payload.decode("utf-8"), ending="")
        else:
            _atomic_private_write(evidence_path, payload)
            sidecar = evidence_path.with_name(f"{evidence_path.name}.sha256")
            _atomic_private_write(
                sidecar,
                f"{hashlib.sha256(payload).hexdigest()}  {evidence_path.name}\n".encode("ascii"),
            )
        if not passed:
            raise CommandError(
                "System Administrator rollout preflight failed; inspect the non-secret evidence file"
            )
        if evidence_path is not None:
            self.stdout.write(self.style.SUCCESS("System Administrator rollout preflight passed"))
