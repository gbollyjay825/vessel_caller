from django.test import override_settings
from rest_framework.test import APIClient


@override_settings(
    SENTRY_DSN="https://public@example.ingest.sentry.io/123",
    ENVIRONMENT="staging",
    RELEASE_TAG="v1.2.3",
    RELEASE_SHA="0123456789abcdef0123456789abcdef01234567",
)
def test_runtime_config_is_public_and_prefers_release_tag():
    response = APIClient().get("/api/runtime-config")

    assert response.status_code == 200
    assert response["Cache-Control"] == "no-store"
    assert response.json() == {
        "sentry": {
            "dsn": "https://public@example.ingest.sentry.io/123",
            "environment": "staging",
            "release": "v1.2.3",
        }
    }


@override_settings(
    SENTRY_DSN="",
    ENVIRONMENT="development",
    RELEASE_TAG="",
    RELEASE_SHA="development",
)
def test_runtime_config_represents_disabled_sentry_without_exposing_other_settings():
    response = APIClient().get("/api/runtime-config")

    assert response.status_code == 200
    assert response.json() == {
        "sentry": {
            "dsn": "",
            "environment": "development",
            "release": "development",
        }
    }
    assert APIClient().get("/api/runtime-config/").status_code == 404


@override_settings(
    SENTRY_DSN="https://public@example.ingest.sentry.io/123",
    ENVIRONMENT="production",
    RELEASE_TAG="",
    RELEASE_SHA="fedcba9876543210fedcba9876543210fedcba98",
)
def test_runtime_config_falls_back_to_release_sha():
    response = APIClient().get("/api/runtime-config")

    assert response.status_code == 200
    assert response.json()["sentry"]["release"] == "fedcba9876543210fedcba9876543210fedcba98"
