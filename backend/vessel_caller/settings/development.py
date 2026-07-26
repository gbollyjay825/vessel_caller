from .base import *  # noqa: F403

DEBUG = env_bool("VC_DEBUG", True)  # noqa: F405
SESSION_COOKIE_SECURE = env_bool("VC_SESSION_COOKIE_SECURE", False)  # noqa: F405
SESSION_COOKIE_NAME = "vessel_session"
CSRF_COOKIE_SECURE = SESSION_COOKIE_SECURE
EMAIL_DELIVERY_BACKEND = env("VC_EMAIL_DELIVERY_BACKEND", "console")  # noqa: F405
CELERY_TASK_ALWAYS_EAGER = env_bool("VC_CELERY_EAGER", True)  # noqa: F405
