from __future__ import annotations

import hashlib
import hmac
from datetime import timedelta

import pyotp
from django.conf import settings
from django.contrib.auth import authenticate
from django.core.cache import cache
from django.db import transaction
from django.middleware.csrf import get_token
from django.utils import timezone
from django.utils.crypto import salted_hmac
from django.utils.decorators import method_decorator
from django.views.decorators.csrf import csrf_protect, ensure_csrf_cookie
from rest_framework import status
from rest_framework.exceptions import APIException, ValidationError
from rest_framework.permissions import AllowAny
from rest_framework.response import Response

from accounts.models import ActionToken, MFAChallenge, User
from accounts.notifications import queue_security_notice
from accounts.platform_access import platform_access_data
from accounts.security import (
    consume_action_token,
    decrypt_secret,
    EMPTY_MFA_SECRET,
    encrypt_secret,
    generate_recovery_codes,
    InactiveActionTarget,
    issue_action_token,
    use_recovery_code,
    verify_totp,
)
from accounts.services import (
    MFA_FAILURE_LIMIT,
    InactiveAccountError,
    clear_mfa_failures,
    end_current_session,
    lock_active_account,
    persist_session,
    queue_email,
    record_mfa_failure,
    revoke_sessions,
    rotate_current_session,
    start_mfa_challenge,
    start_session,
)
from audit.services import client_ip, record_event, record_identity_event
from organizations.defaults import CALABAR_BERTH_TERMINALS
from organizations.models import Organization, OrganizationSettings

from .permissions import RecentSystemMFARequired, effective_permissions
from .serializers import (
    ChangePasswordSerializer,
    ForgotPasswordSerializer,
    LoginSerializer,
    ProfilePatchSerializer,
    RegisterSerializer,
    ResetPasswordSerializer,
    TokenSerializer,
    organization_data,
    user_data,
)
from .tenant_lifecycle import TenantLifecycleAPIView as APIView


def session_payload(user: User, *, request=None) -> dict:
    customer_identity = user.organization.kind == Organization.Kind.CUSTOMER
    members = (
        user.organization.users.order_by("created_at")
        if customer_identity and user.role == User.Role.ADMIN
        else None
    )
    return {
        "user": user_data(user),
        "org": (
            organization_data(user.organization, members=members) if customer_identity else None
        ),
        "permissions": effective_permissions(user),
        "platformAccess": platform_access_data(user, request=request),
    }


def _url(path: str, token: str) -> str:
    return f"{settings.FRONTEND_URL}{path}?token={token}"


AUTH_RATE_WINDOW_SECONDS = 15 * 60


def _rate_key(scope: str, dimension: str, value: str) -> str:
    digest = hashlib.sha256(value.strip().lower().encode()).hexdigest()
    return f"auth:{scope}:{dimension}:{digest}"


def _throttle_key(email: str, request) -> str:
    """Compatibility helper for the combined peer/email bucket."""

    ip = client_ip(request) or ""
    return _rate_key("login", "pair", f"{email}:{ip}")


def _login_throttle_keys(email: str, request) -> tuple[str, str]:
    return (
        _rate_key("login", "account", email),
        _rate_key("login", "ip", client_ip(request) or "unknown"),
    )


def _increment_rate_key(key: str) -> int:
    if cache.add(key, 1, timeout=AUTH_RATE_WINDOW_SECONDS):
        return 1
    try:
        return int(cache.incr(key))
    except ValueError:
        cache.set(key, 1, timeout=AUTH_RATE_WINDOW_SECONDS)
        return 1


def _decrement_rate_key(key: str) -> None:
    try:
        remaining = int(cache.decr(key))
    except ValueError:
        cache.delete(key)
    else:
        if remaining <= 0:
            cache.delete(key)


def _consume_public_budget(
    scope: str,
    email: str,
    request,
    *,
    account_limit: int,
    ip_limit: int,
) -> bool:
    account_key = _rate_key(scope, "account", email)
    ip_key = _rate_key(scope, "ip", client_ip(request) or "unknown")
    account_count = _increment_rate_key(account_key)
    ip_count = _increment_rate_key(ip_key)
    return account_count <= account_limit and ip_count <= ip_limit


def _mfa_ip_key(request) -> str:
    return _rate_key("mfa", "ip", client_ip(request) or "unknown")


def _session_handle(session_key: str) -> str:
    return salted_hmac("vessel-caller.user-session.v1", session_key).hexdigest()


def _require_recent_platform_mfa(request, user: User) -> None:
    if user.organization.kind != Organization.Kind.PLATFORM:
        return
    verified_at = request.session.get("mfa_verified_at")
    age = (
        timezone.now().timestamp() - verified_at if isinstance(verified_at, (int, float)) else None
    )
    if age is None or not 0 <= age <= settings.SYSTEM_ADMIN_MFA_STEP_UP_SECONDS:
        raise RecentSystemMFARequired()


def _locked_request_user(user: User) -> User:
    try:
        return lock_active_account(user)
    except InactiveAccountError as exc:
        raise ValidationError("This account is not available") from exc


class Unauthorized(APIException):
    status_code = status.HTTP_401_UNAUTHORIZED
    default_detail = "Authentication failed"
    default_code = "authentication_failed"


class CsrfView(APIView):
    authentication_classes = []
    permission_classes = [AllowAny]

    @method_decorator(ensure_csrf_cookie)
    def get(self, request):
        return Response({"csrfToken": get_token(request)})


@method_decorator(csrf_protect, name="dispatch")
class RegisterView(APIView):
    authentication_classes = []
    permission_classes = [AllowAny]

    @transaction.atomic
    def post(self, request):
        response_data = {
            "detail": "If this address can be registered, verification instructions will be sent",
            "verificationRequired": True,
        }
        serializer = RegisterSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data
        email = data["email"].strip().lower()
        if not _consume_public_budget("register", email, request, account_limit=5, ip_limit=20):
            return Response(response_data, status=status.HTTP_202_ACCEPTED)
        if User.objects.filter(email=email).exists():
            # Keep the result indistinguishable from a first registration.
            # A fresh link is requested through the dedicated resend endpoint,
            # rather than turning registration into an email-spam oracle.
            return Response(response_data, status=status.HTTP_202_ACCEPTED)
        organization = Organization.objects.create(
            registered=False,
            name=data["orgName"].strip(),
            rc_number=data.get("rcNumber", "").strip(),
            email=email,
            phone=data.get("phone", "").strip(),
            address=data.get("address", "").strip(),
            primary_port=data["designatedPort"],
            ports=data.get("ports") or [data["designatedPort"]],
        )
        OrganizationSettings.objects.create(
            organization=organization,
            port_name=data["designatedPort"],
            terminals=list(CALABAR_BERTH_TERMINALS),
        )
        from billing.services import ensure_default_steps

        ensure_default_steps(organization)
        user = User.objects.create_user(
            email=email,
            password=data["password"],
            organization=organization,
            name=data["name"].strip(),
            role=User.Role.ADMIN,
            status=User.Status.INVITED,
            mfa_grace_ends_at=timezone.now() + timedelta(days=settings.MFA_GRACE_DAYS),
        )
        token_obj, raw = issue_action_token(user, ActionToken.Kind.VERIFY_EMAIL, hours=24)
        queue_email(
            to_email=email,
            subject="Verify your Vessel Caller account",
            template="verify_email",
            context={"actionUrl": _url("/verify-email", raw)},
            idempotency_key=f"verify:{token_obj.id}",
            organization=organization,
        )
        record_event(
            organization=organization,
            actor=user,
            action="account.registration_requested",
            category="identity",
            target=user,
            target_label=user.email,
            request=request,
            after={"email": email, "role": user.role},
        )
        return Response(response_data, status=status.HTTP_202_ACCEPTED)


@method_decorator(csrf_protect, name="dispatch")
class VerifyEmailView(APIView):
    authentication_classes = []
    permission_classes = [AllowAny]

    @transaction.atomic
    def post(self, request):
        serializer = TokenSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        token_obj = consume_action_token(
            serializer.validated_data["token"], ActionToken.Kind.VERIFY_EMAIL
        )
        if not token_obj:
            raise ValidationError({"token": ["This verification link is invalid or expired"]})
        user = (
            User.objects.select_for_update()
            .select_related("organization")
            .get(pk=token_obj.user_id)
        )
        now = timezone.now()
        if token_obj.metadata.get("pendingEmail"):
            pending = token_obj.metadata["pendingEmail"].lower()
            if User.objects.exclude(pk=user.pk).filter(email=pending).exists():
                raise ValidationError({"token": ["That email address is no longer available"]})
            before = {"email": user.email}
            previous_email = user.email
            user.email = pending
            user.pending_email = ""
            user.email_verified_at = now
            user.save(update_fields=("email", "pending_email", "email_verified_at", "updated_at"))
            action = "account.email_changed"
            queue_security_notice(
                user,
                event_key=f"email-changed:{token_obj.id}",
                subject="Your Vessel Caller email address was changed",
                message="Your Vessel Caller sign-in email address was changed successfully.",
                to_email=previous_email,
            )
        else:
            before = {"status": user.status}
            user.status = User.Status.ACTIVE
            user.email_verified_at = now
            user.organization.registered = True
            user.organization.save(update_fields=("registered", "updated_at"))
            user.save(update_fields=("status", "email_verified_at", "updated_at"))
            action = "account.email_verified"
            queue_security_notice(
                user,
                event_key=f"account-verified:{token_obj.id}",
                subject="Your Vessel Caller account is ready",
                message="Your email has been verified and your Vessel Caller account is now active.",
            )
        record_identity_event(
            organization=user.organization,
            actor=user,
            action=action,
            target=user,
            target_label=user.email,
            request=request,
            before=before,
            after={"email": user.email, "status": user.status},
        )
        return Response({"detail": "Email verified"})


@method_decorator(csrf_protect, name="dispatch")
class ResendVerificationView(APIView):
    authentication_classes = []
    permission_classes = [AllowAny]

    def post(self, request):
        serializer = ForgotPasswordSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        email = serializer.validated_data["email"].lower()
        if not _consume_public_budget(
            "resend-verification", email, request, account_limit=5, ip_limit=20
        ):
            return Response(
                {"detail": "If the account is pending, a new link has been sent"},
                status=status.HTTP_202_ACCEPTED,
            )
        user = User.objects.filter(
            email=email,
            email_verified_at__isnull=True,
            organization__access_status=Organization.AccessStatus.ACTIVE,
            is_staff=False,
            is_superuser=False,
        ).first()
        if user:
            try:
                token_obj, raw = issue_action_token(user, ActionToken.Kind.VERIFY_EMAIL, hours=24)
            except InactiveActionTarget:
                pass
            else:
                queue_email(
                    to_email=user.email,
                    subject="Verify your Vessel Caller account",
                    template="verify_email",
                    context={"actionUrl": _url("/verify-email", raw)},
                    idempotency_key=f"verify:{token_obj.id}",
                    organization=user.organization,
                )
        return Response(
            {"detail": "If the account is pending, a new link has been sent"},
            status=status.HTTP_202_ACCEPTED,
        )


@method_decorator(csrf_protect, name="dispatch")
class LoginView(APIView):
    authentication_classes = []
    permission_classes = [AllowAny]

    def post(self, request):
        serializer = LoginSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        email = serializer.validated_data["email"].lower()
        account_key, ip_key = _login_throttle_keys(email, request)
        account_attempt = _increment_rate_key(account_key)
        ip_attempt = _increment_rate_key(ip_key)
        if account_attempt > 8 or ip_attempt > 24:
            raise Unauthorized("Too many attempts. Try again later")
        user = authenticate(
            request,
            email=email,
            password=serializer.validated_data["password"],
        )
        if not user or user.is_staff or user.is_superuser or not user.email_verified_at:
            raise Unauthorized("Invalid email or password")
        _decrement_rate_key(account_key)
        _decrement_rate_key(ip_key)
        if user.mfa_enabled:
            try:
                challenge = start_mfa_challenge(user)
            except InactiveAccountError as exc:
                raise Unauthorized("Invalid email or password") from exc
            return Response(
                {"mfaRequired": True, "challengeId": challenge.id},
                status=status.HTTP_202_ACCEPTED,
            )
        try:
            start_session(request, user)
        except InactiveAccountError as exc:
            raise Unauthorized("Invalid email or password") from exc
        record_identity_event(
            organization=user.organization,
            actor=user,
            action="session.login",
            target=user,
            target_label=user.email,
            request=request,
        )
        return Response(session_payload(user, request=request))


@method_decorator(csrf_protect, name="dispatch")
class MFAVerifyView(APIView):
    authentication_classes = []
    permission_classes = [AllowAny]

    def post(self, request):
        challenge_id = request.data.get("challengeId", "")
        code = str(request.data.get("code", ""))
        mfa_ip_key = _mfa_ip_key(request)
        if _increment_rate_key(mfa_ip_key) > 24:
            raise Unauthorized("Too many attempts. Try again later")
        failure = ""
        user = None
        with transaction.atomic():
            candidate = (
                MFAChallenge.objects.filter(
                    pk=challenge_id,
                    used_at__isnull=True,
                )
                .values("user__organization_id")
                .first()
            )
            if not candidate:
                raise Unauthorized("Invalid or expired MFA challenge")
            organization = (
                Organization.objects.select_for_update()
                .filter(
                    pk=candidate["user__organization_id"],
                    access_status=Organization.AccessStatus.ACTIVE,
                )
                .first()
            )
            if not organization:
                raise Unauthorized("Invalid or expired MFA challenge")
            try:
                challenge = (
                    MFAChallenge.objects.select_for_update()
                    .select_related("user__organization")
                    .get(
                        pk=challenge_id,
                        used_at__isnull=True,
                        user__organization=organization,
                    )
                )
            except MFAChallenge.DoesNotExist as exc:
                raise Unauthorized("Invalid or expired MFA challenge") from exc
            if challenge.expires_at <= timezone.now() or challenge.attempts >= 5:
                raise Unauthorized("Invalid or expired MFA challenge")
            if record_mfa_failure(challenge.user_id) > MFA_FAILURE_LIMIT:
                raise Unauthorized("Invalid or expired MFA challenge")
            challenge.attempts += 1
            challenge.save(update_fields=("attempts",))
            user = challenge.user
            if not user.is_active:
                failure = "Invalid or expired MFA challenge"
            elif not (verify_totp(user, code) or use_recovery_code(user, code)):
                failure = "Invalid authentication code"
            else:
                challenge.used_at = timezone.now()
                challenge.save(update_fields=("used_at",))
                try:
                    start_session(request, user)
                except InactiveAccountError:
                    failure = "Invalid or expired MFA challenge"
                else:
                    request.session["mfa_verified_at"] = timezone.now().timestamp()
                    persist_session(request)
        if failure or user is None:
            raise Unauthorized(failure or "Invalid or expired MFA challenge")
        clear_mfa_failures(user.id)
        _decrement_rate_key(mfa_ip_key)
        record_identity_event(
            organization=user.organization,
            actor=user,
            action="session.login_mfa",
            target=user,
            target_label=user.email,
            request=request,
        )
        return Response(session_payload(user, request=request))


class MeView(APIView):
    def get(self, request):
        return Response(session_payload(request.user, request=request))


@method_decorator(csrf_protect, name="dispatch")
class LogoutView(APIView):
    def post(self, request):
        end_current_session(request)
        return Response(status=status.HTTP_204_NO_CONTENT)


@method_decorator(csrf_protect, name="dispatch")
class ForgotPasswordView(APIView):
    authentication_classes = []
    permission_classes = [AllowAny]

    def post(self, request):
        serializer = ForgotPasswordSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        email = serializer.validated_data["email"].lower()
        if not _consume_public_budget(
            "forgot-password", email, request, account_limit=5, ip_limit=20
        ):
            return Response(
                {"detail": "If the account exists, reset instructions have been sent"},
                status=status.HTTP_202_ACCEPTED,
            )
        user = User.objects.filter(
            email=email,
            status=User.Status.ACTIVE,
            organization__access_status=Organization.AccessStatus.ACTIVE,
            is_staff=False,
            is_superuser=False,
        ).first()
        if user:
            try:
                token_obj, raw = issue_action_token(user, ActionToken.Kind.RESET_PASSWORD, hours=1)
            except InactiveActionTarget:
                pass
            else:
                queue_email(
                    to_email=user.email,
                    subject="Reset your Vessel Caller password",
                    template="reset_password",
                    context={"actionUrl": _url("/reset-password", raw)},
                    idempotency_key=f"reset:{token_obj.id}",
                    organization=user.organization,
                )
        return Response(
            {"detail": "If the account exists, reset instructions have been sent"},
            status=status.HTTP_202_ACCEPTED,
        )


@method_decorator(csrf_protect, name="dispatch")
class ResetPasswordView(APIView):
    authentication_classes = []
    permission_classes = [AllowAny]

    @transaction.atomic
    def post(self, request):
        serializer = ResetPasswordSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        token_obj = consume_action_token(
            serializer.validated_data["token"], ActionToken.Kind.RESET_PASSWORD
        )
        if not token_obj:
            raise ValidationError({"token": ["This reset link is invalid or expired"]})
        user = (
            User.objects.select_for_update()
            .select_related("organization")
            .get(pk=token_obj.user_id)
        )
        platform_setup = bool(token_obj.metadata.get("platformSetup"))
        if platform_setup:
            from accounts.platform_access import active_platform_grant

            if (
                user.organization.kind != Organization.Kind.PLATFORM
                or user.is_staff
                or user.is_superuser
                or not active_platform_grant(user)
            ):
                raise ValidationError({"token": ["This reset link is invalid or expired"]})
        user.set_password(serializer.validated_data["password"])
        update_fields = ["password", "updated_at"]
        if platform_setup:
            user.status = User.Status.ACTIVE
            user.email_verified_at = timezone.now()
            user.mfa_grace_ends_at = timezone.now()
            update_fields.extend(("status", "email_verified_at", "mfa_grace_ends_at"))
        user.save(update_fields=tuple(update_fields))
        revoke_sessions(user)
        queue_security_notice(
            user,
            event_key=f"password-reset:{token_obj.id}",
            subject="Your Vessel Caller password was reset",
            message="Your password was reset and all active sessions were signed out.",
        )
        record_identity_event(
            organization=user.organization,
            actor=user,
            action="account.password_reset",
            target=user,
            target_label=user.email,
            request=request,
        )
        return Response({"detail": "Password reset"})


@method_decorator(csrf_protect, name="dispatch")
class ChangePasswordView(APIView):
    @transaction.atomic
    def post(self, request):
        serializer = ChangePasswordSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        user = _locked_request_user(request.user)
        _require_recent_platform_mfa(request, user)
        if not user.check_password(serializer.validated_data["currentPassword"]):
            raise ValidationError({"currentPassword": ["Current password is incorrect"]})
        user.set_password(serializer.validated_data["password"])
        user.save(update_fields=("password", "updated_at"))
        revoke_sessions(user, request=request, keep_current=True)
        rotate_current_session(request, user)
        queue_security_notice(
            user,
            event_key=f"password-changed:{user.id}:{user.updated_at.isoformat()}",
            subject="Your Vessel Caller password was changed",
            message="Your password was changed. Other active sessions were signed out.",
        )
        record_identity_event(
            organization=user.organization,
            actor=user,
            action="account.password_changed",
            target=user,
            target_label=user.email,
            request=request,
        )
        return Response({"detail": "Password changed"})


class ProfileView(APIView):
    def get(self, request):
        return Response({"user": user_data(request.user)})

    @transaction.atomic
    def put(self, request):
        serializer = ProfilePatchSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        _require_recent_platform_mfa(request, request.user)
        organization = (
            Organization.objects.select_for_update()
            .filter(
                pk=request.user.organization_id,
                access_status=Organization.AccessStatus.ACTIVE,
            )
            .first()
        )
        if not organization:
            raise ValidationError("This account is not available")
        user = User.objects.select_for_update().get(
            pk=request.user.pk,
            organization=organization,
        )
        before = user_data(user)
        verification_required = False
        if "name" in serializer.validated_data:
            user.name = serializer.validated_data["name"].strip()
        new_email = serializer.validated_data.get("email", "").lower()
        if new_email and new_email != user.email:
            if not user.check_password(serializer.validated_data.get("currentPassword", "")):
                raise ValidationError(
                    {"currentPassword": ["Current password is required to change your email"]}
                )
            if User.objects.exclude(pk=user.pk).filter(email=new_email).exists():
                raise ValidationError({"email": ["That email address is already in use"]})
            user.pending_email = new_email
            try:
                token_obj, raw = issue_action_token(
                    user,
                    ActionToken.Kind.VERIFY_EMAIL,
                    hours=24,
                    metadata={"pendingEmail": new_email},
                )
            except InactiveActionTarget as exc:
                raise ValidationError(
                    {"email": ["This account cannot request an email change"]}
                ) from exc
            queue_email(
                to_email=new_email,
                subject="Verify your new Vessel Caller email",
                template="verify_email",
                context={"actionUrl": _url("/verify-email", raw)},
                idempotency_key=f"verify:{token_obj.id}",
                organization=user.organization,
            )
            queue_security_notice(
                user,
                event_key=f"email-change-requested:{token_obj.id}",
                subject="A Vessel Caller email change was requested",
                message="A request was made to change your Vessel Caller sign-in email address. "
                "Your current email remains active until the new address is verified.",
            )
            verification_required = True
        user.save()
        record_identity_event(
            organization=user.organization,
            actor=user,
            action="account.profile_updated",
            target=user,
            target_label=user.email,
            request=request,
            before=before,
            after=user_data(user),
        )
        return Response({"user": user_data(user), "verificationRequired": verification_required})


class SessionListView(APIView):
    def get(self, request):
        current = request.session.session_key
        results = [
            {
                "id": _session_handle(item.session_key),
                "ipAddress": item.ip_address,
                "userAgent": item.user_agent,
                "createdAt": item.created_at.isoformat(),
                "lastSeenAt": item.last_seen_at.isoformat(),
                "expiresAt": item.absolute_expires_at.isoformat(),
                "current": item.session_key == current,
            }
            for item in request.user.sessions.filter(revoked_at__isnull=True)
        ]
        return Response({"results": results})


class SessionDetailView(APIView):
    def delete(self, request, session_id):
        session = next(
            (
                candidate
                for candidate in request.user.sessions.filter(revoked_at__isnull=True)
                if hmac.compare_digest(_session_handle(candidate.session_key), session_id)
            ),
            None,
        )
        if not session:
            return Response(status=status.HTTP_404_NOT_FOUND)
        if session.session_key == request.session.session_key:
            end_current_session(request)
        else:
            session.revoked_at = timezone.now()
            session.save(update_fields=("revoked_at",))
            from django.contrib.sessions.models import Session

            Session.objects.filter(session_key=session.session_key).delete()
        return Response(status=status.HTTP_204_NO_CONTENT)


class SignOutEverywhereView(APIView):
    def post(self, request):
        revoke_sessions(request.user)
        end_current_session(request)
        return Response(status=status.HTTP_204_NO_CONTENT)


class MFASetupView(APIView):
    @transaction.atomic
    def post(self, request):
        user = _locked_request_user(request.user)
        request.user = user
        if user.organization.kind == Organization.Kind.PLATFORM and user.mfa_enabled:
            code = str(request.data.get("currentCode", ""))
            if not (verify_totp(user, code) or use_recovery_code(user, code)):
                _require_recent_platform_mfa(request, user)
        if not user.check_password(str(request.data.get("currentPassword", ""))):
            raise ValidationError(
                {"currentPassword": ["Current password is required to set up MFA"]}
            )
        secret = pyotp.random_base32()
        request.session["mfa_setup_secret"] = encrypt_secret(secret)
        request.session["mfa_setup_authorized_at"] = timezone.now().timestamp()
        persist_session(request)
        uri = pyotp.TOTP(secret).provisioning_uri(name=user.email, issuer_name="Vessel Caller")
        return Response({"secret": secret, "provisioningUri": uri})


class MFAConfirmView(APIView):
    @transaction.atomic
    def post(self, request):
        encrypted = request.session.get("mfa_setup_secret", "")
        authorized_at = request.session.get("mfa_setup_authorized_at", 0)
        secret = decrypt_secret(encrypted)
        code = str(request.data.get("code", ""))
        setup_fresh = (
            isinstance(authorized_at, (int, float))
            and timezone.now().timestamp() - authorized_at <= 300
        )
        if not setup_fresh or not secret or not pyotp.TOTP(secret).verify(code, valid_window=1):
            raise ValidationError({"code": ["Invalid authentication code"]})
        user = _locked_request_user(request.user)
        user.mfa_secret = encrypt_secret(secret)
        user.mfa_enabled_at = timezone.now()
        user.save(update_fields=("mfa_secret", "mfa_enabled_at", "updated_at"))
        request.session.pop("mfa_setup_secret", None)
        request.session.pop("mfa_setup_authorized_at", None)
        request.session["mfa_verified_at"] = timezone.now().timestamp()
        persist_session(request)
        recovery = generate_recovery_codes(user)
        revoke_sessions(user, request=request, keep_current=True)
        queue_security_notice(
            user,
            event_key=f"mfa-enabled:{user.id}:{user.mfa_enabled_at.isoformat()}",
            subject="Multi-factor authentication was enabled",
            message="Multi-factor authentication was enabled for your Vessel Caller account.",
        )
        record_identity_event(
            organization=user.organization,
            actor=user,
            action="account.mfa_enabled",
            target=user,
            target_label=user.email,
            request=request,
        )
        return Response({"recoveryCodes": recovery})


class MFARecoveryCodesView(APIView):
    @transaction.atomic
    def post(self, request):
        user = _locked_request_user(request.user)
        _require_recent_platform_mfa(request, user)
        if not verify_totp(user, str(request.data.get("code", ""))):
            raise ValidationError({"code": ["Invalid authentication code"]})
        recovery_codes = generate_recovery_codes(user)
        record_identity_event(
            organization=user.organization,
            actor=user,
            action="account.mfa_recovery_codes_regenerated",
            target=user,
            target_label=user.email,
            request=request,
        )
        return Response({"recoveryCodes": recovery_codes})


class MFADisableView(APIView):
    @transaction.atomic
    def delete(self, request):
        user = _locked_request_user(request.user)
        if user.organization.kind == Organization.Kind.PLATFORM:
            raise ValidationError(
                {"mfa": ["Platform multi-factor authentication requires operator recovery"]}
            )
        if not (
            verify_totp(user, str(request.data.get("code", "")))
            or user.check_password(str(request.data.get("password", "")))
        ):
            raise ValidationError({"code": ["Password or authentication code is required"]})
        user.mfa_secret = EMPTY_MFA_SECRET
        user.mfa_enabled_at = None
        user.mfa_grace_ends_at = timezone.now() + timedelta(days=settings.MFA_GRACE_DAYS)
        user.save(update_fields=("mfa_secret", "mfa_enabled_at", "mfa_grace_ends_at", "updated_at"))
        user.recovery_codes.all().delete()
        revoke_sessions(user, request=request, keep_current=True)
        queue_security_notice(
            user,
            event_key=f"mfa-disabled:{user.id}:{user.updated_at.isoformat()}",
            subject="Multi-factor authentication was disabled",
            message="Multi-factor authentication was disabled for your Vessel Caller account.",
        )
        record_identity_event(
            organization=user.organization,
            actor=user,
            action="account.mfa_disabled",
            target=user,
            target_label=user.email,
            request=request,
        )
        return Response(status=status.HTTP_204_NO_CONTENT)
