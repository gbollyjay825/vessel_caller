from __future__ import annotations

import time
from datetime import timedelta

from django.conf import settings
from django.contrib.auth import logout
from django.db import transaction
from django.utils.http import http_date
from django.utils import timezone

from .models import User, UserSession


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
                    and managed.last_seen_at <= now - timedelta(minutes=5)
                ):
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
