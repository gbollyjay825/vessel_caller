from __future__ import annotations

import hashlib
from datetime import timedelta

import pyotp
from django.conf import settings
from django.contrib.auth import authenticate
from django.core.cache import cache
from django.db import transaction
from django.middleware.csrf import get_token
from django.utils import timezone
from django.utils.decorators import method_decorator
from django.views.decorators.csrf import csrf_protect, ensure_csrf_cookie
from rest_framework import status
from rest_framework.exceptions import APIException, ValidationError
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.views import APIView

from accounts.models import ActionToken, MFAChallenge, User
from accounts.security import (
    consume_action_token,
    decrypt_secret,
    EMPTY_MFA_SECRET,
    encrypt_secret,
    generate_recovery_codes,
    issue_action_token,
    use_recovery_code,
    verify_totp,
)
from accounts.services import (
    end_current_session,
    queue_email,
    revoke_sessions,
    rotate_current_session,
    start_session,
)
from audit.services import record_event
from organizations.models import Organization, OrganizationSettings

from .permissions import effective_permissions
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


def session_payload(user: User) -> dict:
    members = (
        user.organization.users.order_by("created_at") if user.role == User.Role.ADMIN else None
    )
    return {
        "user": user_data(user),
        "org": organization_data(user.organization, members=members),
        "permissions": effective_permissions(user),
    }


def _url(path: str, token: str) -> str:
    return f"{settings.FRONTEND_URL}{path}?token={token}"


def _throttle_key(email: str, request) -> str:
    ip = request.META.get("REMOTE_ADDR", "")
    return "login:" + hashlib.sha256(f"{email}:{ip}".encode()).hexdigest()


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
            terminals=[
                "Calabar New Port — Berth 3",
                "Calabar Bulk Terminal",
                "UNICEM Jetty",
            ],
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
            user.email = pending
            user.pending_email = ""
            user.email_verified_at = now
            user.save(update_fields=("email", "pending_email", "email_verified_at", "updated_at"))
            action = "account.email_changed"
        else:
            before = {"status": user.status}
            user.status = User.Status.ACTIVE
            user.email_verified_at = now
            user.organization.registered = True
            user.organization.save(update_fields=("registered", "updated_at"))
            user.save(update_fields=("status", "email_verified_at", "updated_at"))
            action = "account.email_verified"
        record_event(
            organization=user.organization,
            actor=user,
            action=action,
            category="identity",
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
        user = User.objects.filter(
            email=serializer.validated_data["email"].lower(),
            email_verified_at__isnull=True,
        ).first()
        if user:
            token_obj, raw = issue_action_token(user, ActionToken.Kind.VERIFY_EMAIL, hours=24)
            queue_email(
                to_email=user.email,
                subject="Verify your Vessel Caller account",
                template="verify_email",
                context={"actionUrl": _url("/verify-email", raw)},
                idempotency_key=f"verify:{token_obj.id}",
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
        key = _throttle_key(email, request)
        failures = cache.get(key, 0)
        if failures >= 8:
            raise Unauthorized("Too many attempts. Try again later")
        user = authenticate(
            request,
            email=email,
            password=serializer.validated_data["password"],
        )
        if not user or not user.email_verified_at:
            cache.set(key, failures + 1, timeout=min(3600, 2 ** (failures + 1)))
            raise Unauthorized("Invalid email or password")
        cache.delete(key)
        if user.mfa_enabled:
            challenge = MFAChallenge.objects.create(
                user=user, expires_at=timezone.now() + timedelta(minutes=5)
            )
            return Response(
                {"mfaRequired": True, "challengeId": challenge.id},
                status=status.HTTP_202_ACCEPTED,
            )
        start_session(request, user)
        record_event(
            organization=user.organization,
            actor=user,
            action="session.login",
            category="identity",
            target=user,
            target_label=user.email,
            request=request,
        )
        return Response(session_payload(user))


@method_decorator(csrf_protect, name="dispatch")
class MFAVerifyView(APIView):
    authentication_classes = []
    permission_classes = [AllowAny]

    @transaction.atomic
    def post(self, request):
        challenge_id = request.data.get("challengeId", "")
        code = str(request.data.get("code", ""))
        try:
            challenge = (
                MFAChallenge.objects.select_for_update()
                .select_related("user__organization")
                .get(pk=challenge_id, used_at__isnull=True)
            )
        except MFAChallenge.DoesNotExist as exc:
            raise Unauthorized("Invalid or expired MFA challenge") from exc
        if challenge.expires_at <= timezone.now() or challenge.attempts >= 5:
            raise Unauthorized("Invalid or expired MFA challenge")
        challenge.attempts += 1
        challenge.save(update_fields=("attempts",))
        user = challenge.user
        if not (verify_totp(user, code) or use_recovery_code(user, code)):
            raise Unauthorized("Invalid authentication code")
        challenge.used_at = timezone.now()
        challenge.save(update_fields=("used_at",))
        start_session(request, user)
        record_event(
            organization=user.organization,
            actor=user,
            action="session.login_mfa",
            category="identity",
            target=user,
            target_label=user.email,
            request=request,
        )
        return Response(session_payload(user))


class MeView(APIView):
    def get(self, request):
        return Response(session_payload(request.user))


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
        user = User.objects.filter(
            email=serializer.validated_data["email"].lower(),
            status=User.Status.ACTIVE,
        ).first()
        if user:
            token_obj, raw = issue_action_token(user, ActionToken.Kind.RESET_PASSWORD, hours=1)
            queue_email(
                to_email=user.email,
                subject="Reset your Vessel Caller password",
                template="reset_password",
                context={"actionUrl": _url("/reset-password", raw)},
                idempotency_key=f"reset:{token_obj.id}",
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
        user.set_password(serializer.validated_data["password"])
        user.save(update_fields=("password", "updated_at"))
        revoke_sessions(user)
        record_event(
            organization=user.organization,
            actor=user,
            action="account.password_reset",
            category="identity",
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
        user = request.user
        if not user.check_password(serializer.validated_data["currentPassword"]):
            raise ValidationError({"currentPassword": ["Current password is incorrect"]})
        user.set_password(serializer.validated_data["password"])
        user.save(update_fields=("password", "updated_at"))
        revoke_sessions(user, request=request, keep_current=True)
        rotate_current_session(request, user)
        record_event(
            organization=user.organization,
            actor=user,
            action="account.password_changed",
            category="identity",
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
        user = User.objects.select_for_update().get(pk=request.user.pk)
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
            token_obj, raw = issue_action_token(
                user,
                ActionToken.Kind.VERIFY_EMAIL,
                hours=24,
                metadata={"pendingEmail": new_email},
            )
            queue_email(
                to_email=new_email,
                subject="Verify your new Vessel Caller email",
                template="verify_email",
                context={"actionUrl": _url("/verify-email", raw)},
                idempotency_key=f"verify:{token_obj.id}",
            )
            verification_required = True
        user.save()
        record_event(
            organization=user.organization,
            actor=user,
            action="account.profile_updated",
            category="identity",
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
                "id": item.session_key,
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
        session = request.user.sessions.filter(
            session_key=session_id, revoked_at__isnull=True
        ).first()
        if not session:
            return Response(status=status.HTTP_404_NOT_FOUND)
        if session.session_key == request.session.session_key:
            end_current_session(request)
        else:
            session.revoked_at = timezone.now()
            session.save(update_fields=("revoked_at",))
            from django.contrib.sessions.models import Session

            Session.objects.filter(session_key=session_id).delete()
        return Response(status=status.HTTP_204_NO_CONTENT)


class SignOutEverywhereView(APIView):
    def post(self, request):
        revoke_sessions(request.user)
        end_current_session(request)
        return Response(status=status.HTTP_204_NO_CONTENT)


class MFASetupView(APIView):
    def post(self, request):
        if not request.user.check_password(str(request.data.get("currentPassword", ""))):
            raise ValidationError(
                {"currentPassword": ["Current password is required to set up MFA"]}
            )
        secret = pyotp.random_base32()
        request.session["mfa_setup_secret"] = encrypt_secret(secret)
        request.session["mfa_setup_authorized_at"] = timezone.now().timestamp()
        uri = pyotp.TOTP(secret).provisioning_uri(
            name=request.user.email, issuer_name="Vessel Caller"
        )
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
        user = User.objects.select_for_update().get(pk=request.user.pk)
        user.mfa_secret = encrypt_secret(secret)
        user.mfa_enabled_at = timezone.now()
        user.save(update_fields=("mfa_secret", "mfa_enabled_at", "updated_at"))
        request.session.pop("mfa_setup_secret", None)
        request.session.pop("mfa_setup_authorized_at", None)
        recovery = generate_recovery_codes(user)
        revoke_sessions(user, request=request, keep_current=True)
        record_event(
            organization=user.organization,
            actor=user,
            action="account.mfa_enabled",
            category="identity",
            target=user,
            target_label=user.email,
            request=request,
        )
        return Response({"recoveryCodes": recovery})


class MFARecoveryCodesView(APIView):
    def post(self, request):
        if not verify_totp(request.user, str(request.data.get("code", ""))):
            raise ValidationError({"code": ["Invalid authentication code"]})
        return Response({"recoveryCodes": generate_recovery_codes(request.user)})


class MFADisableView(APIView):
    @transaction.atomic
    def delete(self, request):
        user = User.objects.select_for_update().get(pk=request.user.pk)
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
        record_event(
            organization=user.organization,
            actor=user,
            action="account.mfa_disabled",
            category="identity",
            target=user,
            target_label=user.email,
            request=request,
        )
        return Response(status=status.HTTP_204_NO_CONTENT)
