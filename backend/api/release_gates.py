"""Fail-closed controls for a credential-deferred internal test release."""

from django.conf import settings
from rest_framework import status
from rest_framework.exceptions import APIException


class InternalTestingOnly(APIException):
    status_code = status.HTTP_503_SERVICE_UNAVAILABLE
    default_code = "internal_testing_only"
    default_detail = "This action is unavailable during internal admin testing."


def require_public_registration() -> None:
    if not settings.PUBLIC_REGISTRATION_ENABLED:
        raise InternalTestingOnly(
            "Organization registration is not open during internal admin testing."
        )


def require_email_delivery() -> None:
    if settings.EMAIL_DELIVERY_BACKEND == "disabled":
        raise InternalTestingOnly(
            "Email-dependent account actions are unavailable during internal admin testing."
        )
