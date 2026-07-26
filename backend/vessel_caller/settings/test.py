from .base import *  # noqa: F403

if env("VC_TEST_DATABASE_URL"):  # noqa: F405
    DATABASES = {"default": database_from_url(env("VC_TEST_DATABASE_URL"))}  # noqa: F405
    DATABASES["default"]["TEST"] = {"NAME": DATABASES["default"]["NAME"]}

DEBUG = False
SECRET_KEY = "test-only-secret-key"  # nosec B105
SESSION_COOKIE_SECURE = False
SESSION_COOKIE_NAME = "vessel_test_session"
CSRF_COOKIE_SECURE = False
PASSWORD_HASHERS = ["django.contrib.auth.hashers.MD5PasswordHasher"]
EMAIL_DELIVERY_BACKEND = "memory"
CELERY_TASK_ALWAYS_EAGER = True
CELERY_TASK_EAGER_PROPAGATES = True
STORAGES = {
    "default": {"BACKEND": "django.core.files.storage.InMemoryStorage"},
    "staticfiles": {"BACKEND": "django.contrib.staticfiles.storage.StaticFilesStorage"},
}
