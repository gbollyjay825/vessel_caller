from __future__ import annotations

from copy import deepcopy
import re

import pytest
from django.core.management import call_command
from django.core.management.base import CommandError

from accounts.models import User

pytestmark = pytest.mark.django_db


def test_scoped_identity_fixtures_refuse_a_non_test_database_before_writes(settings, monkeypatch):
    databases = deepcopy(settings.DATABASES)
    databases["default"]["NAME"] = "vessel_customer_data"
    monkeypatch.setattr(settings, "DATABASES", databases)
    settings.DEBUG = True
    with pytest.raises(CommandError, match="isolated e2e/test database"):
        call_command(
            "seed_e2e",
            password="Local-E2E-Strong-Password-2026!",
            organization_identity_fixtures=True,
        )
    assert not User.objects.exists()


def test_scoped_identity_fixtures_are_opt_in_and_keep_the_original_scope(settings):
    settings.DEBUG = True
    password = "Local-E2E-Strong-Password-2026!"
    call_command("seed_e2e", password=password)
    assert User.objects.count() == 4
    if not re.search(
        r"(?:^|[_-])(?:e2e|test)(?:$|[_-])",
        str(settings.DATABASES["default"]["NAME"]),
        re.IGNORECASE,
    ):
        pytest.skip("Scoped browser fixtures require a named isolated PostgreSQL test database")
    call_command("seed_e2e", password=password, organization_identity_fixtures=True)
    call_command("seed_e2e", password=password, organization_identity_fixtures=True)
    original = User.objects.get(email="shared-chromium-0@e2e.vesselcalls.test")
    assert original.organization_id == "org-e2eoriginal01"
    assert original.role == User.Role.VIEWER
    assert original.check_password(password)
    assert User.objects.count() == 16
