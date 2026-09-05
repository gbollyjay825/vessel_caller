from __future__ import annotations

import time
from datetime import timedelta

from django.conf import settings
from django.contrib.auth import logout
from django.contrib.sessions.middleware import SessionMiddleware
from django.db import transaction
from django.utils.http import http_date
from django.utils import timezone

from .models import User, UserSession


class IdentitySafeSessionMiddleware(SessionMiddleware):
    """Keep a stale ordinary response from deleting a newer login cookie.

    Browsers apply ``Set-Cookie`` in response-arrival order. If an ordinary
    request carrying session A reaches Django after a serialized logout(A) and
    login(B), Django's default middleware sees A as empty and emits a cookie
    deletion that would erase B. Only client-serialized session checks/logout,
    or an explicit identity endpoint that invalidated its own session, may
    therefore clear the browser cookie.
    """

    cookie_delete_paths = frozenset({"/api/auth/me", "/api/auth/logout"})

    def process_response(self, request, response):
        cookie_name = settings.SESSION_COOKIE_NAME
        incoming_cookie = request.COOKIES.get(cookie_name)
        allow_delete = request.path in self.cookie_delete_paths or getattr(
            request, "_vessel_allow_session_cookie_delete", False
        )
        suppress_stale_delete = False
        if incoming_cookie is not None and not allow_delete:
            try:
                suppress_stale_delete = request.session.is_empty()
            except AttributeError:
                pass
        if not suppress_stale_delete:
            return super().process_response(request, response)

        # Temporarily hide only the incoming session cookie so Django still
        # applies its normal Vary behavior without emitting a destructive
        # expiry header. Restore the request object for later middleware.
        request.COOKIES.pop(cookie_name, None)
        try:
            return super().process_response(request, response)
        finally:
            request.COOKIES[cookie_name] = incoming_cookie


class ManagedSessionMiddleware:
    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        if getattr(request, "user", None) and request.user.is_authenticated:
            session_key = request.session.session_key
            now = timezone.now()
            from organizations.models import Organization

            with transaction.atomic():
                organization = (
                    Organization.objects.select_for_update()
                    .filter(
                        pk=request.user.organization_id,
                        access_status=Organization.AccessStatus.ACTIVE,
                    )
                    .first()
                )
                locked_user = (
                    User.objects.select_for_update()
                    .filter(
                        pk=request.user.pk,
                        organization=organization,
                        status=User.Status.ACTIVE,
                    )
                    .first()
                    if organization is not None
                    else None
                )
                managed = (
                    UserSession.objects.select_for_update()
                    .filter(session_key=session_key, user=locked_user)
                    .first()
                    if locked_user is not None
                    else None
                )
                if (
                    organization is None
                    or locked_user is None
                    or managed is None
                    or managed.revoked_at is not None
                    or managed.absolute_expires_at <= now
                ):
                    logout(request)
                else:
                    locked_user.organization = organization
                    request.user = locked_user
                if (
                    organization is not None
                    and locked_user is not None
                    and managed is not None
                    and managed.revoked_at is None
                    and managed.absolute_expires_at > now
                    and request.path == "/api/auth/me"
                    and managed.last_seen_at <= now - timedelta(minutes=5)
                ):
                    # Only the explicit session-refresh endpoint may extend the
                    # browser cookie. Ordinary delayed responses must never
                    # overwrite a newer identity's cookie after logout/login.
                    managed.last_seen_at = now
                    managed.save(update_fields=("last_seen_at",))
                    request.session.set_expiry(settings.SESSION_COOKIE_AGE)
                    request.session.save()
                    request.session.modified = False
                    request._vessel_refresh_session_cookie = True
        response = self.get_response(request)
        if (
            getattr(request, "_vessel_refresh_session_cookie", False)
            and response.status_code < 500
            and request.session.session_key
            and not request.session.is_empty()
        ):
            max_age = request.session.get_expiry_age()
            response.set_cookie(
                settings.SESSION_COOKIE_NAME,
                request.session.session_key,
                max_age=max_age,
                expires=http_date(time.time() + max_age),
                domain=settings.SESSION_COOKIE_DOMAIN,
                path=settings.SESSION_COOKIE_PATH,
                secure=settings.SESSION_COOKIE_SECURE or None,
                httponly=settings.SESSION_COOKIE_HTTPONLY or None,
                samesite=settings.SESSION_COOKIE_SAMESITE,
            )
        return response
