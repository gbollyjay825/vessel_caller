from __future__ import annotations

from django.db import transaction
from django.utils import timezone
from django.utils.decorators import method_decorator
from django.views.decorators.csrf import csrf_protect
from rest_framework import serializers, status
from rest_framework.exceptions import NotFound, ValidationError
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.response import Response

from accounts.models import OrganizationJoinRequest, User
from accounts.organization_join import (
    JoinFlowError,
    create_signup_link,
    resolve_signup_link,
    review_join_request,
    submit_join_request,
    verify_join_request,
)
from audit.services import record_event

from .auth_views import _consume_public_budget
from .domain import bump_revision
from .pagination import StandardPagination
from .permissions import HasVesselPermission
from .serializers import PasswordField, iso, user_data
from .tenant_lifecycle import TenantLifecycleAPIView as APIView


class SignupLinkCreateSerializer(serializers.Serializer):
    expiresInDays = serializers.ChoiceField(choices=[1, 7, 14, 30], default=7)


class JoinTokenSerializer(serializers.Serializer):
    token = serializers.CharField(max_length=256, trim_whitespace=False)


class JoinSubmitSerializer(JoinTokenSerializer):
    name = serializers.CharField(max_length=255)
    email = serializers.EmailField(max_length=254)


class JoinVerifySerializer(JoinTokenSerializer):
    password = PasswordField(max_length=128)


class JoinApproveSerializer(serializers.Serializer):
    role = serializers.ChoiceField(choices=User.Role.values, default=User.Role.OPERATIONS)


def signup_link_data(link):
    return {
        "id": link.id,
        "organizationId": link.organization_id,
        "createdAt": iso(link.created_at),
        "expiresAt": iso(link.expires_at),
        "revokedAt": iso(link.revoked_at),
        "status": "revoked" if link.revoked_at else ("active" if link.active else "expired"),
        "createdBy": {"id": link.created_by_id, "name": link.created_by.name},
    }


def join_request_data(item):
    display_status = item.status
    if item.status == OrganizationJoinRequest.Status.UNVERIFIED and (
        item.verification_expires_at <= timezone.now() or not item.signup_link.active
    ):
        display_status = OrganizationJoinRequest.Status.EXPIRED
    return {
        "id": item.id,
        "name": item.name,
        "email": item.email,
        "status": display_status,
        "createdAt": iso(item.created_at),
        "emailVerifiedAt": iso(item.email_verified_at),
        "reviewedAt": iso(item.reviewed_at),
        "role": item.role or None,
    }


def public_join_error(error):
    messages = {
        "This sign-up link is invalid, expired or revoked": "This sign-up link is invalid, expired or revoked",
        "This verification link is invalid or expired": "This verification link is invalid or expired",
        "Only an active organization Admin can create a sign-up link": "Only an active organization Admin can create a sign-up link",
        "Choose a link lifetime of 1, 7, 14 or 30 days": "Choose a link lifetime of 1, 7, 14 or 30 days",
        "Only an active organization Admin can review join requests": "Only an active organization Admin can review join requests",
        "This request was already approved with a different role": "This request was already approved with a different role",
        "Only a verified request awaiting review can be reviewed": "Only a verified request awaiting review can be reviewed",
        "Choose a valid role": "Choose a valid role",
        "An account already uses this email. Review existing users instead.": "An account already uses this email. Review existing users instead.",
    }
    return messages.get(str(error), "The organization join request could not be completed")


class OrganizationSignupLinksView(APIView):
    permission_classes = [IsAuthenticated, HasVesselPermission]
    required_permission = "users.manage"

    def get(self, request):
        paginator = StandardPagination()
        page = (
            paginator.paginate_queryset(
                request.user.organization.signup_links.select_related("created_by"), request
            )
            or []
        )
        return paginator.get_paginated_response([signup_link_data(link) for link in page])

    def post(self, request):
        serializer = SignupLinkCreateSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        try:
            link, signup_url = create_signup_link(
                actor=request.user,
                expires_in_days=serializer.validated_data["expiresInDays"],
                request=request,
            )
        except JoinFlowError as exc:
            raise ValidationError(public_join_error(exc)) from exc
        return Response(
            {
                "link": signup_link_data(link),
                "signupUrl": signup_url,
                "rev": bump_revision(request.user.organization_id),
            },
            status=status.HTTP_201_CREATED,
        )


class OrganizationSignupLinkDetailView(APIView):
    permission_classes = [IsAuthenticated, HasVesselPermission]
    required_permission = "users.manage"

    @transaction.atomic
    def delete(self, request, link_id):
        link = request.user.organization.signup_links.select_for_update().filter(pk=link_id).first()
        if not link:
            raise NotFound("Sign-up link not found")
        if link.revoked_at is None:
            link.revoked_at = timezone.now()
            link.save(update_fields=("revoked_at",))
            bump_revision(request.user.organization_id)
            record_event(
                organization=request.user.organization,
                actor=request.user,
                action="organization_signup_link.revoked",
                category="identity",
                target=link,
                request=request,
            )
        return Response(status=status.HTTP_204_NO_CONTENT)


@method_decorator(csrf_protect, name="dispatch")
class PublicOrganizationJoinResolveView(APIView):
    authentication_classes = []
    permission_classes = [AllowAny]

    def post(self, request):
        serializer = JoinTokenSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        raw = serializer.validated_data["token"]
        if not _consume_public_budget(
            "organization-join-resolve", raw, request, account_limit=100, ip_limit=100
        ):
            return Response(
                {"detail": "Please try again later"}, status=status.HTTP_429_TOO_MANY_REQUESTS
            )
        try:
            organization, link = resolve_signup_link(raw)
        except JoinFlowError as exc:
            raise ValidationError({"token": [public_join_error(exc)]}) from exc
        return Response(
            {"organization": {"name": organization.name}, "expiresAt": iso(link.expires_at)}
        )


@method_decorator(csrf_protect, name="dispatch")
class PublicOrganizationJoinView(APIView):
    authentication_classes = []
    permission_classes = [AllowAny]

    def post(self, request):
        serializer = JoinSubmitSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data
        response = {
            "detail": "Check your email to verify your request. Access requires administrator approval."
        }
        if not _consume_public_budget(
            "organization-join", data["email"], request, account_limit=5, ip_limit=20
        ):
            return Response(response, status=status.HTTP_202_ACCEPTED)
        try:
            submit_join_request(
                raw=data["token"], name=data["name"], email=data["email"], request=request
            )
        except JoinFlowError as exc:
            raise ValidationError({"token": [public_join_error(exc)]}) from exc
        return Response(response, status=status.HTTP_202_ACCEPTED)


@method_decorator(csrf_protect, name="dispatch")
class PublicOrganizationJoinVerifyView(APIView):
    authentication_classes = []
    permission_classes = [AllowAny]

    def post(self, request):
        serializer = JoinVerifySerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        raw = serializer.validated_data["token"]
        if not _consume_public_budget(
            "organization-join-verify", raw, request, account_limit=10, ip_limit=40
        ):
            return Response(
                {"detail": "Please try again later"}, status=status.HTTP_429_TOO_MANY_REQUESTS
            )
        try:
            verify_join_request(
                raw=raw, password=serializer.validated_data["password"], request=request
            )
        except JoinFlowError as exc:
            raise ValidationError({"token": [public_join_error(exc)]}) from exc
        return Response(
            {"detail": "Email verified. Your request is awaiting administrator approval."}
        )


class OrganizationJoinRequestsView(APIView):
    permission_classes = [IsAuthenticated, HasVesselPermission]
    required_permission = "users.manage"

    def get(self, request):
        queryset = request.user.organization.join_requests.select_related("signup_link")
        selected_status = request.query_params.get("status", OrganizationJoinRequest.Status.PENDING)
        if selected_status != "all":
            if selected_status not in OrganizationJoinRequest.Status.values:
                raise ValidationError({"status": ["Choose a valid request status"]})
            queryset = queryset.filter(status=selected_status)
        paginator = StandardPagination()
        page = paginator.paginate_queryset(queryset, request) or []
        return paginator.get_paginated_response([join_request_data(item) for item in page])


class OrganizationJoinRequestApproveView(APIView):
    permission_classes = [IsAuthenticated, HasVesselPermission]
    required_permission = "users.manage"

    def post(self, request, request_id):
        serializer = JoinApproveSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        try:
            member_request, changed = review_join_request(
                actor=request.user,
                request_id=request_id,
                approve=True,
                role=serializer.validated_data["role"],
                request=request,
            )
        except JoinFlowError as exc:
            if str(exc) == "Join request not found":
                raise NotFound("Join request not found") from exc
            raise ValidationError(public_join_error(exc)) from exc
        revision = (
            bump_revision(request.user.organization_id)
            if changed
            else request.user.organization.revision
        )
        return Response(
            {
                "request": join_request_data(member_request),
                "user": user_data(member_request.user),
                "rev": revision,
            }
        )


class OrganizationJoinRequestRejectView(APIView):
    permission_classes = [IsAuthenticated, HasVesselPermission]
    required_permission = "users.manage"

    def post(self, request, request_id):
        try:
            member_request, changed = review_join_request(
                actor=request.user, request_id=request_id, approve=False, request=request
            )
        except JoinFlowError as exc:
            if str(exc) == "Join request not found":
                raise NotFound("Join request not found") from exc
            raise ValidationError(public_join_error(exc)) from exc
        revision = (
            bump_revision(request.user.organization_id)
            if changed
            else request.user.organization.revision
        )
        return Response({"request": join_request_data(member_request), "rev": revision})
