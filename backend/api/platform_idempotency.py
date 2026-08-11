from __future__ import annotations

import hashlib
import json
import re
from functools import wraps

from django.conf import settings
from django.db import transaction
from django.db.models import Q
from django.utils import timezone
from rest_framework import status
from rest_framework.exceptions import APIException, PermissionDenied, ValidationError
from rest_framework.response import Response

from accounts.models import PlatformAccessGrant, PlatformMutationRequest, User
from organizations.models import Organization

from .permissions import RecentSystemMFARequired


IDEMPOTENCY_KEY = re.compile(r"^[A-Za-z0-9._:-]{8,128}$")


class IdempotencyConflict(APIException):
    status_code = status.HTTP_409_CONFLICT
    default_detail = "That Idempotency-Key was already used for another request"
    default_code = "idempotency_conflict"


def _request_hash(request, action: str) -> str:
    canonical = json.dumps(
        {
            "action": action,
            "method": request.method,
            "path": request.path,
            "body": request.data,
        },
        sort_keys=True,
        separators=(",", ":"),
        default=str,
    )
    return hashlib.sha256(canonical.encode()).hexdigest()


def idempotent_system_mutation(action: str):
    def decorate(func):
        @wraps(func)
        def wrapped(self, request, *args, **kwargs):
            key = request.headers.get("Idempotency-Key", "").strip()
            if not IDEMPOTENCY_KEY.fullmatch(key):
                raise ValidationError(
                    {
                        "idempotencyKey": [
                            "Provide an opaque Idempotency-Key of 8 to 128 safe characters"
                        ]
                    }
                )
            request_hash = _request_hash(request, action)
            target_id = kwargs.get("organization_id")
            with transaction.atomic():
                platform_organization = (
                    Organization.objects.select_for_update()
                    .filter(
                        pk=request.user.organization_id,
                        kind=Organization.Kind.PLATFORM,
                        access_status=Organization.AccessStatus.ACTIVE,
                    )
                    .first()
                )
                if not platform_organization:
                    raise PermissionDenied("System administrator access is required")
                actor = (
                    User.objects.select_for_update()
                    .select_related("organization")
                    .filter(
                        pk=request.user.pk,
                        organization=platform_organization,
                        status=User.Status.ACTIVE,
                        email_verified_at__isnull=False,
                        is_staff=False,
                        is_superuser=False,
                    )
                    .first()
                )
                grant = (
                    PlatformAccessGrant.objects.select_for_update()
                    .filter(
                        user=actor,
                        role=PlatformAccessGrant.Role.SYSTEM_ADMIN,
                        revoked_at__isnull=True,
                    )
                    .filter(Q(expires_at__isnull=True) | Q(expires_at__gt=timezone.now()))
                    .first()
                    if actor
                    else None
                )
                if not actor or not actor.mfa_enabled or not grant:
                    raise PermissionDenied("System administrator access is required")
                verified_at = request.session.get("mfa_verified_at")
                age = (
                    timezone.now().timestamp() - verified_at
                    if isinstance(verified_at, (int, float))
                    else None
                )
                if age is None or not 0 <= age <= settings.SYSTEM_ADMIN_MFA_STEP_UP_SECONDS:
                    raise RecentSystemMFARequired()
                request.user = actor
                target = Organization.objects.filter(pk=target_id).first() if target_id else None
                mutation, _ = PlatformMutationRequest.objects.get_or_create(
                    actor=actor,
                    key=key,
                    defaults={
                        "action": action,
                        "request_hash": request_hash,
                        "target_organization": target,
                    },
                )
                mutation = PlatformMutationRequest.objects.select_for_update().get(pk=mutation.pk)
                if mutation.action != action or mutation.request_hash != request_hash:
                    raise IdempotencyConflict()
                if mutation.status == PlatformMutationRequest.Status.COMPLETED:
                    return Response(
                        mutation.response_body,
                        status=mutation.response_status or status.HTTP_200_OK,
                    )
                response = func(self, request, *args, **kwargs)
                body = json.loads(json.dumps(response.data, default=str))
                mutation.status = PlatformMutationRequest.Status.COMPLETED
                mutation.response_status = response.status_code
                mutation.response_body = body
                mutation.completed_at = timezone.now()
                mutation.save(
                    update_fields=(
                        "status",
                        "response_status",
                        "response_body",
                        "completed_at",
                        "updated_at",
                    )
                )
                return response

        return wrapped

    return decorate
