from __future__ import annotations

import threading
import time
from collections.abc import Callable
from typing import Any
from unittest.mock import patch

import pyotp
import pytest
from django.conf import settings
from django.contrib.sessions.middleware import SessionMiddleware
from django.contrib.sessions.models import Session
from django.core.cache import cache
from django.core.management import call_command
from django.db import close_old_connections, connection, transaction
from django.utils import timezone
from rest_framework.test import APIClient

from accounts.models import PlatformAccessGrant, PlatformMutationRequest, User, UserSession
from accounts.security import encrypt_secret
from audit.models import PlatformAuditEvent
from organizations.models import Organization, OrganizationSettings
from organizations.services import reactivate_customer_organization, suspend_customer_organization


pytestmark = pytest.mark.django_db(transaction=True)

MFA_SECRET = "JBSWY3DPEHPK3PXP"
SYSTEM_PASSWORD = "A-strong-system-password-2026!"


def _require_postgresql() -> None:
    if connection.vendor != "postgresql":
        pytest.skip("Deterministic lifecycle lock races require PostgreSQL")


def _backend_pid() -> int:
    connection.ensure_connection()
    raw = connection.connection
    assert raw is not None
    info = getattr(raw, "info", None)
    if info is not None:
        return int(info.backend_pid)
    return int(raw.get_backend_pid())


def _wait_for_database_lock(pid: int, *, timeout: float = 8.0) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        with connection.cursor() as cursor:
            cursor.execute(
                "SELECT wait_event_type FROM pg_stat_activity WHERE pid = %s",
                [pid],
            )
            row = cursor.fetchone()
        if row and row[0] == "Lock":
            return
        time.sleep(0.01)
    raise AssertionError(f"Backend {pid} never entered a PostgreSQL lock wait")


def _join(thread: threading.Thread, outcomes: dict[str, Any], *, timeout: float = 10.0) -> None:
    thread.join(timeout=timeout)
    assert not thread.is_alive()
    errors = {key: value for key, value in outcomes.items() if key.endswith("_error")}
    assert errors == {}


def _thread_call(
    *,
    key: str,
    outcomes: dict[str, Any],
    started: threading.Event,
    callback: Callable[[], object],
) -> None:
    close_old_connections()
    try:
        outcomes[f"{key}_pid"] = _backend_pid()
        started.set()
        outcomes[key] = callback()
    except BaseException as exc:  # pragma: no cover - asserted by the parent thread
        outcomes[f"{key}_error"] = exc
    finally:
        close_old_connections()


@pytest.fixture
def platform_operators():
    organization = Organization.objects.create(
        kind=Organization.Kind.PLATFORM,
        name="Vessel Caller Platform Administration",
        email="platform-races@vesselcalls.test",
        registered=True,
    )
    OrganizationSettings.objects.create(organization=organization)
    users = []
    for index in range(2):
        user = User.objects.create_user(
            email=f"platform-race-{index}@vesselcalls.test",
            password=SYSTEM_PASSWORD,
            organization=organization,
            name=f"Platform Race {index}",
            role=User.Role.VIEWER,
            status=User.Status.ACTIVE,
            email_verified_at=timezone.now(),
            mfa_secret=encrypt_secret(MFA_SECRET),
            mfa_enabled_at=timezone.now(),
            mfa_grace_ends_at=timezone.now(),
        )
        PlatformAccessGrant.objects.create(
            user=user,
            role=PlatformAccessGrant.Role.SYSTEM_ADMIN,
            reason="PostgreSQL lifecycle race test",
        )
        users.append(user)
    return users[0], users[1]


def _force_client(user: User) -> APIClient:
    client = APIClient()
    client.force_authenticate(user=user)
    return client


def _system_client(user: User) -> APIClient:
    client = _force_client(user)
    session = client.session
    session["mfa_verified_at"] = timezone.now().timestamp()
    session.save()
    return client


def _suspend(organization_id: str, actor_id: str) -> None:
    with transaction.atomic():
        organization = Organization.objects.select_for_update().get(pk=organization_id)
        actor = User.objects.select_related("organization").get(pk=actor_id)
        suspend_customer_organization(
            organization=organization,
            actor=actor,
            reason="Deterministic PostgreSQL race test",
        )


def _reactivate(organization_id: str, actor_id: str) -> None:
    with transaction.atomic():
        organization = Organization.objects.select_for_update().get(pk=organization_id)
        actor = User.objects.select_related("organization").get(pk=actor_id)
        reactivate_customer_organization(
            organization=organization,
            actor=actor,
            reason="Continue deterministic PostgreSQL race test",
        )


def test_suspend_and_customer_mutation_are_linearized_in_both_orders(admin, platform_operators):
    _require_postgresql()
    operator, _replacement = platform_operators
    organization_id = admin.organization_id
    settings_id = admin.organization.settings.pk
    initial_rate = OrganizationSettings.objects.get(pk=settings_id).commission_rate

    suspend_ready = threading.Event()
    release_suspend = threading.Event()
    mutation_started = threading.Event()
    outcomes: dict[str, Any] = {}

    def hold_suspension():
        with transaction.atomic():
            organization = Organization.objects.select_for_update().get(pk=organization_id)
            actor = User.objects.get(pk=operator.pk)
            suspend_customer_organization(
                organization=organization,
                actor=actor,
                reason="Suspension wins",
            )
            suspend_ready.set()
            assert release_suspend.wait(timeout=8)

    suspend_thread = threading.Thread(
        target=lambda: _thread_call(
            key="suspend_first",
            outcomes=outcomes,
            started=threading.Event(),
            callback=hold_suspension,
        )
    )
    suspend_thread.start()
    assert suspend_ready.wait(timeout=8)

    def mutate_settings():
        actor = User.objects.select_related("organization").get(pk=admin.pk)
        return (
            _force_client(actor)
            .put(
                "/api/settings",
                {"commissionRate": "4.2500"},
                format="json",
            )
            .status_code
        )

    mutation_thread = threading.Thread(
        target=lambda: _thread_call(
            key="mutation_after_suspend",
            outcomes=outcomes,
            started=mutation_started,
            callback=mutate_settings,
        )
    )
    mutation_thread.start()
    assert mutation_started.wait(timeout=8)
    _wait_for_database_lock(int(outcomes["mutation_after_suspend_pid"]))
    release_suspend.set()
    _join(suspend_thread, outcomes)
    _join(mutation_thread, outcomes)
    assert outcomes["mutation_after_suspend"] == 403
    settings_obj = OrganizationSettings.objects.get(pk=settings_id)
    assert settings_obj.commission_rate == initial_rate

    _reactivate(organization_id, operator.pk)
    mutation_paused = threading.Event()
    release_mutation = threading.Event()
    suspension_started = threading.Event()
    outcomes = {}

    from api import operation_views

    original_record_event = operation_views.record_event

    def pause_settings_event(*args, **kwargs):
        if kwargs.get("action") == "settings.updated":
            mutation_paused.set()
            assert release_mutation.wait(timeout=8)
        return original_record_event(*args, **kwargs)

    with patch("api.operation_views.record_event", side_effect=pause_settings_event):
        mutation_thread = threading.Thread(
            target=lambda: _thread_call(
                key="mutation_first",
                outcomes=outcomes,
                started=threading.Event(),
                callback=mutate_settings,
            )
        )
        mutation_thread.start()
        assert mutation_paused.wait(timeout=8)
        suspend_thread = threading.Thread(
            target=lambda: _thread_call(
                key="suspend_after_mutation",
                outcomes=outcomes,
                started=suspension_started,
                callback=lambda: _suspend(organization_id, operator.pk),
            )
        )
        suspend_thread.start()
        assert suspension_started.wait(timeout=8)
        _wait_for_database_lock(int(outcomes["suspend_after_mutation_pid"]))
        release_mutation.set()
        _join(mutation_thread, outcomes)
        _join(suspend_thread, outcomes)

    assert outcomes["mutation_first"] == 200
    settings_obj.refresh_from_db()
    assert settings_obj.commission_rate == 4.25
    assert Organization.objects.get(pk=organization_id).access_status == "suspended"


def test_suspend_and_signed_capability_are_linearized_in_both_orders(admin, platform_operators):
    _require_postgresql()
    operator, _replacement = platform_operators
    organization = admin.organization
    organization.logo_object_key = f"organizations/{organization.id}/logos/private.png"
    organization.save(update_fields=("logo_object_key", "updated_at"))

    suspend_ready = threading.Event()
    release_suspend = threading.Event()
    capability_started = threading.Event()
    outcomes: dict[str, Any] = {}

    def hold_suspension():
        with transaction.atomic():
            locked = Organization.objects.select_for_update().get(pk=organization.pk)
            actor = User.objects.get(pk=operator.pk)
            suspend_customer_organization(
                organization=locked,
                actor=actor,
                reason="Suspension wins capability race",
            )
            suspend_ready.set()
            assert release_suspend.wait(timeout=8)

    suspension = threading.Thread(
        target=lambda: _thread_call(
            key="capability_suspend_first",
            outcomes=outcomes,
            started=threading.Event(),
            callback=hold_suspension,
        )
    )
    suspension.start()
    assert suspend_ready.wait(timeout=8)

    def get_logo():
        actor = User.objects.select_related("organization").get(pk=admin.pk)
        return _force_client(actor).get("/api/organization/logo")

    capability = threading.Thread(
        target=lambda: _thread_call(
            key="capability_after_suspend",
            outcomes=outcomes,
            started=capability_started,
            callback=get_logo,
        )
    )
    capability.start()
    assert capability_started.wait(timeout=8)
    _wait_for_database_lock(int(outcomes["capability_after_suspend_pid"]))
    release_suspend.set()
    _join(suspension, outcomes)
    _join(capability, outcomes)
    response = outcomes["capability_after_suspend"]
    assert response.status_code == 403

    _reactivate(organization.id, operator.pk)
    capability_paused = threading.Event()
    release_capability = threading.Event()
    suspension_started = threading.Event()
    outcomes = {}

    def pause_presign(_request, *, key):
        assert key == organization.logo_object_key
        capability_paused.set()
        assert release_capability.wait(timeout=8)
        return "https://private.invalid/signed-before-suspension"

    with patch("api.operation_views.presign_download", side_effect=pause_presign):
        capability = threading.Thread(
            target=lambda: _thread_call(
                key="capability_first",
                outcomes=outcomes,
                started=threading.Event(),
                callback=get_logo,
            )
        )
        capability.start()
        assert capability_paused.wait(timeout=8)
        suspension = threading.Thread(
            target=lambda: _thread_call(
                key="suspend_after_capability",
                outcomes=outcomes,
                started=suspension_started,
                callback=lambda: _suspend(organization.id, operator.pk),
            )
        )
        suspension.start()
        assert suspension_started.wait(timeout=8)
        _wait_for_database_lock(int(outcomes["suspend_after_capability_pid"]))
        release_capability.set()
        _join(capability, outcomes)
        _join(suspension, outcomes)

    response = outcomes["capability_first"]
    assert response.status_code == 200
    assert response.json()["downloadUrl"].endswith("signed-before-suspension")
    assert Organization.objects.get(pk=organization.id).access_status == "suspended"


def test_mfa_final_session_persist_and_suspension_are_linearized(admin, platform_operators):
    _require_postgresql()
    cache.clear()
    operator, _replacement = platform_operators
    admin.mfa_secret = encrypt_secret(MFA_SECRET)
    admin.mfa_enabled_at = timezone.now()
    admin.save(update_fields=("mfa_secret", "mfa_enabled_at", "updated_at"))
    client = APIClient()
    login = client.post(
        "/api/auth/login",
        {"email": admin.email, "password": "A-strong-admin-password-2026!"},
        format="json",
    )
    assert login.status_code == 202

    persist_paused = threading.Event()
    release_persist = threading.Event()
    suspend_started = threading.Event()
    outcomes: dict[str, Any] = {}
    from api import auth_views

    original_persist = auth_views.persist_session

    def pause_final_persist(request):
        original_persist(request)
        persist_paused.set()
        assert release_persist.wait(timeout=8)

    def verify_mfa():
        return client.post(
            "/api/auth/mfa/verify",
            {
                "challengeId": login.json()["challengeId"],
                "code": pyotp.TOTP(MFA_SECRET).now(),
            },
            format="json",
        )

    with patch("api.auth_views.persist_session", side_effect=pause_final_persist):
        verify = threading.Thread(
            target=lambda: _thread_call(
                key="mfa_verify",
                outcomes=outcomes,
                started=threading.Event(),
                callback=verify_mfa,
            )
        )
        verify.start()
        assert persist_paused.wait(timeout=8)
        suspension = threading.Thread(
            target=lambda: _thread_call(
                key="suspend_after_mfa_persist",
                outcomes=outcomes,
                started=suspend_started,
                callback=lambda: _suspend(admin.organization_id, operator.pk),
            )
        )
        suspension.start()
        assert suspend_started.wait(timeout=8)
        _wait_for_database_lock(int(outcomes["suspend_after_mfa_persist_pid"]))
        release_persist.set()
        _join(verify, outcomes)
        _join(suspension, outcomes)

    assert outcomes["mfa_verify"].status_code == 200
    assert not UserSession.objects.filter(user=admin, revoked_at__isnull=True).exists()
    assert not Session.objects.filter(
        session_key__in=UserSession.objects.filter(user=admin).values("session_key")
    ).exists()
    _reactivate(admin.organization_id, operator.pk)
    assert client.get("/api/auth/me").status_code in {401, 403}


def test_suspend_first_blocks_new_login_and_mfa_verification(admin, platform_operators):
    _require_postgresql()
    cache.clear()
    operator, _replacement = platform_operators
    admin.mfa_secret = encrypt_secret(MFA_SECRET)
    admin.mfa_enabled_at = timezone.now()
    admin.save(update_fields=("mfa_secret", "mfa_enabled_at", "updated_at"))
    login_client = APIClient()
    challenge = login_client.post(
        "/api/auth/login",
        {"email": admin.email, "password": "A-strong-admin-password-2026!"},
        format="json",
    )
    assert challenge.status_code == 202

    suspend_ready = threading.Event()
    release_suspend = threading.Event()
    login_started = threading.Event()
    verify_started = threading.Event()
    outcomes: dict[str, Any] = {}

    def hold_suspension():
        with transaction.atomic():
            organization = Organization.objects.select_for_update().get(pk=admin.organization_id)
            actor = User.objects.get(pk=operator.pk)
            suspend_customer_organization(
                organization=organization,
                actor=actor,
                reason="Suspension wins login and MFA race",
            )
            suspend_ready.set()
            assert release_suspend.wait(timeout=8)

    suspension = threading.Thread(
        target=lambda: _thread_call(
            key="suspend_first",
            outcomes=outcomes,
            started=threading.Event(),
            callback=hold_suspension,
        )
    )
    suspension.start()
    assert suspend_ready.wait(timeout=8)

    second_login_client = APIClient()
    login_thread = threading.Thread(
        target=lambda: _thread_call(
            key="login_after_suspend",
            outcomes=outcomes,
            started=login_started,
            callback=lambda: second_login_client.post(
                "/api/auth/login",
                {"email": admin.email, "password": "A-strong-admin-password-2026!"},
                format="json",
            ),
        )
    )
    verify_thread = threading.Thread(
        target=lambda: _thread_call(
            key="verify_after_suspend",
            outcomes=outcomes,
            started=verify_started,
            callback=lambda: login_client.post(
                "/api/auth/mfa/verify",
                {
                    "challengeId": challenge.json()["challengeId"],
                    "code": pyotp.TOTP(MFA_SECRET).now(),
                },
                format="json",
            ),
        )
    )
    login_thread.start()
    verify_thread.start()
    assert login_started.wait(timeout=8)
    assert verify_started.wait(timeout=8)
    _wait_for_database_lock(int(outcomes["login_after_suspend_pid"]))
    _wait_for_database_lock(int(outcomes["verify_after_suspend_pid"]))
    release_suspend.set()
    _join(suspension, outcomes)
    _join(login_thread, outcomes)
    _join(verify_thread, outcomes)

    assert outcomes["login_after_suspend"].status_code == 401
    assert outcomes["verify_after_suspend"].status_code == 401
    assert not UserSession.objects.filter(user=admin, revoked_at__isnull=True).exists()
    assert not admin.mfa_challenges.filter(used_at__isnull=True).exists()


def test_response_cycle_cannot_resurrect_session_after_suspend_and_reactivate(
    admin, platform_operators
):
    _require_postgresql()
    operator, _replacement = platform_operators
    client = APIClient()
    assert (
        client.post(
            "/api/auth/login",
            {"email": admin.email, "password": "A-strong-admin-password-2026!"},
            format="json",
        ).status_code
        == 200
    )

    response_cycle_paused = threading.Event()
    release_response_cycle = threading.Event()
    outcomes: dict[str, Any] = {}
    original_process_response = SessionMiddleware.process_response

    def pause_session_response(middleware, request, response):
        if request.path == "/api/auth/change-password":
            response_cycle_paused.set()
            assert release_response_cycle.wait(timeout=8)
        return original_process_response(middleware, request, response)

    def change_password():
        return client.post(
            "/api/auth/change-password",
            {
                "currentPassword": "A-strong-admin-password-2026!",
                "password": "A-new-race-safe-password-2026!",
            },
            format="json",
        )

    with patch.object(SessionMiddleware, "process_response", new=pause_session_response):
        response_thread = threading.Thread(
            target=lambda: _thread_call(
                key="response_cycle",
                outcomes=outcomes,
                started=threading.Event(),
                callback=change_password,
            )
        )
        response_thread.start()
        assert response_cycle_paused.wait(timeout=8)
        _suspend(admin.organization_id, operator.pk)
        _reactivate(admin.organization_id, operator.pk)
        release_response_cycle.set()
        _join(response_thread, outcomes)

    assert outcomes["response_cycle"].status_code == 200
    assert not UserSession.objects.filter(user=admin, revoked_at__isnull=True).exists()
    assert not Session.objects.filter(
        session_key__in=UserSession.objects.filter(user=admin).values("session_key")
    ).exists()
    assert client.get("/api/auth/me").status_code in {401, 403}


@pytest.mark.parametrize("revoke_first", [True, False], ids=("revoke-first", "step-up-first"))
def test_platform_grant_revoke_and_step_up_are_linearized(platform_operators, revoke_first):
    _require_postgresql()
    cache.clear()
    target, replacement = platform_operators
    client = _system_client(target)
    outcomes: dict[str, Any] = {}
    revoke_paused = threading.Event()
    release_revoke = threading.Event()
    step_up_paused = threading.Event()
    release_step_up = threading.Event()
    revoke_started = threading.Event()
    step_up_started = threading.Event()

    from accounts.management.commands import revoke_system_admin
    from api import system_admin_views

    original_record = revoke_system_admin.record_platform_event
    original_verify = system_admin_views.verify_totp

    def pause_revoke_event(*args, **kwargs):
        revoke_paused.set()
        assert release_revoke.wait(timeout=8)
        return original_record(*args, **kwargs)

    def pause_step_up_verify(user, code):
        step_up_paused.set()
        assert release_step_up.wait(timeout=8)
        return original_verify(user, code)

    def revoke():
        call_command(
            "revoke_system_admin",
            email=target.email,
            reason="Deterministic platform race test",
            change_id=f"CHG-RACE-{'R' if revoke_first else 'S'}",
            actor_email=replacement.email,
            environment=settings.ENVIRONMENT,
            confirm=True,
            verbosity=0,
        )

    def step_up():
        return client.post(
            "/api/system/step-up",
            {"code": pyotp.TOTP(MFA_SECRET).now()},
            format="json",
        )

    if revoke_first:
        with patch(
            "accounts.management.commands.revoke_system_admin.record_platform_event",
            side_effect=pause_revoke_event,
        ):
            revoke_thread = threading.Thread(
                target=lambda: _thread_call(
                    key="revoke",
                    outcomes=outcomes,
                    started=revoke_started,
                    callback=revoke,
                )
            )
            revoke_thread.start()
            assert revoke_paused.wait(timeout=8)
            step_thread = threading.Thread(
                target=lambda: _thread_call(
                    key="step_up",
                    outcomes=outcomes,
                    started=step_up_started,
                    callback=step_up,
                )
            )
            step_thread.start()
            assert step_up_started.wait(timeout=8)
            _wait_for_database_lock(int(outcomes["step_up_pid"]))
            release_revoke.set()
            _join(revoke_thread, outcomes)
            _join(step_thread, outcomes)
        assert outcomes["step_up"].status_code == 403
    else:
        with patch("api.system_admin_views.verify_totp", side_effect=pause_step_up_verify):
            step_thread = threading.Thread(
                target=lambda: _thread_call(
                    key="step_up",
                    outcomes=outcomes,
                    started=step_up_started,
                    callback=step_up,
                )
            )
            step_thread.start()
            assert step_up_paused.wait(timeout=8)
            revoke_thread = threading.Thread(
                target=lambda: _thread_call(
                    key="revoke",
                    outcomes=outcomes,
                    started=revoke_started,
                    callback=revoke,
                )
            )
            revoke_thread.start()
            assert revoke_started.wait(timeout=8)
            _wait_for_database_lock(int(outcomes["revoke_pid"]))
            release_step_up.set()
            _join(step_thread, outcomes)
            _join(revoke_thread, outcomes)
        assert outcomes["step_up"].status_code == 200

    target.refresh_from_db()
    grant = target.platform_access_grants.get(role=PlatformAccessGrant.Role.SYSTEM_ADMIN)
    assert target.status == User.Status.SUSPENDED
    assert grant.revoked_at is not None
    assert PlatformAuditEvent.objects.filter(action="platform.system_admin.revoked").count() == 1


@pytest.mark.parametrize("revoke_first", [True, False], ids=("revoke-first", "mutation-first"))
def test_platform_grant_revoke_and_idempotent_mutation_are_linearized(
    organization, platform_operators, revoke_first
):
    _require_postgresql()
    target, replacement = platform_operators
    client = _system_client(target)
    outcomes: dict[str, Any] = {}
    revoke_paused = threading.Event()
    release_revoke = threading.Event()
    mutation_paused = threading.Event()
    release_mutation = threading.Event()
    revoke_started = threading.Event()
    mutation_started = threading.Event()
    idempotency_key = f"platform-race-{'revoke' if revoke_first else 'mutation'}"

    from accounts.management.commands import revoke_system_admin
    from api import system_admin_views

    original_revoke_record = revoke_system_admin.record_platform_event
    original_system_record = system_admin_views.record_system_action

    def pause_revoke_event(*args, **kwargs):
        revoke_paused.set()
        assert release_revoke.wait(timeout=8)
        return original_revoke_record(*args, **kwargs)

    def pause_system_record(*args, **kwargs):
        if kwargs.get("action") == "platform.organization.updated":
            mutation_paused.set()
            assert release_mutation.wait(timeout=8)
        return original_system_record(*args, **kwargs)

    def revoke():
        call_command(
            "revoke_system_admin",
            email=target.email,
            reason="Deterministic mutation race test",
            change_id=f"CHG-MUT-{'R' if revoke_first else 'M'}",
            actor_email=replacement.email,
            environment=settings.ENVIRONMENT,
            confirm=True,
            verbosity=0,
        )

    def mutate():
        current = Organization.objects.get(pk=organization.pk)
        return client.patch(
            f"/api/system/organizations/{organization.pk}",
            {"name": "Race-safe renamed organization", "revision": current.revision},
            format="json",
            HTTP_IDEMPOTENCY_KEY=idempotency_key,
        )

    if revoke_first:
        with patch(
            "accounts.management.commands.revoke_system_admin.record_platform_event",
            side_effect=pause_revoke_event,
        ):
            revoke_thread = threading.Thread(
                target=lambda: _thread_call(
                    key="revoke",
                    outcomes=outcomes,
                    started=revoke_started,
                    callback=revoke,
                )
            )
            revoke_thread.start()
            assert revoke_paused.wait(timeout=8)
            mutation_thread = threading.Thread(
                target=lambda: _thread_call(
                    key="mutation",
                    outcomes=outcomes,
                    started=mutation_started,
                    callback=mutate,
                )
            )
            mutation_thread.start()
            assert mutation_started.wait(timeout=8)
            _wait_for_database_lock(int(outcomes["mutation_pid"]))
            release_revoke.set()
            _join(revoke_thread, outcomes)
            _join(mutation_thread, outcomes)
        assert outcomes["mutation"].status_code == 403
        organization.refresh_from_db()
        assert organization.name != "Race-safe renamed organization"
        assert not PlatformMutationRequest.objects.filter(key=idempotency_key).exists()
    else:
        with patch("api.system_admin_views.record_system_action", side_effect=pause_system_record):
            mutation_thread = threading.Thread(
                target=lambda: _thread_call(
                    key="mutation",
                    outcomes=outcomes,
                    started=mutation_started,
                    callback=mutate,
                )
            )
            mutation_thread.start()
            assert mutation_paused.wait(timeout=8)
            revoke_thread = threading.Thread(
                target=lambda: _thread_call(
                    key="revoke",
                    outcomes=outcomes,
                    started=revoke_started,
                    callback=revoke,
                )
            )
            revoke_thread.start()
            assert revoke_started.wait(timeout=8)
            _wait_for_database_lock(int(outcomes["revoke_pid"]))
            release_mutation.set()
            _join(mutation_thread, outcomes)
            _join(revoke_thread, outcomes)
        assert outcomes["mutation"].status_code == 200
        organization.refresh_from_db()
        assert organization.name == "Race-safe renamed organization"
        mutation = PlatformMutationRequest.objects.get(key=idempotency_key)
        assert mutation.status == PlatformMutationRequest.Status.COMPLETED
