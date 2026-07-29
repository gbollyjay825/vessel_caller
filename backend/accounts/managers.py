from __future__ import annotations

from typing import TYPE_CHECKING

from django.contrib.auth.base_user import BaseUserManager
from django.utils import timezone

if TYPE_CHECKING:
    from .models import User  # noqa: F401


class UserManager(BaseUserManager["User"]):
    use_in_migrations = True

    def _create_user(self, email, password, **extra_fields):
        if not email:
            raise ValueError("Email is required")
        email = self.normalize_email(email).strip().lower()
        user = self.model(email=email, **extra_fields)
        user.set_password(password)
        user.save(using=self._db)
        return user

    def create_user(self, email, password=None, **extra_fields):
        extra_fields.setdefault("is_staff", False)
        extra_fields.setdefault("is_superuser", False)
        return self._create_user(email, password, **extra_fields)

    def create_superuser(self, email, password=None, **extra_fields):
        extra_fields.setdefault("is_staff", True)
        extra_fields.setdefault("is_superuser", True)
        extra_fields.setdefault("role", "Admin")
        extra_fields.setdefault("status", "active")
        extra_fields.setdefault("email_verified_at", timezone.now())
        if not extra_fields.get("organization"):
            from organizations.models import Organization, OrganizationSettings

            organization = Organization.objects.create(
                name=extra_fields.pop("organization_name", "Platform Administration"),
                email=email,
                registered=True,
            )
            OrganizationSettings.objects.create(organization=organization)
            from billing.services import ensure_default_steps

            ensure_default_steps(organization)
            extra_fields["organization"] = organization
        return self._create_user(email, password, **extra_fields)
