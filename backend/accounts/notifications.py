"""Role-targeted transactional notifications.

Every message is queued through the encrypted PostgreSQL outbox.  The helper
deliberately excludes the actor from organization notices: the actor already
has the API result, while the affected team receives the operational signal.
"""

from __future__ import annotations

from collections.abc import Iterable

from .models import User
from .services import queue_email
from organizations.models import Organization


def queue_security_notice(
    user: User,
    *,
    event_key: str,
    subject: str,
    message: str,
    to_email: str | None = None,
    template: str = "security_notice",
    allow_suspended_organization: bool = False,
) -> None:
    """Notify one user about a material security or access change."""

    recipient = (to_email or user.email).strip().lower()
    if not recipient:
        return
    queue_email(
        to_email=recipient,
        subject=subject,
        template=template,
        context={"message": message},
        idempotency_key=f"notice:{event_key}:{user.pk}",
        organization=user.organization,
        allow_suspended_organization=allow_suspended_organization,
    )


def queue_organization_notice(
    *,
    organization: Organization,
    actor: User | None,
    recipient_roles: Iterable[str],
    event_key: str,
    subject: str,
    message: str,
    template: str,
) -> None:
    """Notify active organization members in the supplied roles once each."""

    recipients = organization.users.filter(
        status=User.Status.ACTIVE,
        role__in=tuple(recipient_roles),
    )
    if actor is not None:
        recipients = recipients.exclude(pk=actor.pk)
    for recipient in recipients.order_by("id"):
        queue_security_notice(
            recipient,
            event_key=event_key,
            subject=subject,
            message=message,
            template=template,
        )
