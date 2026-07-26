from __future__ import annotations

import json
import http.client
import logging

from django.conf import settings
from django.core.cache import cache

log = logging.getLogger(__name__)


def _render(template: str, context: dict) -> str:
    action_url = context.get("actionUrl", "")
    messages = {
        "verify_email": "Verify your Vessel Caller email address",
        "invitation": "You have been invited to Vessel Caller",
        "reset_password": "Reset your Vessel Caller password",
        "email_changed": "Your Vessel Caller email address was changed",
    }
    heading = messages.get(template, "Vessel Caller notification")
    return (
        f"<h1>{heading}</h1>"
        f"<p>{context.get('message', heading)}</p>"
        + (f'<p><a href="{action_url}">Continue securely</a></p>' if action_url else "")
        + "<p>If you did not request this, contact your organization administrator.</p>"
    )


def deliver(*, to_email: str, subject: str, template: str, context: dict, idempotency_key: str):
    backend = settings.EMAIL_DELIVERY_BACKEND
    html = _render(template, context)
    if backend == "memory":
        cache.set(
            f"email:{idempotency_key}",
            {"to": to_email, "subject": subject, "html": html},
            timeout=86_400,
        )
        return f"memory:{idempotency_key}"
    if backend == "console":
        log.info("email delivery: to=%s subject=%s body=%s", to_email, subject, html)
        return f"console:{idempotency_key}"
    if backend != "resend" or not settings.RESEND_API_KEY:
        raise RuntimeError("Email delivery is not configured")
    body = json.dumps(
        {
            "from": settings.EMAIL_FROM,
            "to": [to_email],
            "subject": subject,
            "html": html,
        }
    ).encode()
    headers = {
        "Authorization": f"Bearer {settings.RESEND_API_KEY}",
        "Content-Type": "application/json",
        "Idempotency-Key": idempotency_key,
    }
    connection = http.client.HTTPSConnection("api.resend.com", timeout=15)
    try:
        connection.request("POST", "/emails", body=body, headers=headers)
        response = connection.getresponse()
        payload = json.loads(response.read().decode() or "{}")
    finally:
        connection.close()
    if response.status < 200 or response.status >= 300:
        raise RuntimeError(f"Resend returned HTTP {response.status}")
    return payload.get("id", "")
