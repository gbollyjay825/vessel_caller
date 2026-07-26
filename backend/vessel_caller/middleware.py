from __future__ import annotations

import uuid


class RequestIdMiddleware:
    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        incoming = request.headers.get("X-Request-ID", "")
        request.request_id = incoming[:128] if incoming else uuid.uuid4().hex
        response = self.get_response(request)
        response["X-Request-ID"] = request.request_id
        response.setdefault("Cross-Origin-Opener-Policy", "same-origin")
        return response
