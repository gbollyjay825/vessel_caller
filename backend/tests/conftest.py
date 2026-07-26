from __future__ import annotations

import pytest
from django.utils import timezone
from rest_framework.test import APIClient

from accounts.models import User
from organizations.models import Organization, OrganizationSettings


@pytest.fixture
def api_client():
    return APIClient()


@pytest.fixture
def organization(db):
    organization = Organization.objects.create(
        name="Acme Marine",
        email="admin@acme.test",
        registered=True,
        primary_port="Port of Calabar",
        ports=["Port of Calabar"],
    )
    OrganizationSettings.objects.create(
        organization=organization,
        terminals=["Government Jetty", "International Jetty"],
    )
    return organization


@pytest.fixture
def admin(organization):
    return User.objects.create_user(
        email="admin@acme.test",
        password="A-strong-admin-password-2026!",
        organization=organization,
        name="Admin One",
        role=User.Role.ADMIN,
        status=User.Status.ACTIVE,
        email_verified_at=timezone.now(),
    )


@pytest.fixture
def operations(organization):
    return User.objects.create_user(
        email="operations@acme.test",
        password="A-strong-operations-password-2026!",
        organization=organization,
        name="Operations One",
        role=User.Role.OPERATIONS,
        status=User.Status.ACTIVE,
        email_verified_at=timezone.now(),
    )


@pytest.fixture
def finance(organization):
    return User.objects.create_user(
        email="finance@acme.test",
        password="A-strong-finance-password-2026!",
        organization=organization,
        name="Finance One",
        role=User.Role.FINANCE,
        status=User.Status.ACTIVE,
        email_verified_at=timezone.now(),
    )


@pytest.fixture
def viewer(organization):
    return User.objects.create_user(
        email="viewer@acme.test",
        password="A-strong-viewer-password-2026!",
        organization=organization,
        name="Viewer One",
        role=User.Role.VIEWER,
        status=User.Status.ACTIVE,
        email_verified_at=timezone.now(),
    )


def authenticated(user):
    client = APIClient()
    client.force_authenticate(user=user)
    return client
