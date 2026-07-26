from __future__ import annotations

from django.contrib.auth.backends import ModelBackend

from .models import User
from .security import verify_password_compat


class EmailBackend(ModelBackend):
    def authenticate(self, request, username=None, password=None, email=None, **kwargs):
        normalized = (email or username or "").strip().lower()
        if not normalized or password is None:
            return None
        try:
            user = User.objects.get(email=normalized)
        except User.DoesNotExist:
            User().set_password(password)
            return None
        if user.is_active and verify_password_compat(user, password):
            return user
        return None
