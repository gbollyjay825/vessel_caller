from __future__ import annotations

from django.contrib.auth.backends import ModelBackend

from organizations.models import Organization

from .models import User
from .security import verify_password_compat


def _burn_password_hash(password: str) -> None:
    """Consume the normal password-hash cost without touching a stored credential."""

    User().set_password(password)


class EmailBackend(ModelBackend):
    @staticmethod
    def _platform_login_allowed(user: User) -> bool:
        if user.organization.kind != Organization.Kind.PLATFORM:
            return True
        if user.is_staff or user.is_superuser:
            return True
        from .platform_access import active_platform_grant

        return active_platform_grant(user) is not None

    def authenticate(self, request, username=None, password=None, email=None, **kwargs):
        normalized = (email or username or "").strip().lower()
        if not normalized or password is None:
            return None
        try:
            user = User.objects.select_related("organization").get(email=normalized)
        except User.DoesNotExist:
            _burn_password_hash(password)
            return None
        if not user.is_active or not self._platform_login_allowed(user):
            _burn_password_hash(password)
            return None
        if verify_password_compat(user, password):
            return user
        return None

    def get_user(self, user_id):
        try:
            user = User.objects.select_related("organization").get(pk=user_id)
        except User.DoesNotExist:
            return None
        return (
            user
            if self.user_can_authenticate(user) and self._platform_login_allowed(user)
            else None
        )
