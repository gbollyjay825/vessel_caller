from __future__ import annotations

from decimal import Decimal

from django.contrib.auth.password_validation import validate_password
from rest_framework import serializers

from accounts.models import User


def number(value):
    if value is None:
        return None
    if isinstance(value, Decimal):
        return float(value)
    return value


def iso(value):
    return value.isoformat() if value else None


def user_data(user: User) -> dict:
    return {
        "id": user.id,
        "name": user.name,
        "email": user.email,
        "pendingEmail": user.pending_email or None,
        "role": user.role,
        "status": user.status,
        "active": user.is_active,
        "emailVerified": bool(user.email_verified_at),
        "mfaEnabled": user.mfa_enabled,
        "mfaGraceEndsAt": iso(user.mfa_grace_ends_at),
        "mfaEnrollmentRequired": user.mfa_enrollment_required,
        "lastLogin": iso(user.last_login),
        "createdAt": iso(user.created_at),
    }


def organization_data(organization, *, members=None) -> dict:
    payload = {
        "id": organization.id,
        "registered": organization.registered,
        "name": organization.name,
        "rcNumber": organization.rc_number,
        "email": organization.email,
        "phone": organization.phone,
        "address": organization.address,
        "designatedPort": organization.primary_port,
        "primaryPort": organization.primary_port,
        "ports": organization.ports or [],
        "logo": organization.logo_object_key or None,
        "rev": organization.revision,
    }
    if members is not None:
        payload["members"] = [user_data(item) for item in members]
    return payload


def settings_data(settings_obj) -> dict:
    return {
        "commissionRate": number(settings_obj.commission_rate),
        "exchangeRate": number(settings_obj.exchange_rate),
        "liquidDuesRates": {
            "government": number(settings_obj.government_liquid_rate),
            "private": number(settings_obj.private_liquid_rate),
            "international": number(settings_obj.international_liquid_rate),
        },
        "dryDuesRate": number(settings_obj.dry_dues_rate),
        "portName": settings_obj.port_name,
        "terminals": settings_obj.terminals or [],
    }


def call_data(call) -> dict:
    return {
        "id": call.id,
        "vesselName": call.vessel_name,
        "reference": call.reference,
        "type": call.vessel_type,
        "flag": call.flag,
        "nrt": number(call.nrt),
        "eta": iso(call.eta) or "",
        "sailingEta": iso(call.sailing_eta) or "",
        "berth": call.berth,
        "berthDate": iso(call.berth_date),
        "status": call.status,
        "notes": call.notes,
        "cancellationReason": call.cancellation_reason or None,
        "cancelledAt": iso(call.cancelled_at),
        "version": call.version,
        "registered": iso(call.registered_at),
    }


def inspection_data(inspection) -> dict:
    return {
        "id": inspection.id,
        "reference": inspection.reference,
        "callId": inspection.vessel_call_id,
        "vesselName": inspection.vessel_name,
        "cargoType": inspection.cargo_type,
        "product": inspection.product or None,
        "reconciledTonnage": number(inspection.reconciled_tonnage),
        "jetty": inspection.jetty,
        "liquid": inspection.liquid,
        "dry": inspection.dry,
        "date": iso(inspection.completed_at or inspection.created_at),
        "status": inspection.status,
        "version": inspection.version,
        "createdAt": iso(inspection.created_at),
        "updatedAt": iso(inspection.updated_at),
    }


def payment_data(payment) -> dict:
    return {
        "id": payment.id,
        "amount": number(payment.amount),
        "paidOn": iso(payment.paid_on),
        "method": payment.method,
        "reference": payment.reference,
        "recordedBy": payment.recorded_by_id,
        "recordedAt": iso(payment.recorded_at),
        "reversedAt": iso(payment.reversed_at),
        "reversedBy": payment.reversed_by_id,
        "reversalReason": payment.reversal_reason or None,
    }


def invoice_data(invoice) -> dict:
    current = invoice.payments.filter(reversed_at__isnull=True).first()
    return {
        "id": invoice.id,
        "invoiceNo": invoice.invoice_no,
        "callId": invoice.vessel_call_id,
        "inspectionId": invoice.inspection_id,
        "cargoType": invoice.cargo_type,
        "issued": iso(invoice.issued_on),
        "due": iso(invoice.due_on),
        "status": invoice.status,
        "dues": number(invoice.dues),
        "rate": number(invoice.rate),
        "commissionUsd": number(invoice.commission_usd),
        "commissionNgn": number(invoice.commission_ngn),
        "fx": number(invoice.exchange_rate),
        "payment": payment_data(current) if current else None,
    }


def invitation_data(invitation) -> dict:
    inviter = invitation.invited_by
    return {
        "id": invitation.id,
        "name": invitation.name,
        "email": invitation.email,
        "role": invitation.role,
        "status": invitation.status,
        "expiresAt": iso(invitation.expires_at),
        "createdAt": iso(invitation.created_at),
        "acceptedAt": iso(invitation.accepted_at),
        "revokedAt": iso(invitation.revoked_at),
        "invitedBy": {
            "id": inviter.id,
            "name": inviter.name,
            "email": inviter.email,
        },
    }


def evidence_data(evidence) -> dict:
    return {
        "id": evidence.id,
        "inspectionId": evidence.inspection_id,
        "objectKey": evidence.object_key,
        "fileName": evidence.file_name,
        "contentType": evidence.content_type,
        "size": evidence.size,
        "checksum": evidence.checksum or None,
        "uploadedBy": evidence.uploaded_by_id,
        "createdAt": iso(evidence.created_at),
    }


def audit_data(event) -> dict:
    actor = event.actor
    return {
        "id": str(event.id),
        "action": event.action,
        "category": event.category,
        "actor": ({"id": actor.id, "name": actor.name, "email": actor.email} if actor else None),
        "targetType": event.target_type,
        "targetId": event.target_id,
        "targetLabel": event.target_label,
        "occurredAt": iso(event.occurred_at),
        "requestId": event.request_id,
        "ipAddress": event.ip_address,
        "before": event.before,
        "after": event.after,
    }


class PasswordField(serializers.CharField):
    def __init__(self, **kwargs):
        kwargs.setdefault("write_only", True)
        kwargs.setdefault("trim_whitespace", False)
        super().__init__(**kwargs)

    def run_validation(self, data=serializers.empty):
        value = super().run_validation(data)
        validate_password(value)
        return value


class RegisterSerializer(serializers.Serializer):
    name = serializers.CharField(max_length=255)
    email = serializers.EmailField()
    password = PasswordField()
    orgName = serializers.CharField(max_length=255)
    rcNumber = serializers.CharField(max_length=100, required=False, allow_blank=True)
    phone = serializers.CharField(max_length=50, required=False, allow_blank=True)
    address = serializers.CharField(required=False, allow_blank=True)
    designatedPort = serializers.CharField(max_length=255, default="Port of Calabar")
    ports = serializers.ListField(child=serializers.CharField(max_length=255), required=False)


class LoginSerializer(serializers.Serializer):
    email = serializers.EmailField()
    password = serializers.CharField(trim_whitespace=False)


class TokenSerializer(serializers.Serializer):
    token = serializers.CharField()


class ForgotPasswordSerializer(serializers.Serializer):
    email = serializers.EmailField()


class ResetPasswordSerializer(TokenSerializer):
    password = PasswordField()


class ChangePasswordSerializer(serializers.Serializer):
    currentPassword = serializers.CharField(trim_whitespace=False)
    password = PasswordField()


class InvitationCreateSerializer(serializers.Serializer):
    name = serializers.CharField(max_length=255)
    email = serializers.EmailField()
    role = serializers.ChoiceField(choices=User.Role.values)


class InvitationAcceptSerializer(TokenSerializer):
    name = serializers.CharField(max_length=255, required=False)
    password = PasswordField()


class UserPatchSerializer(serializers.Serializer):
    name = serializers.CharField(max_length=255, required=False)
    role = serializers.ChoiceField(choices=User.Role.values, required=False)
    status = serializers.ChoiceField(
        choices=[User.Status.ACTIVE, User.Status.SUSPENDED], required=False
    )


class ProfilePatchSerializer(serializers.Serializer):
    name = serializers.CharField(max_length=255, required=False)
    email = serializers.EmailField(required=False)
    currentPassword = serializers.CharField(
        required=False,
        allow_blank=True,
        trim_whitespace=False,
        write_only=True,
    )


class VesselCallSerializer(serializers.Serializer):
    vesselName = serializers.CharField(max_length=255, required=False)
    reference = serializers.CharField(max_length=100, required=False)
    type = serializers.CharField(max_length=100, required=False, allow_blank=True)
    flag = serializers.CharField(max_length=100, required=False, allow_blank=True)
    nrt = serializers.DecimalField(max_digits=16, decimal_places=3, min_value=0, required=False)
    eta = serializers.DateTimeField(required=False, allow_null=True)
    sailingEta = serializers.DateTimeField(required=False, allow_null=True)
    berth = serializers.CharField(max_length=255, required=False, allow_blank=True)
    berthDate = serializers.DateField(required=False, allow_null=True)
    status = serializers.ChoiceField(
        choices=["pending", "in-progress", "completed"], required=False
    )
    notes = serializers.CharField(required=False, allow_blank=True)
    version = serializers.IntegerField(min_value=1, required=False)


class CancelSerializer(serializers.Serializer):
    reason = serializers.CharField(min_length=3)
    version = serializers.IntegerField(min_value=1, required=False)


class InspectionSerializer(serializers.Serializer):
    callId = serializers.CharField(required=False)
    cargoType = serializers.ChoiceField(choices=["Liquid", "Dry"], required=False)
    product = serializers.CharField(required=False, allow_blank=True, allow_null=True)
    reconciledTonnage = serializers.DecimalField(
        max_digits=16, decimal_places=3, min_value=0, required=False
    )
    jetty = serializers.JSONField(required=False, allow_null=True)
    liquid = serializers.JSONField(required=False, allow_null=True)
    dry = serializers.JSONField(required=False, allow_null=True)
    version = serializers.IntegerField(min_value=1, required=False)
    status = serializers.ChoiceField(choices=["draft", "completed"], required=False)


class PaymentCreateSerializer(serializers.Serializer):
    amount = serializers.DecimalField(
        max_digits=18, decimal_places=2, min_value=Decimal("0.01"), required=False
    )
    paidOn = serializers.DateField()
    method = serializers.CharField(max_length=100)
    reference = serializers.CharField(max_length=255)


class ReversalSerializer(serializers.Serializer):
    reason = serializers.CharField(min_length=3)


class EvidencePresignSerializer(serializers.Serializer):
    inspectionId = serializers.CharField()
    fileName = serializers.CharField(max_length=255)
    contentType = serializers.ChoiceField(choices=["image/jpeg", "image/png", "image/webp"])
    size = serializers.IntegerField(min_value=1, max_value=15 * 1024 * 1024)
    checksum = serializers.RegexField(regex=r"^sha256:[0-9a-f]{64}$")


class EvidenceFinalizeSerializer(EvidencePresignSerializer):
    objectKey = serializers.CharField(max_length=1024)
