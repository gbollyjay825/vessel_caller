from __future__ import annotations

import os


def _before_send(event, hint):
    request = event.get("request")
    if request:
        headers = request.get("headers") or {}
        for key in list(headers):
            if key.lower() in {"authorization", "cookie", "x-csrftoken"}:
                headers[key] = "[REDACTED]"
        request.pop("cookies", None)
        request.pop("data", None)
        request["headers"] = headers
    user = event.get("user")
    if user:
        event["user"] = {"id": user.get("id")}
    return event


def initialize_sentry() -> None:
    dsn = os.getenv("VC_SENTRY_DSN")
    if not dsn:
        return
    import sentry_sdk

    sentry_sdk.init(
        dsn=dsn,
        environment=os.getenv("VC_ENVIRONMENT", "production"),
        release=os.getenv("VC_RELEASE_SHA") or os.getenv("VC_RELEASE_TAG"),
        send_default_pii=False,
        traces_sample_rate=float(os.getenv("VC_SENTRY_TRACES_SAMPLE_RATE", "0.05")),
        before_send=_before_send,
    )
