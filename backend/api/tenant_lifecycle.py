from __future__ import annotations

from django.db import transaction
from rest_framework.views import APIView

from organizations.models import Organization


class TenantLifecycleAPIView(APIView):
    """Hold the customer lifecycle lock across authenticated mutations.

    DRF authentication and permissions run inside this transaction.  The
    lifecycle permissions acquire the ACTIVE organization row first and then
    the active actor, so a concurrent System Administrator suspension has one
    deterministic linearization point with every customer mutation.

    Read-only endpoints do not take the lock unless they issue a new signed
    private-storage capability.  Already-issued short-lived capabilities keep
    their documented expiry and cannot be recalled.
    """

    lifecycle_capability_methods: frozenset[str] = frozenset()

    def dispatch(self, request, *args, **kwargs):
        method = request.method.upper()
        unsafe = method not in {"GET", "HEAD", "OPTIONS"}
        capability = method in self.lifecycle_capability_methods
        # SessionAuthentication uses Django's already-resolved request user.
        # DRF tests attach _force_auth_user before dispatch, so both production
        # and test authentication paths are classified without wrapping public
        # anonymous flows whose intentional failure counters must commit.
        user = getattr(request, "_force_auth_user", None) or getattr(request, "user", None)
        customer = bool(
            user
            and getattr(user, "is_authenticated", False)
            and getattr(getattr(user, "organization", None), "kind", None)
            == Organization.Kind.CUSTOMER
        )
        if customer and (unsafe or capability):
            with transaction.atomic():
                response = super().dispatch(request, *args, **kwargs)
                # DRF converts APIException into a Response inside dispatch,
                # so no Python exception would otherwise cross this atomic
                # block.  Mark handled error responses for rollback to prevent
                # a validation/permission failure committing partial writes.
                if getattr(response, "exception", False):
                    transaction.set_rollback(True)
                return response
        return super().dispatch(request, *args, **kwargs)
