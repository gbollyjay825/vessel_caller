# mypy: ignore-errors
from pathlib import Path
from email.utils import parseaddr

from django.core.exceptions import ImproperlyConfigured

from .base import *  # noqa: F403

DEBUG = False
SYSTEM_ADMIN_MUTATIONS_ENABLED = env_bool(  # noqa: F405
    "VC_SYSTEM_ADMIN_MUTATIONS_ENABLED", False
)
SYSTEM_ADMIN_MUTATION_FLAG_FILE = env(  # noqa: F405
    "VC_SYSTEM_ADMIN_MUTATION_FLAG_FILE",
    f"/etc/vessel-caller/system-admin-mutations-{ENVIRONMENT}.flag",  # noqa: F405
)
expected_system_admin_flag = {
    "production": "/etc/vessel-caller/system-admin-mutations-production.flag",
    "staging": "/etc/vessel-caller/system-admin-mutations-staging.flag",
}.get(ENVIRONMENT)  # noqa: F405
if not expected_system_admin_flag:
    raise ImproperlyConfigured(
        "Production settings require VC_ENVIRONMENT to be production or staging"
    )
if SYSTEM_ADMIN_MUTATIONS_ENABLED:
    raise ImproperlyConfigured(
        "Production System Administrator mutations must use the dynamic flag file"
    )
if not SYSTEM_ADMIN_MUTATION_FLAG_FILE or not Path(SYSTEM_ADMIN_MUTATION_FLAG_FILE).is_absolute():
    raise ImproperlyConfigured(
        "VC_SYSTEM_ADMIN_MUTATION_FLAG_FILE must be an absolute root-managed path"
    )
if SYSTEM_ADMIN_MUTATION_FLAG_FILE != expected_system_admin_flag:
    raise ImproperlyConfigured(
        "VC_SYSTEM_ADMIN_MUTATION_FLAG_FILE must use the exact environment-specific root path"
    )
if not 300 <= SYSTEM_ADMIN_MFA_STEP_UP_SECONDS <= 1800:  # noqa: F405
    raise ImproperlyConfigured(
        "VC_SYSTEM_ADMIN_MFA_STEP_UP_SECONDS must be between 300 and 1800 seconds"
    )
SESSION_COOKIE_SECURE = True
CSRF_COOKIE_SECURE = True
SECURE_SSL_REDIRECT = env_bool("VC_SECURE_SSL_REDIRECT", True)  # noqa: F405
SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")
SECURE_HSTS_SECONDS = 63_072_000
SECURE_HSTS_INCLUDE_SUBDOMAINS = True
SECURE_HSTS_PRELOAD = True

if SECRET_KEY == "development-only-not-for-production" or len(SECRET_KEY) < 40:  # nosec B105
    raise ImproperlyConfigured("VC_SECRET_KEY must be a strong production secret")
if DATABASES["default"]["ENGINE"] != "django.db.backends.postgresql":
    raise ImproperlyConfigured("Production requires PostgreSQL via VC_DATABASE_URL")
if not env("VC_ALLOWED_HOSTS"):  # noqa: F405
    raise ImproperlyConfigured("VC_ALLOWED_HOSTS is required")
if not env("VC_CSRF_TRUSTED_ORIGINS"):  # noqa: F405
    raise ImproperlyConfigured("VC_CSRF_TRUSTED_ORIGINS is required")
if DATABASES["default"].get("OPTIONS", {}).get("sslmode") not in {
    "require",
    "verify-ca",
    "verify-full",
}:
    raise ImproperlyConfigured("Production PostgreSQL must require TLS")

redis_url = env("VC_REDIS_URL")  # noqa: F405
if not redis_url:
    raise ImproperlyConfigured("VC_REDIS_URL is required")
CACHES = {
    "default": {
        "BACKEND": "django.core.cache.backends.redis.RedisCache",
        "LOCATION": redis_url,
        "TIMEOUT": 300,
    }
}

spaces_key = env("VC_SPACES_KEY")  # noqa: F405
required_spaces = (
    "VC_SPACES_KEY",
    "VC_SPACES_SECRET",
    "VC_SPACES_BUCKET",
    "VC_SPACES_ENDPOINT_URL",
)
missing_spaces = [name for name in required_spaces if not env(name)]  # noqa: F405
if missing_spaces:
    raise ImproperlyConfigured("Private Spaces storage is incomplete: " + ", ".join(missing_spaces))
STORAGES["default"] = {
    "BACKEND": "storages.backends.s3.S3Storage",
    "OPTIONS": {
        "access_key": spaces_key,
        "secret_key": env("VC_SPACES_SECRET"),  # noqa: F405
        "bucket_name": env("VC_SPACES_BUCKET"),  # noqa: F405
        "region_name": env("VC_SPACES_REGION", "nyc3"),  # noqa: F405
        "endpoint_url": env("VC_SPACES_ENDPOINT_URL"),  # noqa: F405
        "default_acl": "private",
        "querystring_auth": True,
        "file_overwrite": False,
    },
}

DEFERRED_PROVIDER_CUTOVER = env_bool("VC_DEFERRED_PROVIDER_CUTOVER", False)  # noqa: F405
EMAIL_DELIVERY_BACKEND = env("VC_EMAIL_DELIVERY_BACKEND", "resend")  # noqa: F405
if EMAIL_DELIVERY_BACKEND == "resend":
    if not RESEND_API_KEY:
        raise ImproperlyConfigured("Production Resend delivery requires VC_RESEND_API_KEY")
    configured_sender = env("VC_EMAIL_FROM").strip()  # noqa: F405
    sender_address = parseaddr(configured_sender)[1].lower()
    if (
        not configured_sender
        or not sender_address
        or "@" not in sender_address
        or sender_address.endswith(("@example.com", "@example.test", "@localhost"))
        or "change_me" in configured_sender.lower()
    ):
        raise ImproperlyConfigured(
            "Production Resend delivery requires a real explicit VC_EMAIL_FROM sender"
        )
elif not (
    DEFERRED_PROVIDER_CUTOVER and EMAIL_DELIVERY_BACKEND == "disabled" and not RESEND_API_KEY
):
    raise ImproperlyConfigured(
        "Production email may be disabled only for an explicit deferred-provider cutover"
    )
weak_mfa_keys = {"change_me", "changeme", "development", "development-only-not-for-production"}
if (
    len(MFA_ENCRYPTION_KEY) < 48
    or MFA_ENCRYPTION_KEY.lower() in weak_mfa_keys
    or MFA_ENCRYPTION_KEY == SECRET_KEY
    or len(set(MFA_ENCRYPTION_KEY)) < 16
):
    raise ImproperlyConfigured(
        "VC_MFA_ENCRYPTION_KEY must be an independent high-entropy secret of at least 48 characters"
    )
if RELEASE_SHA == "development":
    raise ImproperlyConfigured("VC_RELEASE_SHA is required")
SENTRY_ENABLED = env_bool("VC_SENTRY_ENABLED", True)  # noqa: F405
if SENTRY_ENABLED:
    if not SENTRY_DSN:
        raise ImproperlyConfigured("Enabled production Sentry requires VC_SENTRY_DSN")
elif not (DEFERRED_PROVIDER_CUTOVER and not SENTRY_DSN):
    raise ImproperlyConfigured(
        "Production Sentry may be disabled only for an explicit deferred-provider cutover"
    )

from vessel_caller.sentry import initialize_sentry  # noqa: E402

if SENTRY_ENABLED:
    initialize_sentry()
