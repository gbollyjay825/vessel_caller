from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path


BACKEND_ROOT = Path(__file__).resolve().parents[1]
VALID_PRODUCTION_ENV = {
    "DJANGO_SETTINGS_MODULE": "vessel_caller.settings.production",
    "VC_ALLOWED_HOSTS": "vesselcalls.com",
    "VC_CSRF_TRUSTED_ORIGINS": "https://vesselcalls.com",
    "VC_DATABASE_URL": "postgresql://app:secret@db.example.test/vessel?sslmode=require",
    "VC_EMAIL_FROM": "Vessel Caller <noreply@vesselcalls.com>",
    "VC_MFA_ENCRYPTION_KEY": "mfa-key-" + ("0123456789abcdef" * 4),
    "VC_REDIS_URL": "redis://:strong-password@127.0.0.1:6380/0",
    "VC_RELEASE_SHA": "0123456789abcdef0123456789abcdef01234567",
    "VC_SECRET_KEY": "django-secret-" + ("0123456789abcdef" * 4),
    "VC_SPACES_BUCKET": "vessel-caller-production",
    "VC_SPACES_ENDPOINT_URL": "https://nyc3.digitaloceanspaces.com",
    "VC_SPACES_KEY": "spaces-key",
    "VC_SPACES_SECRET": "spaces-secret",
}


def import_production_settings(**overrides: str) -> subprocess.CompletedProcess[str]:
    environment = {
        **os.environ,
        **VALID_PRODUCTION_ENV,
        **overrides,
    }
    return subprocess.run(  # noqa: S603
        [
            sys.executable,
            "-c",
            "import vessel_caller.settings.production",
        ],
        cwd=BACKEND_ROOT,
        env=environment,
        capture_output=True,
        text=True,
        check=False,
    )


def test_explicit_deferred_provider_cutover_disables_resend_and_sentry():
    result = import_production_settings(
        VC_DEFERRED_PROVIDER_CUTOVER="true",
        VC_EMAIL_DELIVERY_BACKEND="disabled",
        VC_RESEND_API_KEY="",
        VC_SENTRY_DSN="",
        VC_SENTRY_ENABLED="false",
    )

    assert result.returncode == 0, result.stderr


def test_disabled_email_requires_explicit_cutover_flag():
    result = import_production_settings(
        VC_DEFERRED_PROVIDER_CUTOVER="false",
        VC_EMAIL_DELIVERY_BACKEND="disabled",
        VC_RESEND_API_KEY="",
        VC_SENTRY_DSN="https://public@example.ingest.sentry.io/123",
    )

    assert result.returncode != 0
    assert "explicit deferred-provider cutover" in result.stderr


def test_disabled_sentry_requires_explicit_cutover_flag():
    result = import_production_settings(
        VC_DEFERRED_PROVIDER_CUTOVER="false",
        VC_EMAIL_DELIVERY_BACKEND="resend",
        VC_RESEND_API_KEY="resend-key",
        VC_SENTRY_DSN="",
        VC_SENTRY_ENABLED="false",
    )

    assert result.returncode != 0
    assert "explicit deferred-provider cutover" in result.stderr


def test_enabled_providers_still_require_real_configuration():
    resend = import_production_settings(
        VC_EMAIL_DELIVERY_BACKEND="resend",
        VC_RESEND_API_KEY="",
        VC_SENTRY_DSN="https://public@example.ingest.sentry.io/123",
    )
    sentry = import_production_settings(
        VC_EMAIL_DELIVERY_BACKEND="resend",
        VC_RESEND_API_KEY="resend-key",
        VC_SENTRY_DSN="",
        VC_SENTRY_ENABLED="true",
    )

    assert resend.returncode != 0
    assert "requires VC_RESEND_API_KEY" in resend.stderr
    assert sentry.returncode != 0
    assert "requires VC_SENTRY_DSN" in sentry.stderr
