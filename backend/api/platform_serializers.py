from __future__ import annotations

from rest_framework import serializers

from accounts.models import User

from .serializers import iso, user_data


class SystemOrganizationCreateSerializer(serializers.Serializer):
    name = serializers.CharField(max_length=255)
    rcNumber = serializers.CharField(max_length=100, required=False, allow_blank=True)
    email = serializers.EmailField(required=False, allow_blank=True)
    phone = serializers.CharField(max_length=50, required=False, allow_blank=True)
    address = serializers.CharField(required=False, allow_blank=True)
    primaryPort = serializers.CharField(max_length=255, default="Port of Calabar")
    ports = serializers.ListField(child=serializers.CharField(max_length=255), required=False)
    initialAdmin = serializers.DictField()

    def validate_initialAdmin(self, value):
        serializer = SystemAdminInvitationSerializer(data=value)
        serializer.is_valid(raise_exception=True)
        return serializer.validated_data

    def validate_ports(self, value):
        return canonical_ports(value)

    def validate(self, attrs):
        primary = attrs["primaryPort"].strip()
        ports = list(attrs.get("ports") or [])
        if primary.casefold() not in {item.casefold() for item in ports}:
            ports.append(primary)
        attrs["primaryPort"] = primary
        attrs["ports"] = ports
        return attrs


class SystemOrganizationUpdateSerializer(serializers.Serializer):
    name = serializers.CharField(max_length=255, required=False)
    rcNumber = serializers.CharField(max_length=100, required=False, allow_blank=True)
    email = serializers.EmailField(required=False, allow_blank=True)
    phone = serializers.CharField(max_length=50, required=False, allow_blank=True)
    address = serializers.CharField(required=False, allow_blank=True)
    primaryPort = serializers.CharField(max_length=255, required=False)
    ports = serializers.ListField(child=serializers.CharField(max_length=255), required=False)
    revision = serializers.IntegerField(min_value=0)

    def validate_ports(self, value):
        return canonical_ports(value)


class SystemOrganizationLifecycleSerializer(serializers.Serializer):
    reason = serializers.CharField(min_length=3, max_length=1000)
    revision = serializers.IntegerField(min_value=0)


class SystemAdminInvitationSerializer(serializers.Serializer):
    name = serializers.CharField(max_length=255)
    email = serializers.EmailField()


class SystemUserActionSerializer(serializers.Serializer):
    reason = serializers.CharField(min_length=3, max_length=1000)


def canonical_ports(values) -> list[str]:
    result = []
    seen = set()
    for raw in values:
        value = raw.strip()
        if not value:
            raise serializers.ValidationError("Port names cannot be blank")
        key = value.casefold()
        if key in seen:
            raise serializers.ValidationError("Port names must be unique")
        seen.add(key)
        result.append(value)
    return result


def _system_organization_counts(organization) -> dict:
    def annotated_or_count(attribute, queryset):
        value = getattr(organization, attribute, None)
        return value if value is not None else queryset.count()

    return {
        "userCount": annotated_or_count("user_count", organization.users),
        "activeUserCount": annotated_or_count(
            "active_user_count",
            organization.users.filter(status=User.Status.ACTIVE),
        ),
        "adminCount": annotated_or_count(
            "admin_count",
            organization.users.filter(role=User.Role.ADMIN, status=User.Status.ACTIVE),
        ),
        "pendingInvitationCount": annotated_or_count(
            "pending_invitation_count",
            organization.invitations.filter(
                status="pending",
                role=User.Role.ADMIN,
            ),
        ),
    }


def system_organization_summary_data(organization) -> dict:
    """Return the minimum organization metadata needed for bulk control-plane views."""

    return {
        "id": organization.id,
        "name": organization.name,
        "status": organization.access_status,
        "registered": organization.registered,
        "primaryPort": organization.primary_port,
        "createdAt": iso(organization.created_at),
        "updatedAt": iso(organization.updated_at),
        **_system_organization_counts(organization),
    }


def system_organization_data(organization) -> dict:
    return {
        **system_organization_summary_data(organization),
        "rcNumber": organization.rc_number,
        "email": organization.email,
        "phone": organization.phone,
        "address": organization.address,
        "ports": organization.ports or [],
        "revision": organization.revision,
        "suspendedAt": iso(organization.suspended_at),
        "suspensionReason": organization.suspension_reason or None,
    }


def system_audit_data(event) -> dict:
    actor = event.actor
    return {
        "id": str(event.id),
        "action": event.action,
        "category": "platform",
        "actor": ({"id": actor.id, "name": actor.name, "email": actor.email} if actor else None),
        "organizationId": event.organization_id,
        "organizationName": event.organization.name,
        "targetType": event.target_type,
        "targetId": event.target_id,
        "targetLabel": event.target_label,
        "reason": event.reason or None,
        "occurredAt": iso(event.occurred_at),
        "requestId": event.request_id,
        "ipAddress": event.ip_address,
        "before": event.before,
        "after": event.after,
    }


def system_user_data(user: User) -> dict:
    return user_data(user)
