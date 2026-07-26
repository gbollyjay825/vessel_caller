from __future__ import annotations

from django.core.cache import cache
from django.conf import settings
from django.db import connection
from rest_framework import status
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.views import APIView

from vessel_caller import __version__


class HealthView(APIView):
    authentication_classes = []
    permission_classes = [AllowAny]

    def get(self, request):
        return Response(
            {
                "status": "ok",
                "version": __version__,
                "release": {
                    "sha": settings.RELEASE_SHA,
                    "tag": settings.RELEASE_TAG or None,
                },
            }
        )


class ReadinessView(APIView):
    authentication_classes = []
    permission_classes = [AllowAny]

    def get(self, request):
        checks = {}
        try:
            with connection.cursor() as cursor:
                cursor.execute("SELECT 1")
                checks["database"] = cursor.fetchone()[0] == 1
        except Exception:
            checks["database"] = False
        try:
            cache.set("readiness", "ok", timeout=10)
            checks["cache"] = cache.get("readiness") == "ok"
        except Exception:
            checks["cache"] = False
        ready = all(checks.values())
        return Response(
            {
                "status": "ready" if ready else "not-ready",
                "checks": checks,
                "release": {
                    "sha": settings.RELEASE_SHA,
                    "tag": settings.RELEASE_TAG or None,
                },
            },
            status=status.HTTP_200_OK if ready else status.HTTP_503_SERVICE_UNAVAILABLE,
        )
