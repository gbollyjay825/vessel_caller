from __future__ import annotations

from django.contrib.auth.backends import ModelBackend

from organizations.models import Organization

from .models import User
from .account_scopes import scoped_account_queryset
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
        accounts = self.password_proven_accounts(
            normalized, password, organization_id=kwargs.get("organization_id")
        )
        if len(accounts) == 1 and verify_password_compat(accounts[0], password):
            return accounts[0]
        return None

    @classmethod
    def password_proven_accounts(
        cls,
        email: str,
        password: str,
        *,
        organization_id=None,
        include_temporary=False,
        product_login=False,
    ) -> list[User]:
        from .temporary_passwords import _temporary_identity_available

        candidate_query = scoped_account_queryset(
            User.objects.select_related("organization").filter(email__iexact=email),
            organization_id,
        ).order_by("organization_id", "id")
        candidates = list(candidate_query[:17])
        if len(candidates) > 16:
            # A shared address must not amplify an anonymous request into an
            # unbounded number of password hashes. Scoped links stay usable.
            _burn_password_hash(password)
            return []
        matched = []
        for user in candidates:
            normal = user.is_active and cls._platform_login_allowed(user)
            temporary = include_temporary and _temporary_identity_available(user)
            eligible = (normal or temporary) and (
                not product_login
                or (
                    not user.is_staff
                    and not user.is_superuser
                    and (temporary or user.login_identity_approved)
                )
            )
            if not eligible:
                _burn_password_hash(password)
            elif verify_password_compat(user, password, upgrade=False):
                matched.append(user)
        if not candidates:
            _burn_password_hash(password)
        return matched

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
