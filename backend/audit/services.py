from __future__ import annotations

from decimal import Decimal

from .models import AuditEvent, PlatformAuditEvent

SENSITIVE = {"password", "token", "secret", "recoveryCodes", "mfaSecret"}


def _sanitize(value):
    if isinstance(value, Decimal):
        return str(value)
    if isinstance(value, dict):
        return {
            key: ("[REDACTED]" if key in SENSITIVE else _sanitize(item))
            for key, item in value.items()
        }
    if isinstance(value, (list, tuple)):
        return [_sanitize(item) for item in value]
    return value


def client_ip(request):
    if not request:
        return None
    remote = request.META.get("REMOTE_ADDR") or None
    forwarded = request.META.get("HTTP_X_FORWARDED_FOR", "")
    if forwarded and remote in {"127.0.0.1", "::1"}:
        # Nginx appends the real peer address; client-supplied prefixes are untrusted.
        return forwarded.rsplit(",", 1)[-1].strip() or remote
    return remote


def record_event(
    *,
    organization,
    actor,
    action,
    category,
    target=None,
    target_label="",
    request=None,
    before=None,
    after=None,
):
    return AuditEvent.objects.create(
        organization=organization,
        actor=actor if getattr(actor, "pk", None) else None,
        action=action,
        category=category,
        target_type=target.__class__.__name__ if target is not None else "",
        target_id=str(getattr(target, "pk", "")) if target is not None else "",
        target_label=target_label[:255],
        request_id=getattr(request, "request_id", "") if request else "",
        ip_address=client_ip(request),
        user_agent=(request.META.get("HTTP_USER_AGENT", "")[:512] if request else ""),
        before=_sanitize(before),
        after=_sanitize(after),
    )


def record_platform_event(
    *,
    organization,
    actor,
    action,
    target=None,
    target_label="",
    reason="",
    request_id="",
    request=None,
    before=None,
    after=None,
):
    return PlatformAuditEvent.objects.create(
        organization=organization,
        actor=actor if getattr(actor, "pk", None) else None,
        action=action,
        target_type=target.__class__.__name__ if target is not None else "",
        target_id=str(getattr(target, "pk", "")) if target is not None else "",
        target_label=target_label[:255],
        reason=reason,
        request_id=(request_id or (getattr(request, "request_id", "") if request else ""))[:128],
        ip_address=client_ip(request),
        user_agent=(request.META.get("HTTP_USER_AGENT", "")[:512] if request else ""),
        before=_sanitize(before),
        after=_sanitize(after),
    )


def record_identity_event(
    *,
    organization,
    actor,
    action,
    target=None,
    target_label="",
    request=None,
    before=None,
    after=None,
):
    """Record identity activity and mirror platform identities into the operator ledger."""

    event = record_event(
        organization=organization,
        actor=actor,
        action=action,
        category="identity",
        target=target,
        target_label=target_label,
        request=request,
        before=before,
        after=after,
    )
    if getattr(organization, "kind", None) == "platform":
        record_platform_event(
            organization=organization,
            actor=actor,
            action=action,
            target=target,
            target_label=target_label,
            request=request,
            before=before,
            after=after,
        )
    return event
