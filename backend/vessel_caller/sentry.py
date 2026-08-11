from __future__ import annotations

import os
from urllib.parse import urlsplit, urlunsplit


def _strip_query(value: object) -> object:
    if not isinstance(value, str):
        return value
    try:
        parsed = urlsplit(value)
    except ValueError:
        return value.split("?", 1)[0].split("#", 1)[0]
    return urlunsplit((parsed.scheme, parsed.netloc, parsed.path, "", ""))


def _before_breadcrumb(breadcrumb, hint):
    del hint
    data = breadcrumb.get("data")
    if isinstance(data, dict):
        if "url" in data:
            data["url"] = _strip_query(data["url"])
        for key in ("params", "query", "query_string"):
            data.pop(key, None)
    return breadcrumb


def _before_send(event, hint):
    del hint
    request = event.get("request")
    platform_request = False
    if request:
        headers = request.get("headers") or {}
        for key in list(headers):
            if key.lower() in {"authorization", "cookie", "referer", "x-csrftoken"}:
                headers[key] = "[REDACTED]"
        request.pop("cookies", None)
        request.pop("data", None)
        request.pop("env", None)
        request.pop("query_string", None)
        if "url" in request:
            request["url"] = _strip_query(request["url"])
            stripped_url = request["url"]
            if isinstance(stripped_url, str):
                platform_request = urlsplit(stripped_url).path.startswith("/api/system/")
        request["headers"] = headers
    if "transaction" in event:
        event["transaction"] = _strip_query(event["transaction"])
    breadcrumbs = event.get("breadcrumbs")
    if isinstance(breadcrumbs, dict) and isinstance(breadcrumbs.get("values"), list):
        breadcrumbs["values"] = [
            _before_breadcrumb(item, {}) if isinstance(item, dict) else item
            for item in breadcrumbs["values"]
        ]
    if platform_request:
        # Database and HTTP span descriptions can include lookup parameters.
        # Keep the error/transaction envelope, but omit those detailed spans
        # for the cross-organization control plane.
        event.pop("spans", None)
    user = event.get("user")
    if user:
        event["user"] = {"id": user.get("id")}
    return event


def _before_send_transaction(event, hint):
    return _before_send(event, hint)


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
        before_send_transaction=_before_send_transaction,
        before_breadcrumb=_before_breadcrumb,
    )
