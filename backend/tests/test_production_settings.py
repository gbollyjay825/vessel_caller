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
    "VC_ENVIRONMENT": "production",
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


def test_resend_requires_an_explicit_non_placeholder_sender():
    common = {
        "VC_DEFERRED_PROVIDER_CUTOVER": "true",
        "VC_EMAIL_DELIVERY_BACKEND": "resend",
        "VC_RESEND_API_KEY": "resend-key",
        "VC_SENTRY_DSN": "",
        "VC_SENTRY_ENABLED": "false",
    }
    blank = import_production_settings(**common, VC_EMAIL_FROM="")
    placeholder = import_production_settings(
        **common,
        VC_EMAIL_FROM="Vessel Caller <noreply@example.test>",
    )
    valid = import_production_settings(
        **common,
        VC_EMAIL_FROM="Vessel Caller <no-reply@vesselcalls.com>",
    )

    assert blank.returncode != 0
    assert placeholder.returncode != 0
    assert "real explicit VC_EMAIL_FROM" in blank.stderr
    assert "real explicit VC_EMAIL_FROM" in placeholder.stderr
    assert valid.returncode == 0, valid.stderr


def test_system_admin_step_up_window_is_bounded():
    common = {
        "VC_DEFERRED_PROVIDER_CUTOVER": "true",
        "VC_EMAIL_DELIVERY_BACKEND": "disabled",
        "VC_RESEND_API_KEY": "",
        "VC_SENTRY_DSN": "",
        "VC_SENTRY_ENABLED": "false",
    }
    too_short = import_production_settings(
        **common,
        VC_SYSTEM_ADMIN_MFA_STEP_UP_SECONDS="299",
    )
    too_long = import_production_settings(
        **common,
        VC_SYSTEM_ADMIN_MFA_STEP_UP_SECONDS="1801",
    )
    valid = import_production_settings(
        **common,
        VC_SYSTEM_ADMIN_MFA_STEP_UP_SECONDS="900",
    )

    assert too_short.returncode != 0
    assert too_long.returncode != 0
    assert "must be between 300 and 1800" in too_short.stderr
    assert "must be between 300 and 1800" in too_long.stderr
    assert valid.returncode == 0, valid.stderr


def test_production_system_admin_mutation_gate_requires_absolute_dynamic_flag():
    common = {
        "VC_DEFERRED_PROVIDER_CUTOVER": "true",
        "VC_EMAIL_DELIVERY_BACKEND": "disabled",
        "VC_RESEND_API_KEY": "",
        "VC_SENTRY_DSN": "",
        "VC_SENTRY_ENABLED": "false",
    }
    env_enabled = import_production_settings(
        **common,
        VC_SYSTEM_ADMIN_MUTATIONS_ENABLED="true",
    )
    relative = import_production_settings(
        **common,
        VC_SYSTEM_ADMIN_MUTATIONS_ENABLED="false",
        VC_SYSTEM_ADMIN_MUTATION_FLAG_FILE="relative.flag",
    )
    blank = import_production_settings(
        **common,
        VC_SYSTEM_ADMIN_MUTATIONS_ENABLED="false",
        VC_SYSTEM_ADMIN_MUTATION_FLAG_FILE="",
    )
    wrong_absolute = import_production_settings(
        **common,
        VC_SYSTEM_ADMIN_MUTATIONS_ENABLED="false",
        VC_SYSTEM_ADMIN_MUTATION_FLAG_FILE="/etc/vessel-caller/system-admin-mutations-other.flag",
    )
    staging = import_production_settings(
        **common,
        VC_ENVIRONMENT="staging",
        VC_SYSTEM_ADMIN_MUTATIONS_ENABLED="false",
        VC_SYSTEM_ADMIN_MUTATION_FLAG_FILE="/etc/vessel-caller/system-admin-mutations-staging.flag",
    )
    unsupported_environment = import_production_settings(
        **common,
        VC_ENVIRONMENT="development",
        VC_SYSTEM_ADMIN_MUTATIONS_ENABLED="false",
    )

    assert env_enabled.returncode != 0
    assert "must use the dynamic flag file" in env_enabled.stderr
    assert relative.returncode != 0
    assert blank.returncode != 0
    assert "must be an absolute root-managed path" in relative.stderr
    assert "must be an absolute root-managed path" in blank.stderr
    assert wrong_absolute.returncode != 0
    assert "exact environment-specific root path" in wrong_absolute.stderr
    assert staging.returncode == 0, staging.stderr
    assert unsupported_environment.returncode != 0
    assert "VC_ENVIRONMENT to be production or staging" in unsupported_environment.stderr
