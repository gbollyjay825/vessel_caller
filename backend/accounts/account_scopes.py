"""Organization account identity helpers; an email is not a global principal."""

from urllib.parse import urlencode

from django.conf import settings
from django.db.models import Q

from organizations.models import Organization


def organization_sign_in_url(organization: Organization) -> str:
    return f"{settings.FRONTEND_URL.rstrip('/')}/login?{urlencode({'organizationId': organization.pk})}"


def organization_action_url(organization: Organization, path: str, token: str) -> str:
    query = urlencode({"token": token, "organizationId": organization.pk})
    return f"{settings.FRONTEND_URL.rstrip('/')}{path}?{query}"


def scoped_account_queryset(queryset, organization_id: str | None):
    """An optional login hint narrows a query; it never grants authorization."""

    return queryset.filter(organization_id=organization_id) if organization_id else queryset


def bounded_account_candidates(queryset, organization_id: str | None):
    """Bound anonymous hash/email fanout; never silently choose a partial set."""

    candidates = list(
        scoped_account_queryset(queryset, organization_id).order_by("organization_id", "id")[:17]
    )
    return candidates if len(candidates) <= 16 else []


def account_email_unavailable(
    organization: Organization, email: str, *, exclude_user_id=None
) -> bool:
    """Customer aliases may coexist; platform operator identities stay dedicated."""

    from .models import User

    candidates = User.objects.filter(email__iexact=email.strip())
    if exclude_user_id:
        candidates = candidates.exclude(pk=exclude_user_id)
    if organization.kind == Organization.Kind.CUSTOMER:
        candidates = candidates.filter(
            Q(organization=organization) | Q(organization__kind=Organization.Kind.PLATFORM)
        )
    return candidates.exists()
