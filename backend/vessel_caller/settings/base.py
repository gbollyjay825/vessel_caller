from __future__ import annotations

import os
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

BASE_DIR = Path(__file__).resolve().parents[2]


def env(name: str, default: str = "") -> str:
    return os.getenv(name, default)


def env_bool(name: str, default: bool = False) -> bool:
    return env(name, str(default)).lower() in {"1", "true", "yes", "on"}


def env_list(name: str, default: str = "") -> list[str]:
    return [item.strip() for item in env(name, default).split(",") if item.strip()]


def database_from_url(url: str) -> dict:
    parsed = urlparse(url)
    if parsed.scheme in {"sqlite", "sqlite3"}:
        name = unquote(parsed.path)
        if name.startswith("//"):
            name = name[1:]
        if not name or name == "/":
            name = str(BASE_DIR / "vessel_caller.sqlite3")
        return {"ENGINE": "django.db.backends.sqlite3", "NAME": name}
    if parsed.scheme not in {"postgres", "postgresql"}:
        raise ValueError("VC_DATABASE_URL must use postgresql:// or sqlite:///")
    query = parse_qs(parsed.query)
    options: dict[str, str] = {}
    sslmode = query.get("sslmode", [None])[0]
    if sslmode:
        options["sslmode"] = sslmode
    return {
        "ENGINE": "django.db.backends.postgresql",
        "NAME": unquote(parsed.path.lstrip("/")),
        "USER": unquote(parsed.username or ""),
        "PASSWORD": unquote(parsed.password or ""),
        "HOST": parsed.hostname or "",
        "PORT": str(parsed.port or 5432),
        "CONN_MAX_AGE": 60,
        "CONN_HEALTH_CHECKS": True,
        "OPTIONS": options,
    }


SECRET_KEY = env("VC_SECRET_KEY", "development-only-not-for-production")
ENVIRONMENT = env("VC_ENVIRONMENT", "development")
DEBUG = env_bool("VC_DEBUG", False)
ALLOWED_HOSTS = env_list("VC_ALLOWED_HOSTS", "localhost,127.0.0.1,testserver")
CSRF_TRUSTED_ORIGINS = env_list("VC_CSRF_TRUSTED_ORIGINS")

INSTALLED_APPS = [
    "django.contrib.admin",
    "django.contrib.auth",
    "django.contrib.contenttypes",
    "django.contrib.sessions",
    "django.contrib.messages",
    "django.contrib.staticfiles",
    "rest_framework",
    "accounts",
    "organizations",
    "operations",
    "billing",
    "audit",
    "api",
]

MIDDLEWARE = [
    "django.middleware.security.SecurityMiddleware",
    "whitenoise.middleware.WhiteNoiseMiddleware",
    "vessel_caller.middleware.RequestIdMiddleware",
    "django.contrib.sessions.middleware.SessionMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.contrib.auth.middleware.AuthenticationMiddleware",
    "accounts.middleware.ManagedSessionMiddleware",
    "django.contrib.messages.middleware.MessageMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
]

ROOT_URLCONF = "vessel_caller.urls"
APPEND_SLASH = False
WSGI_APPLICATION = "vessel_caller.wsgi.application"
ASGI_APPLICATION = "vessel_caller.asgi.application"

TEMPLATES = [
    {
        "BACKEND": "django.template.backends.django.DjangoTemplates",
        "DIRS": [],
        "APP_DIRS": True,
        "OPTIONS": {
            "context_processors": [
                "django.template.context_processors.request",
                "django.contrib.auth.context_processors.auth",
                "django.contrib.messages.context_processors.messages",
            ],
        },
    }
]

DATABASES = {
    "default": database_from_url(
        env("VC_DATABASE_URL", f"sqlite:///{BASE_DIR / 'vessel_caller.sqlite3'}")
    )
}

AUTH_USER_MODEL = "accounts.User"
AUTHENTICATION_BACKENDS = ["accounts.backends.EmailBackend"]
PASSWORD_HASHERS = [
    "django.contrib.auth.hashers.Argon2PasswordHasher",
    "django.contrib.auth.hashers.PBKDF2PasswordHasher",
]
AUTH_PASSWORD_VALIDATORS = [
    {"NAME": "django.contrib.auth.password_validation.UserAttributeSimilarityValidator"},
    {
        "NAME": "django.contrib.auth.password_validation.MinimumLengthValidator",
        "OPTIONS": {"min_length": 12},
    },
    {"NAME": "django.contrib.auth.password_validation.CommonPasswordValidator"},
    {"NAME": "django.contrib.auth.password_validation.NumericPasswordValidator"},
]

LANGUAGE_CODE = "en-us"
TIME_ZONE = env("VC_TIME_ZONE", "Africa/Lagos")
USE_I18N = True
USE_TZ = True
DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"

STATIC_URL = "/static/"
STATIC_ROOT = BASE_DIR / "staticfiles"
MEDIA_URL = "/media/"
MEDIA_ROOT = BASE_DIR / "media"
STORAGES = {
    "default": {"BACKEND": "django.core.files.storage.FileSystemStorage"},
    "staticfiles": {"BACKEND": "whitenoise.storage.CompressedManifestStaticFilesStorage"},
}

SESSION_ENGINE = "django.contrib.sessions.backends.db"
SESSION_COOKIE_NAME = "__Host-vessel_session"
SESSION_COOKIE_AGE = 60 * 60 * 12
SESSION_SAVE_EVERY_REQUEST = False
SESSION_COOKIE_HTTPONLY = True
SESSION_COOKIE_SAMESITE = "Lax"
SESSION_COOKIE_SECURE = env_bool("VC_SESSION_COOKIE_SECURE", True)
CSRF_COOKIE_NAME = "csrftoken"
CSRF_COOKIE_SAMESITE = "Lax"
CSRF_COOKIE_SECURE = SESSION_COOKIE_SECURE
CSRF_COOKIE_HTTPONLY = False
CSRF_FAILURE_VIEW = "api.exceptions.csrf_failure"

SECURE_CONTENT_TYPE_NOSNIFF = True
SECURE_REFERRER_POLICY = "same-origin"
X_FRAME_OPTIONS = "DENY"

REST_FRAMEWORK = {
    "DEFAULT_AUTHENTICATION_CLASSES": ["rest_framework.authentication.SessionAuthentication"],
    "DEFAULT_PERMISSION_CLASSES": ["api.permissions.IsActiveAccount"],
    "DEFAULT_PAGINATION_CLASS": "api.pagination.StandardPagination",
    "PAGE_SIZE": 25,
    "EXCEPTION_HANDLER": "api.exceptions.api_exception_handler",
    "DEFAULT_SCHEMA_CLASS": "rest_framework.schemas.openapi.AutoSchema",
    "DEFAULT_RENDERER_CLASSES": ["rest_framework.renderers.JSONRenderer"],
}

CACHES = {
    "default": {
        "BACKEND": "django.core.cache.backends.locmem.LocMemCache",
        "LOCATION": "vessel-caller",
    }
}

FRONTEND_URL = env("VC_FRONTEND_URL", "http://localhost:5173").rstrip("/")
EMAIL_FROM = env("VC_EMAIL_FROM", "Vessel Caller <noreply@vesselcalls.com>")
RESEND_API_KEY = env("VC_RESEND_API_KEY")
EMAIL_DELIVERY_BACKEND = env("VC_EMAIL_DELIVERY_BACKEND", "console")
MFA_ENCRYPTION_KEY = env("VC_MFA_ENCRYPTION_KEY", "")
SESSION_ABSOLUTE_AGE = 60 * 60 * 24 * 30
MFA_GRACE_DAYS = 7
RELEASE_SHA = env("VC_RELEASE_SHA", "development")
RELEASE_TAG = env("VC_RELEASE_TAG", "")
SENTRY_DSN = env("VC_SENTRY_DSN")
SYSTEM_ADMIN_MUTATIONS_ENABLED = env_bool(
    "VC_SYSTEM_ADMIN_MUTATIONS_ENABLED",
    ENVIRONMENT != "production",
)
SYSTEM_ADMIN_MUTATION_FLAG_FILE = env("VC_SYSTEM_ADMIN_MUTATION_FLAG_FILE", "")
SYSTEM_ADMIN_MFA_STEP_UP_SECONDS = int(env("VC_SYSTEM_ADMIN_MFA_STEP_UP_SECONDS", "900"))

CELERY_BROKER_URL = env("VC_REDIS_URL", "redis://127.0.0.1:6379/0")
CELERY_RESULT_BACKEND = env("VC_REDIS_URL", "redis://127.0.0.1:6379/1")
CELERY_TASK_ALWAYS_EAGER = env_bool("VC_CELERY_EAGER", False)
CELERY_TASK_EAGER_PROPAGATES = True
CELERY_BROKER_CONNECTION_RETRY_ON_STARTUP = True
CELERY_TASK_ACKS_LATE = True
CELERY_WORKER_PREFETCH_MULTIPLIER = 1

LOGGING = {
    "version": 1,
    "disable_existing_loggers": False,
    "formatters": {
        "json": {"()": "vessel_caller.logging.JsonFormatter"},
    },
    "handlers": {
        "console": {"class": "logging.StreamHandler", "formatter": "json"},
    },
    "root": {"handlers": ["console"], "level": env("VC_LOG_LEVEL", "INFO")},
}
