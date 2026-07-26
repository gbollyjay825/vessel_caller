from __future__ import annotations

from django.http import JsonResponse
from rest_framework.exceptions import ErrorDetail
from rest_framework.views import exception_handler


def _plain(value):
    if isinstance(value, dict):
        return {key: _plain(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_plain(item) for item in value]
    if isinstance(value, ErrorDetail):
        return str(value)
    return value


def api_exception_handler(exc, context):
    response = exception_handler(exc, context)
    if response is None:
        return None
    request = context.get("request")
    request_id = getattr(request, "request_id", "") if request else ""
    raw = _plain(response.data)
    if isinstance(raw, dict) and set(raw) == {"detail"}:
        detail = raw["detail"]
        errors = None
    else:
        detail = "The request could not be completed"
        errors = raw
    response.data = {
        "detail": detail,
        "errors": errors,
        "requestId": request_id,
    }
    return response


def csrf_failure(request, reason=""):
    return JsonResponse(
        {
            "detail": "CSRF validation failed",
            "errors": None,
            "requestId": getattr(request, "request_id", ""),
        },
        status=403,
    )
