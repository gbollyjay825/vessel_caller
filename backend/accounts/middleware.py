from __future__ import annotations

from datetime import timedelta

from django.contrib.auth import logout
from django.utils import timezone

from .models import UserSession


class ManagedSessionMiddleware:
    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        if getattr(request, "user", None) and request.user.is_authenticated:
            session_key = request.session.session_key
            managed = UserSession.objects.filter(session_key=session_key, user=request.user).first()
            now = timezone.now()
            if (
                managed is None
                or managed.revoked_at is not None
                or managed.absolute_expires_at <= now
                or not request.user.is_active
            ):
                logout(request)
            elif managed.last_seen_at <= now - timedelta(minutes=5):
                managed.last_seen_at = now
                managed.save(update_fields=("last_seen_at",))
        return self.get_response(request)
