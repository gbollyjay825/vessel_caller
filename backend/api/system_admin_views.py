from __future__ import annotations

import csv
import io
from datetime import timedelta
from pathlib import Path

from django.conf import settings
from django.db import transaction
from django.db.models import Count, Q
from django.http import HttpResponse
from django.utils import timezone
from rest_framework import status
from rest_framework.exceptions import (
    APIException,
    NotFound,
    PermissionDenied,
    Throttled,
    ValidationError,
)
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from accounts.models import ActionToken, Invitation, MFAChallenge, User
from accounts.notifications import queue_security_notice
from accounts.platform_access import (
    active_platform_grant,
    lock_operational_platform_access,
    platform_access_data,
)
from accounts.security import (
    EMPTY_MFA_SECRET,
    issue_action_token,
    token_hash,
    use_recovery_code,
    verify_totp,
)
from accounts.services import (
    MFA_FAILURE_LIMIT,
    clear_mfa_failures,
    opaque_token,
    persist_session,
    queue_email,
    record_mfa_failure,
    revoke_sessions,
)
from audit.models import PlatformAuditEvent
from audit.services import record_event, record_platform_event
from organizations.models import Organization
from organizations.services import (
    ADMIN_INVITATION_UNAVAILABLE_MESSAGE,
    AdminInvitationUnavailable,
    create_admin_invitation,
    create_customer_organization,
    reactivate_customer_organization,
    suspend_customer_organization,
)

from .auth_views import _decrement_rate_key, _increment_rate_key, _mfa_ip_key

from .pagination import StandardPagination
from .platform_idempotency import idempotent_system_mutation
from .permissions import IsRecentSystemAdminMFA, IsSystemAdmin, IsSystemAdminAccount
from .platform_serializers import (
    SystemAdminInvitationSerializer,
    SystemOrganizationCreateSerializer,
    SystemOrganizationLifecycleSerializer,
    SystemOrganizationUpdateSerializer,
    SystemUserActionSerializer,
    system_audit_data,
    system_organization_data,
    system_organization_summary_data,
    system_user_data,
)
from .serializers import invitation_data


class Conflict(APIException):
    status_code = status.HTTP_409_CONFLICT
    default_detail = "The organization changed. Refresh and try again"
    default_code = "conflict"


class SystemMutationsDisabled(APIException):
    status_code = status.HTTP_503_SERVICE_UNAVAILABLE
    default_detail = "System administration changes are temporarily disabled"
    default_code = "system_mutations_disabled"


def require_system_mutations() -> None:
    email_ready = settings.EMAIL_DELIVERY_BACKEND == "resend" and bool(settings.RESEND_API_KEY)
    local_memory = (
        settings.ENVIRONMENT in {"development", "test"}
        and settings.EMAIL_DELIVERY_BACKEND == "memory"
    )
    if not email_ready and not local_memory:
        raise SystemMutationsDisabled()
    flag_file = str(settings.SYSTEM_ADMIN_MUTATION_FLAG_FILE).strip()
    if flag_file:
        try:
            if Path(flag_file).read_text(encoding="utf-8") == "enabled\n":
                return
        except OSError:
            pass
        raise SystemMutationsDisabled()
    if not settings.SYSTEM_ADMIN_MUTATIONS_ENABLED:
        raise SystemMutationsDisabled()


def customer_organizations():
    return Organization.objects.filter(kind=Organization.Kind.CUSTOMER)


def annotated_customer_organizations():
    return customer_organizations().annotate(
        user_count=Count("users", distinct=True),
        active_user_count=Count(
            "users",
            filter=Q(users__status=User.Status.ACTIVE),
            distinct=True,
        ),
        admin_count=Count(
            "users",
            filter=Q(users__status=User.Status.ACTIVE, users__role=User.Role.ADMIN),
            distinct=True,
        ),
        pending_invitation_count=Count(
            "invitations",
            filter=Q(
                invitations__status=Invitation.Status.PENDING,
                invitations__role=User.Role.ADMIN,
            ),
            distinct=True,
        ),
    )


def get_customer_organization(organization_id: str) -> Organization:
    organization = customer_organizations().filter(pk=organization_id).first()
    if not organization:
        raise NotFound("Organization not found")
    return organization


def lock_customer_organization(organization_id: str) -> Organization:
    organization = (
        Organization.objects.select_for_update()
        .filter(pk=organization_id, kind=Organization.Kind.CUSTOMER)
        .first()
    )
    if not organization:
        raise NotFound("Organization not found")
    return organization


def increment_revision(organization: Organization) -> int:
    organization.revision += 1
    organization.save(update_fields=("revision", "updated_at"))
    return organization.revision


def record_system_action(
    *,
    organization: Organization,
    actor: User,
    action: str,
    target,
    reason: str,
    request,
    before=None,
    after=None,
    tenant_after=None,
) -> None:
    record_platform_event(
        organization=organization,
        actor=actor,
        action=action,
        target=target,
        target_label=str(getattr(target, "email", "") or getattr(target, "name", "")),
        reason=reason,
        request=request,
        before=before,
        after=after,
    )
    record_event(
        organization=organization,
        actor=None,
        action=action,
        category="platform",
        target=target,
        target_label="Vessel Caller System",
        request=request,
        before=before,
        after=tenant_after if tenant_after is not None else after,
    )


class SystemAccountView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        user = request.user
        grant = active_platform_grant(user)
        if (
            not grant
            or not user.is_active
            or not user.email_verified_at
            or user.organization.kind != Organization.Kind.PLATFORM
            or user.is_staff
            or user.is_superuser
        ):
            raise PermissionDenied("System administrator access is required")
        return Response(
            {
                "user": system_user_data(user),
                "platformAccess": platform_access_data(user, request=request),
            }
        )


class SystemStepUpView(APIView):
    permission_classes = [IsAuthenticated, IsSystemAdminAccount]

    @transaction.atomic
    def post(self, request):
        access = lock_operational_platform_access(request.user)
        if not access:
            raise PermissionDenied("System administrator access is required")
        actor, _grant = access
        request.user = actor
        code = str(request.data.get("code", "")).strip()
        ip_key = _mfa_ip_key(request)
        user_attempt = record_mfa_failure(request.user.id)
        ip_attempt = _increment_rate_key(ip_key)
        if user_attempt > MFA_FAILURE_LIMIT or ip_attempt > 24:
            raise Throttled(wait=900)
        if not code or not (
            verify_totp(request.user, code) or use_recovery_code(request.user, code)
        ):
            raise ValidationError({"code": ["Invalid authentication code"]})
        clear_mfa_failures(request.user.id)
        _decrement_rate_key(ip_key)
        request.session["mfa_verified_at"] = timezone.now().timestamp()
        persist_session(request)
        record_platform_event(
            organization=request.user.organization,
            actor=request.user,
            action="platform.system_admin.step_up",
            target=request.user,
            target_label=request.user.email,
            reason="Recent multi-factor verification completed",
            request=request,
            after={"verified": True},
        )
        return Response(
            {
                "detail": "System Administrator verification refreshed",
                "platformAccess": platform_access_data(request.user, request=request),
            }
        )


class RecentMutationPermissionsMixin(APIView):
    def get_permissions(self):
        if self.request.method in {"POST", "PATCH", "PUT", "DELETE"}:
            return [IsAuthenticated(), IsRecentSystemAdminMFA()]
        return super().get_permissions()


class SystemOverviewView(APIView):
    permission_classes = [IsAuthenticated, IsSystemAdmin]

    def get(self, request):
        organizations = customer_organizations()
        users = User.objects.filter(organization__kind=Organization.Kind.CUSTOMER)
        recent = annotated_customer_organizations().order_by("-created_at")[:5]
        return Response(
            {
                "organizationCount": organizations.count(),
                "activeOrganizationCount": organizations.filter(
                    access_status=Organization.AccessStatus.ACTIVE
                ).count(),
                "suspendedOrganizationCount": organizations.filter(
                    access_status=Organization.AccessStatus.SUSPENDED
                ).count(),
                "activeUserCount": users.filter(
                    status=User.Status.ACTIVE,
                    organization__access_status=Organization.AccessStatus.ACTIVE,
                ).count(),
                "pendingInvitationCount": Invitation.objects.filter(
                    organization__kind=Organization.Kind.CUSTOMER,
                    status=Invitation.Status.PENDING,
                    role=User.Role.ADMIN,
                ).count(),
                "recentOrganizations": [system_organization_summary_data(item) for item in recent],
            }
        )


class SystemOrganizationsView(RecentMutationPermissionsMixin):
    permission_classes = [IsAuthenticated, IsSystemAdmin]

    def get(self, request):
        queryset = annotated_customer_organizations().order_by("name", "id")
        search = request.query_params.get("search", "").strip()
        if search:
            queryset = queryset.filter(
                Q(name__icontains=search)
                | Q(id__icontains=search)
                | Q(email__icontains=search)
                | Q(rc_number__icontains=search)
            )
        access_status = request.query_params.get("status", "")
        if access_status in Organization.AccessStatus.values:
            queryset = queryset.filter(access_status=access_status)
        registered = request.query_params.get("registered", "")
        if registered in {"true", "false"}:
            queryset = queryset.filter(registered=registered == "true")
        primary_port = request.query_params.get("primaryPort", "").strip()
        if primary_port:
            queryset = queryset.filter(primary_port=primary_port)
        paginator = StandardPagination()
        page = paginator.paginate_queryset(queryset, request) or []
        return paginator.get_paginated_response(
            [system_organization_summary_data(item) for item in page]
        )

    @idempotent_system_mutation("system.organization.create")
    def post(self, request):
        require_system_mutations()
        serializer = SystemOrganizationCreateSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        try:
            organization, invitation = create_customer_organization(
                data=serializer.validated_data,
                actor=request.user,
                request=request,
            )
        except AdminInvitationUnavailable as exc:
            raise ValidationError({"initialAdmin": [ADMIN_INVITATION_UNAVAILABLE_MESSAGE]}) from exc
        return Response(
            {
                "organization": system_organization_data(organization),
                "invitation": invitation_data(invitation),
                "rev": organization.revision,
            },
            status=status.HTTP_201_CREATED,
        )


class SystemOrganizationDetailView(RecentMutationPermissionsMixin):
    permission_classes = [IsAuthenticated, IsSystemAdmin]

    def get(self, request, organization_id):
        organization = annotated_customer_organizations().filter(pk=organization_id).first()
        if not organization:
            raise NotFound("Organization not found")
        data = system_organization_data(organization)
        return Response(
            {
                "organization": data,
                "counts": {
                    "users": data["userCount"],
                    "activeUsers": data["activeUserCount"],
                    "admins": data["adminCount"],
                    "pendingInvitations": data["pendingInvitationCount"],
                },
            }
        )

    @idempotent_system_mutation("system.organization.update")
    @transaction.atomic
    def patch(self, request, organization_id):
        require_system_mutations()
        serializer = SystemOrganizationUpdateSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        organization = lock_customer_organization(organization_id)
        if organization.revision != serializer.validated_data["revision"]:
            raise Conflict()
        before = {
            "name": organization.name,
            "rcNumber": organization.rc_number,
            "email": organization.email,
            "phone": organization.phone,
            "address": organization.address,
            "primaryPort": organization.primary_port,
            "ports": organization.ports,
        }
        mapping = {
            "name": "name",
            "rcNumber": "rc_number",
            "email": "email",
            "phone": "phone",
            "address": "address",
            "primaryPort": "primary_port",
            "ports": "ports",
        }
        for key, field in mapping.items():
            if key in serializer.validated_data:
                value = serializer.validated_data[key]
                setattr(organization, field, value.strip() if isinstance(value, str) else value)
        ports = list(organization.ports or [])
        if organization.primary_port.casefold() not in {item.casefold() for item in ports}:
            ports.append(organization.primary_port)
        organization.ports = ports
        organization.full_clean()
        after = {
            "name": organization.name,
            "rcNumber": organization.rc_number,
            "email": organization.email,
            "phone": organization.phone,
            "address": organization.address,
            "primaryPort": organization.primary_port,
            "ports": organization.ports,
        }
        if before == after:
            return Response(
                {
                    "organization": system_organization_data(organization),
                    "rev": organization.revision,
                }
            )
        organization.revision += 1
        organization.save(
            update_fields=(
                "name",
                "rc_number",
                "email",
                "phone",
                "address",
                "primary_port",
                "ports",
                "revision",
                "updated_at",
            )
        )
        record_system_action(
            organization=organization,
            actor=request.user,
            action="platform.organization.updated",
            target=organization,
            reason="Updated customer organization profile",
            request=request,
            before=before,
            after=after,
            tenant_after=after,
        )
        return Response(
            {"organization": system_organization_data(organization), "rev": organization.revision}
        )


class SystemOrganizationSuspendView(APIView):
    permission_classes = [IsAuthenticated, IsRecentSystemAdminMFA]

    @idempotent_system_mutation("system.organization.suspend")
    @transaction.atomic
    def post(self, request, organization_id):
        require_system_mutations()
        serializer = SystemOrganizationLifecycleSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        organization = lock_customer_organization(organization_id)
        if organization.access_status != Organization.AccessStatus.SUSPENDED:
            if organization.revision != serializer.validated_data["revision"]:
                raise Conflict()
            suspend_customer_organization(
                organization=organization,
                actor=request.user,
                reason=serializer.validated_data["reason"],
                request=request,
            )
        return Response(
            {"organization": system_organization_data(organization), "rev": organization.revision}
        )


class SystemOrganizationReactivateView(APIView):
    permission_classes = [IsAuthenticated, IsRecentSystemAdminMFA]

    @idempotent_system_mutation("system.organization.reactivate")
    @transaction.atomic
    def post(self, request, organization_id):
        require_system_mutations()
        serializer = SystemOrganizationLifecycleSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        organization = lock_customer_organization(organization_id)
        if organization.access_status != Organization.AccessStatus.ACTIVE:
            if organization.revision != serializer.validated_data["revision"]:
                raise Conflict()
            reactivate_customer_organization(
                organization=organization,
                actor=request.user,
                reason=serializer.validated_data["reason"],
                request=request,
            )
        return Response(
            {"organization": system_organization_data(organization), "rev": organization.revision}
        )


class SystemOrganizationUsersView(APIView):
    permission_classes = [IsAuthenticated, IsSystemAdmin]

    def get(self, request, organization_id):
        organization = get_customer_organization(organization_id)
        queryset = organization.users.select_related("organization")
        search = request.query_params.get("search", "").strip()
        if search:
            queryset = queryset.filter(Q(name__icontains=search) | Q(email__icontains=search))
        if request.query_params.get("role") in User.Role.values:
            queryset = queryset.filter(role=request.query_params["role"])
        if request.query_params.get("status") in User.Status.values:
            queryset = queryset.filter(status=request.query_params["status"])
        paginator = StandardPagination()
        page = paginator.paginate_queryset(queryset, request) or []
        return paginator.get_paginated_response([system_user_data(item) for item in page])


class SystemOrganizationInvitationsView(RecentMutationPermissionsMixin):
    permission_classes = [IsAuthenticated, IsSystemAdmin]

    def get(self, request, organization_id):
        organization = get_customer_organization(organization_id)
        queryset = organization.invitations.filter(role=User.Role.ADMIN).select_related(
            "invited_by__organization"
        )
        paginator = StandardPagination()
        page = paginator.paginate_queryset(queryset, request) or []
        return paginator.get_paginated_response([invitation_data(item) for item in page])

    @idempotent_system_mutation("system.admin_invitation.create")
    @transaction.atomic
    def post(self, request, organization_id):
        require_system_mutations()
        serializer = SystemAdminInvitationSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        organization = lock_customer_organization(organization_id)
        if organization.access_status != Organization.AccessStatus.ACTIVE:
            raise ValidationError("Suspended organizations cannot receive invitations")
        try:
            invitation = create_admin_invitation(
                organization=organization,
                actor=request.user,
                name=serializer.validated_data["name"],
                email=serializer.validated_data["email"],
                request=request,
            )
        except AdminInvitationUnavailable as exc:
            raise ValidationError({"email": [ADMIN_INVITATION_UNAVAILABLE_MESSAGE]}) from exc
        return Response(
            {"invitation": invitation_data(invitation), "rev": organization.revision},
            status=status.HTTP_201_CREATED,
        )


class SystemOrganizationInvitationResendView(APIView):
    permission_classes = [IsAuthenticated, IsRecentSystemAdminMFA]

    @idempotent_system_mutation("system.admin_invitation.resend")
    @transaction.atomic
    def post(self, request, organization_id, invitation_id):
        require_system_mutations()
        organization = lock_customer_organization(organization_id)
        if organization.access_status != Organization.AccessStatus.ACTIVE:
            raise ValidationError("Suspended organizations cannot receive invitations")
        invitation = (
            organization.invitations.select_for_update()
            .filter(
                pk=invitation_id,
                status=Invitation.Status.PENDING,
                role=User.Role.ADMIN,
            )
            .first()
        )
        if not invitation:
            raise NotFound("Invitation not found")
        raw = opaque_token()
        invitation.token_hash = token_hash(raw)
        invitation.expires_at = timezone.now() + timedelta(hours=24)
        invitation.save(update_fields=("token_hash", "expires_at"))
        queue_email(
            to_email=invitation.email,
            subject=f"Join {organization.name} on Vessel Caller",
            template="invitation",
            context={"actionUrl": f"{settings.FRONTEND_URL}/accept-invitation?token={raw}"},
            idempotency_key=f"system-admin-invite-resend:{invitation.id}:{invitation.expires_at.isoformat()}",
            organization=organization,
        )
        revision = increment_revision(organization)
        record_system_action(
            organization=organization,
            actor=request.user,
            action="platform.admin_invitation.resent",
            target=invitation,
            reason="Resent the customer administrator invitation",
            request=request,
            after={"email": invitation.email, "expiresInHours": 24},
            tenant_after={"expiresInHours": 24},
        )
        return Response({"invitation": invitation_data(invitation), "rev": revision})


class SystemOrganizationInvitationDetailView(APIView):
    permission_classes = [IsAuthenticated, IsRecentSystemAdminMFA]

    @idempotent_system_mutation("system.admin_invitation.revoke")
    @transaction.atomic
    def delete(self, request, organization_id, invitation_id):
        require_system_mutations()
        organization = lock_customer_organization(organization_id)
        invitation = (
            organization.invitations.select_for_update()
            .filter(
                pk=invitation_id,
                status=Invitation.Status.PENDING,
                role=User.Role.ADMIN,
            )
            .first()
        )
        if not invitation:
            raise NotFound("Invitation not found")
        invitation.status = Invitation.Status.REVOKED
        invitation.revoked_at = timezone.now()
        invitation.save(update_fields=("status", "revoked_at"))
        revision = increment_revision(organization)
        record_system_action(
            organization=organization,
            actor=request.user,
            action="platform.admin_invitation.revoked",
            target=invitation,
            reason="Revoked the customer administrator invitation",
            request=request,
            after={"email": invitation.email, "status": invitation.status},
            tenant_after={"status": invitation.status},
        )
        return Response({"invitation": invitation_data(invitation), "rev": revision})


class SystemOrganizationUserPasswordResetView(APIView):
    permission_classes = [IsAuthenticated, IsRecentSystemAdminMFA]

    @idempotent_system_mutation("system.admin.password_reset")
    @transaction.atomic
    def post(self, request, organization_id, user_id):
        require_system_mutations()
        serializer = SystemUserActionSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        organization = lock_customer_organization(organization_id)
        if organization.access_status != Organization.AccessStatus.ACTIVE:
            raise ValidationError("Suspended organizations cannot receive recovery actions")
        member = (
            organization.users.select_for_update()
            .filter(
                pk=user_id,
                role=User.Role.ADMIN,
                status=User.Status.ACTIVE,
            )
            .first()
        )
        if not member:
            raise NotFound("Active organization Admin not found")
        token_obj, raw = issue_action_token(member, ActionToken.Kind.RESET_PASSWORD, hours=1)
        queue_email(
            to_email=member.email,
            subject="Reset your Vessel Caller password",
            template="reset_password",
            context={"actionUrl": f"{settings.FRONTEND_URL}/reset-password?token={raw}"},
            idempotency_key=f"reset:{token_obj.id}",
            organization=organization,
        )
        revision = increment_revision(organization)
        record_system_action(
            organization=organization,
            actor=request.user,
            action="platform.admin.password_reset_sent",
            target=member,
            reason=serializer.validated_data["reason"],
            request=request,
            after={"email": member.email},
            tenant_after={"status": "dispatched"},
        )
        return Response(
            {"detail": "Password reset email sent", "rev": revision},
            status=status.HTTP_202_ACCEPTED,
        )


class SystemOrganizationUserMFAResetView(APIView):
    permission_classes = [IsAuthenticated, IsRecentSystemAdminMFA]

    @idempotent_system_mutation("system.admin.mfa_reset")
    @transaction.atomic
    def post(self, request, organization_id, user_id):
        require_system_mutations()
        serializer = SystemUserActionSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        organization = lock_customer_organization(organization_id)
        if organization.access_status != Organization.AccessStatus.ACTIVE:
            raise ValidationError("Suspended organizations cannot receive recovery actions")
        member = (
            organization.users.select_for_update()
            .filter(
                pk=user_id,
                role=User.Role.ADMIN,
                status=User.Status.ACTIVE,
            )
            .first()
        )
        if not member:
            raise NotFound("Active organization Admin not found")
        member.mfa_secret = EMPTY_MFA_SECRET
        member.mfa_enabled_at = None
        member.mfa_grace_ends_at = timezone.now() + timedelta(days=settings.MFA_GRACE_DAYS)
        member.save(
            update_fields=("mfa_secret", "mfa_enabled_at", "mfa_grace_ends_at", "updated_at")
        )
        member.recovery_codes.all().delete()
        MFAChallenge.objects.filter(user=member, used_at__isnull=True).delete()
        revoke_sessions(member)
        revision = increment_revision(organization)
        record_system_action(
            organization=organization,
            actor=request.user,
            action="platform.admin.mfa_reset",
            target=member,
            reason=serializer.validated_data["reason"],
            request=request,
            after={"email": member.email, "mfaEnabled": False},
            tenant_after={"mfaEnabled": False},
        )
        queue_security_notice(
            member,
            event_key=f"platform-mfa-reset:{member.id}:{revision}",
            subject="Your Vessel Caller multi-factor authentication was reset",
            message="Vessel Caller support reset your multi-factor authentication and signed out your sessions.",
        )
        return Response({"user": system_user_data(member), "rev": revision})


class SystemAuditView(APIView):
    permission_classes = [IsAuthenticated, IsSystemAdmin]

    def get(self, request, organization_id=None):
        queryset = filtered_platform_audit(request, organization_id=organization_id)
        paginator = StandardPagination()
        page = paginator.paginate_queryset(queryset, request) or []
        return paginator.get_paginated_response([system_audit_data(item) for item in page])


class SystemOrganizationAuditView(SystemAuditView):
    """Organization-scoped audit route with a distinct OpenAPI operation id."""

    pass


def filtered_platform_audit(request, *, organization_id=None):
    queryset = PlatformAuditEvent.objects.select_related("organization", "actor")
    if organization_id:
        get_customer_organization(organization_id)
        queryset = queryset.filter(organization_id=organization_id)
    elif request.query_params.get("organizationId"):
        organization = get_customer_organization(request.query_params["organizationId"])
        queryset = queryset.filter(organization=organization)
    action = request.query_params.get("action", "").strip()
    if action:
        queryset = queryset.filter(action=action)
    actor = request.query_params.get("actor", "").strip()
    if actor:
        queryset = queryset.filter(actor_id=actor)
    search = request.query_params.get("search", "").strip()
    if search:
        queryset = queryset.filter(
            Q(target_label__icontains=search)
            | Q(actor__email__icontains=search)
            | Q(organization__name__icontains=search)
            | Q(action__icontains=search)
            | Q(request_id__icontains=search)
        )
    return queryset


def csv_safe(value) -> str:
    text = str(value or "")
    return f"'{text}" if text.lstrip().startswith(("=", "+", "-", "@", "\t", "\r")) else text


class SystemAuditExportView(APIView):
    permission_classes = [IsAuthenticated, IsRecentSystemAdminMFA]
    export_limit = 10_000

    def get(self, request):
        output = io.StringIO()
        writer = csv.writer(output)
        writer.writerow(
            [
                "occurred_at",
                "organization_id",
                "organization_name",
                "action",
                "actor_email",
                "target_type",
                "target_id",
                "target_label",
                "reason",
                "request_id",
                "ip_address",
            ]
        )
        for event in filtered_platform_audit(request)[: self.export_limit]:
            writer.writerow(
                [
                    event.occurred_at.isoformat(),
                    csv_safe(event.organization_id),
                    csv_safe(event.organization.name),
                    csv_safe(event.action),
                    csv_safe(event.actor.email if event.actor else ""),
                    csv_safe(event.target_type),
                    csv_safe(event.target_id),
                    csv_safe(event.target_label),
                    csv_safe(event.reason),
                    csv_safe(event.request_id),
                    csv_safe(event.ip_address),
                ]
            )
        response = HttpResponse(output.getvalue(), content_type="text/csv")
        response["Content-Disposition"] = 'attachment; filename="vessel-caller-system-audit.csv"'
        response["Cache-Control"] = "no-store"
        return response
