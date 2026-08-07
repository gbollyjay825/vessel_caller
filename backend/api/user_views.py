from __future__ import annotations

import csv
import io
import secrets
from datetime import timedelta

from django.conf import settings
from django.db import transaction
from django.db.models import Q
from django.http import HttpResponse
from django.utils import timezone
from django.utils.decorators import method_decorator
from django.views.decorators.csrf import csrf_protect
from rest_framework import status
from rest_framework.exceptions import NotFound, ValidationError
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from accounts.models import ActionToken, Invitation, User
from accounts.notifications import queue_security_notice
from accounts.security import EMPTY_MFA_SECRET, issue_action_token, token_hash
from accounts.services import opaque_token, queue_email, revoke_sessions
from audit.models import AuditEvent
from audit.services import record_event
from organizations.models import Organization

from .domain import bump_revision
from .pagination import StandardPagination
from .permissions import HasVesselPermission, role_definitions
from .serializers import (
    InvitationAcceptSerializer,
    InvitationCreateSerializer,
    UserPatchSerializer,
    audit_data,
    invitation_data,
    user_data,
)


def csv_safe(value) -> str:
    text = str(value or "")
    return f"'{text}" if text.lstrip().startswith(("=", "+", "-", "@", "\t", "\r")) else text


class RoleDefinitionsView(APIView):
    """Expose the server-enforced role matrix to people who manage access."""

    permission_classes = [IsAuthenticated, HasVesselPermission]
    required_permission = "users.view"

    def get(self, request):
        return Response({"roles": role_definitions()})


class UsersView(APIView):
    permission_classes = [IsAuthenticated, HasVesselPermission]
    required_permission = "users.view"

    def get(self, request):
        queryset = request.user.organization.users.all()
        search = request.query_params.get("search", "").strip()
        if search:
            queryset = queryset.filter(Q(name__icontains=search) | Q(email__icontains=search))
        if request.query_params.get("role"):
            queryset = queryset.filter(role=request.query_params["role"])
        if request.query_params.get("status"):
            queryset = queryset.filter(status=request.query_params["status"])
        paginator = StandardPagination()
        page = paginator.paginate_queryset(queryset, request) or []
        return paginator.get_paginated_response([user_data(item) for item in page])


class UserDetailView(APIView):
    permission_classes = [IsAuthenticated, HasVesselPermission]
    required_permission = "users.manage"

    def _get(self, request, user_id):
        try:
            return request.user.organization.users.get(pk=user_id)
        except User.DoesNotExist as exc:
            raise NotFound("User not found") from exc

    @transaction.atomic
    def patch(self, request, user_id):
        serializer = UserPatchSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        organization = Organization.objects.select_for_update().get(pk=request.user.organization_id)
        member = (
            User.objects.select_for_update()
            .select_related("organization")
            .filter(pk=user_id, organization=organization)
            .first()
        )
        if not member:
            raise NotFound("User not found")
        data = serializer.validated_data
        changing_self_access = member.pk == request.user.pk and (
            ("role" in data and data["role"] != member.role)
            or ("status" in data and data["status"] != member.status)
        )
        if changing_self_access:
            raise ValidationError("You cannot change your own role or status")
        before = user_data(member)
        if member.role == User.Role.ADMIN and member.status == User.Status.ACTIVE:
            losing_admin = (
                data.get("role", member.role) != User.Role.ADMIN
                or data.get("status", member.status) != User.Status.ACTIVE
            )
            active_admins = User.objects.filter(
                organization=member.organization,
                role=User.Role.ADMIN,
                status=User.Status.ACTIVE,
            ).count()
            if losing_admin and active_admins <= 1:
                raise ValidationError("The organization must keep at least one active Admin")
        changed_access = False
        for field in ("name", "role", "status"):
            if field in data and getattr(member, field) != data[field]:
                setattr(member, field, data[field])
                changed_access = changed_access or field in {"role", "status"}
        member.save()
        if changed_access:
            revoke_sessions(member)
        revision = bump_revision(member.organization_id)
        record_event(
            organization=member.organization,
            actor=request.user,
            action="user.updated",
            category="identity",
            target=member,
            target_label=member.email,
            request=request,
            before=before,
            after=user_data(member),
        )
        if changed_access:
            changes = []
            if before["role"] != member.role:
                changes.append(f"your role is now {member.role}")
            if before["status"] != member.status:
                changes.append(f"your account status is now {member.status}")
            queue_security_notice(
                member,
                event_key=f"user-access:{member.id}:{revision}",
                subject="Your Vessel Caller access was updated",
                message="An administrator updated your access: " + "; ".join(changes) + ".",
            )
        return Response({"user": user_data(member), "rev": revision})

    @transaction.atomic
    def delete(self, request, user_id):
        organization = Organization.objects.select_for_update().get(pk=request.user.organization_id)
        member = (
            User.objects.select_for_update()
            .select_related("organization")
            .filter(pk=user_id, organization=organization)
            .first()
        )
        if not member:
            raise NotFound("User not found")
        if member.pk == request.user.pk:
            raise ValidationError("You cannot remove your own account")
        if member.role == User.Role.ADMIN and member.status == User.Status.ACTIVE:
            active_admins = User.objects.filter(
                organization=member.organization,
                role=User.Role.ADMIN,
                status=User.Status.ACTIVE,
            ).count()
            if active_admins <= 1:
                raise ValidationError("The organization must keep at least one active Admin")
        before = user_data(member)
        member.status = User.Status.REMOVED
        member.removed_at = timezone.now()
        member.email = f"removed+{member.id}@invalid.local"
        member.pending_email = ""
        member.save()
        revoke_sessions(member)
        revision = bump_revision(member.organization_id)
        record_event(
            organization=member.organization,
            actor=request.user,
            action="user.removed",
            category="identity",
            target=member,
            target_label=before["email"],
            request=request,
            before=before,
            after=user_data(member),
        )
        queue_security_notice(
            member,
            event_key=f"user-removed:{member.id}:{revision}",
            subject="Your Vessel Caller account was removed",
            message="An administrator removed your Vessel Caller account and signed out its sessions.",
            to_email=before["email"],
        )
        return Response({"ok": True, "rev": revision})


class UserPasswordResetDispatchView(APIView):
    permission_classes = [IsAuthenticated, HasVesselPermission]
    required_permission = "users.manage"

    def post(self, request, user_id):
        member = request.user.organization.users.filter(
            pk=user_id, status=User.Status.ACTIVE
        ).first()
        if not member:
            raise NotFound("User not found")
        token_obj, raw = issue_action_token(member, ActionToken.Kind.RESET_PASSWORD, hours=1)
        queue_email(
            to_email=member.email,
            subject="Reset your Vessel Caller password",
            template="reset_password",
            context={"actionUrl": f"{settings.FRONTEND_URL}/reset-password?token={raw}"},
            idempotency_key=f"reset:{token_obj.id}",
        )
        record_event(
            organization=member.organization,
            actor=request.user,
            action="user.password_reset_sent",
            category="identity",
            target=member,
            target_label=member.email,
            request=request,
        )
        return Response({"detail": "Password reset email sent"}, status=status.HTTP_202_ACCEPTED)


class UserMFAResetView(APIView):
    permission_classes = [IsAuthenticated, HasVesselPermission]
    required_permission = "users.manage"

    @transaction.atomic
    def post(self, request, user_id):
        member = request.user.organization.users.select_for_update().filter(pk=user_id).first()
        if not member:
            raise NotFound("User not found")
        if member.pk == request.user.pk:
            raise ValidationError("Use your Security settings to change your own MFA")
        member.mfa_secret = EMPTY_MFA_SECRET
        member.mfa_enabled_at = None
        member.mfa_grace_ends_at = timezone.now() + timedelta(days=settings.MFA_GRACE_DAYS)
        member.save(
            update_fields=("mfa_secret", "mfa_enabled_at", "mfa_grace_ends_at", "updated_at")
        )
        member.recovery_codes.all().delete()
        revoke_sessions(member)
        record_event(
            organization=member.organization,
            actor=request.user,
            action="user.mfa_reset",
            category="identity",
            target=member,
            target_label=member.email,
            request=request,
        )
        queue_security_notice(
            member,
            event_key=f"mfa-reset:{member.id}:{member.updated_at.isoformat()}",
            subject="Your Vessel Caller multi-factor authentication was reset",
            message="An administrator reset your multi-factor authentication and signed out your sessions.",
        )
        return Response({"user": user_data(member)})


class InvitationsView(APIView):
    permission_classes = [IsAuthenticated, HasVesselPermission]
    required_permission = "users.manage"

    def get(self, request):
        queryset = request.user.organization.invitations.select_related("invited_by")
        paginator = StandardPagination()
        page = paginator.paginate_queryset(queryset, request) or []
        return paginator.get_paginated_response([invitation_data(item) for item in page])

    @transaction.atomic
    def post(self, request):
        serializer = InvitationCreateSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data
        email = data["email"].lower()
        if User.objects.filter(email=email).exists():
            raise ValidationError({"email": ["A user with this email already exists"]})
        Invitation.objects.filter(
            organization=request.user.organization,
            email=email,
            status=Invitation.Status.PENDING,
        ).update(status=Invitation.Status.REVOKED, revoked_at=timezone.now())
        raw = opaque_token()
        invitation = Invitation.objects.create(
            organization=request.user.organization,
            name=data["name"].strip(),
            email=email,
            role=data["role"],
            token_hash=token_hash(raw),
            invited_by=request.user,
            expires_at=timezone.now() + timedelta(days=7),
        )
        queue_email(
            to_email=email,
            subject=f"Join {request.user.organization.name} on Vessel Caller",
            template="invitation",
            context={"actionUrl": f"{settings.FRONTEND_URL}/accept-invitation?token={raw}"},
            idempotency_key=f"invite:{invitation.id}",
        )
        revision = bump_revision(request.user.organization_id)
        record_event(
            organization=request.user.organization,
            actor=request.user,
            action="invitation.created",
            category="identity",
            target=invitation,
            target_label=email,
            request=request,
            after={"email": email, "role": invitation.role},
        )
        return Response(
            {"invitation": invitation_data(invitation), "rev": revision},
            status=status.HTTP_201_CREATED,
        )


class InvitationResendView(APIView):
    permission_classes = [IsAuthenticated, HasVesselPermission]
    required_permission = "users.manage"

    @transaction.atomic
    def post(self, request, invitation_id):
        invitation = (
            request.user.organization.invitations.select_for_update()
            .select_related("invited_by")
            .filter(pk=invitation_id, status=Invitation.Status.PENDING)
            .first()
        )
        if not invitation:
            raise NotFound("Invitation not found")
        raw = opaque_token()
        invitation.token_hash = token_hash(raw)
        invitation.expires_at = timezone.now() + timedelta(days=7)
        invitation.save(update_fields=("token_hash", "expires_at"))
        queue_email(
            to_email=invitation.email,
            subject=f"Join {request.user.organization.name} on Vessel Caller",
            template="invitation",
            context={"actionUrl": f"{settings.FRONTEND_URL}/accept-invitation?token={raw}"},
            idempotency_key=f"invite-resend:{invitation.id}:{secrets.token_hex(6)}",
        )
        return Response({"invitation": invitation_data(invitation)})


class InvitationDetailView(APIView):
    permission_classes = [IsAuthenticated, HasVesselPermission]
    required_permission = "users.manage"

    def delete(self, request, invitation_id):
        invitation = request.user.organization.invitations.filter(
            pk=invitation_id, status=Invitation.Status.PENDING
        ).first()
        if not invitation:
            raise NotFound("Invitation not found")
        invitation.status = Invitation.Status.REVOKED
        invitation.revoked_at = timezone.now()
        invitation.save(update_fields=("status", "revoked_at"))
        record_event(
            organization=request.user.organization,
            actor=request.user,
            action="invitation.revoked",
            category="identity",
            target=invitation,
            target_label=invitation.email,
            request=request,
        )
        return Response(status=status.HTTP_204_NO_CONTENT)


@method_decorator(csrf_protect, name="dispatch")
class InvitationAcceptView(APIView):
    authentication_classes = []
    permission_classes = [AllowAny]

    @transaction.atomic
    def post(self, request):
        serializer = InvitationAcceptSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        invitation = (
            Invitation.objects.select_for_update()
            .select_related("organization", "invited_by")
            .filter(
                token_hash=token_hash(serializer.validated_data["token"]),
                status=Invitation.Status.PENDING,
            )
            .first()
        )
        if not invitation or invitation.expires_at <= timezone.now():
            raise ValidationError({"token": ["This invitation is invalid or expired"]})
        if User.objects.filter(email=invitation.email).exists():
            raise ValidationError({"email": ["A user with this email already exists"]})
        user = User.objects.create_user(
            email=invitation.email,
            password=serializer.validated_data["password"],
            organization=invitation.organization,
            name=serializer.validated_data.get("name") or invitation.name,
            role=invitation.role,
            status=User.Status.ACTIVE,
            email_verified_at=timezone.now(),
            mfa_grace_ends_at=(
                timezone.now() + timedelta(days=settings.MFA_GRACE_DAYS)
                if invitation.role in {User.Role.ADMIN, User.Role.FINANCE}
                else None
            ),
        )
        invitation.status = Invitation.Status.ACCEPTED
        invitation.accepted_at = timezone.now()
        invitation.save(update_fields=("status", "accepted_at"))
        bump_revision(invitation.organization_id)
        record_event(
            organization=invitation.organization,
            actor=user,
            action="invitation.accepted",
            category="identity",
            target=user,
            target_label=user.email,
            request=request,
            after={"role": user.role},
        )
        queue_security_notice(
            invitation.invited_by,
            event_key=f"invitation-accepted:{invitation.id}",
            subject="A Vessel Caller invitation was accepted",
            message=f"{user.name} accepted the invitation to join {invitation.organization.name} as {user.role}.",
        )
        return Response({"detail": "Invitation accepted"}, status=status.HTTP_201_CREATED)


class AuditView(APIView):
    permission_classes = [IsAuthenticated, HasVesselPermission]
    required_permission = "audit.view"

    def get(self, request):
        queryset = AuditEvent.objects.filter(organization=request.user.organization).select_related(
            "actor"
        )
        action = request.query_params.get("action")
        if action:
            queryset = queryset.filter(action=action)
        actor = request.query_params.get("actor")
        if actor:
            queryset = queryset.filter(actor_id=actor)
        search = request.query_params.get("search", "").strip()
        if search:
            queryset = queryset.filter(
                Q(target_label__icontains=search)
                | Q(action__icontains=search)
                | Q(actor__email__icontains=search)
            )
        paginator = StandardPagination()
        page = paginator.paginate_queryset(queryset, request) or []
        return paginator.get_paginated_response([audit_data(item) for item in page])


class AuditExportView(APIView):
    permission_classes = [IsAuthenticated, HasVesselPermission]
    required_permission = "audit.export"

    def get(self, request):
        output = io.StringIO()
        writer = csv.writer(output)
        writer.writerow(
            [
                "occurred_at",
                "action",
                "category",
                "actor",
                "target_type",
                "target_id",
                "target_label",
                "request_id",
            ]
        )
        for event in AuditEvent.objects.filter(
            organization=request.user.organization
        ).select_related("actor"):
            writer.writerow(
                [
                    event.occurred_at.isoformat(),
                    csv_safe(event.action),
                    csv_safe(event.category),
                    csv_safe(event.actor.email if event.actor else ""),
                    csv_safe(event.target_type),
                    csv_safe(event.target_id),
                    csv_safe(event.target_label),
                    csv_safe(event.request_id),
                ]
            )
        response = HttpResponse(output.getvalue(), content_type="text/csv")
        response["Content-Disposition"] = 'attachment; filename="vessel-caller-audit.csv"'
        return response
