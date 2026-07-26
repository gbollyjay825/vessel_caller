from __future__ import annotations

import base64
import binascii
import hashlib
import json
import sqlite3
import tempfile
from datetime import datetime
from decimal import Decimal, ROUND_HALF_UP
from pathlib import Path

from django.core.files.base import ContentFile
from django.core.files.storage import default_storage
from django.core.management.base import BaseCommand, CommandError
from django.db import transaction
from django.utils import timezone
from django.utils.dateparse import parse_date, parse_datetime

from accounts.models import User
from billing.models import Invoice, NumberSequence, Payment
from operations.models import Inspection, VesselCall
from organizations.models import Organization, OrganizationSettings

EXPECTED_SCHEMA_FINGERPRINT = "031d952f0cc24632ad038e59684463d319cfe9d116e2441a4b347d8afdbafcd3"
TABLES = (
    "organizations",
    "users",
    "vessel_calls",
    "inspections",
    "invoices",
    "settings",
)
TABLE_QUERIES = {
    "organizations": 'SELECT * FROM "organizations" ORDER BY 1',
    "users": 'SELECT * FROM "users" ORDER BY 1',
    "vessel_calls": 'SELECT * FROM "vessel_calls" ORDER BY 1',
    "inspections": 'SELECT * FROM "inspections" ORDER BY 1',
    "invoices": 'SELECT * FROM "invoices" ORDER BY 1',
    "settings": 'SELECT * FROM "settings" ORDER BY 1',
}


def as_decimal(value, places="0.01") -> Decimal:
    return Decimal(str(value or 0)).quantize(Decimal(places), rounding=ROUND_HALF_UP)


def as_json(value, fallback=None):
    if value is None:
        return fallback
    if isinstance(value, (dict, list)):
        return value
    try:
        return json.loads(value)
    except (TypeError, json.JSONDecodeError):
        return fallback


def aware_datetime(value):
    if not value:
        return None
    parsed = parse_datetime(str(value))
    if not parsed:
        parsed_date = parse_date(str(value)[:10])
        parsed = datetime.combine(parsed_date, datetime.min.time()) if parsed_date else None
    if parsed and timezone.is_naive(parsed):
        parsed = timezone.make_aware(parsed, timezone.get_current_timezone())
    return parsed


def source_rows(connection, table):
    connection.row_factory = sqlite3.Row
    return [dict(row) for row in connection.execute(TABLE_QUERIES[table])]


def rows_checksum(rows):
    body = json.dumps(
        rows, sort_keys=True, separators=(",", ":"), ensure_ascii=False, default=str
    ).encode()
    return hashlib.sha256(body).hexdigest()


def ids_checksum(rows):
    body = json.dumps(
        [row[next(iter(row))] for row in rows],
        separators=(",", ":"),
        ensure_ascii=False,
        default=str,
    ).encode()
    return hashlib.sha256(body).hexdigest()


def schema_fingerprint(connection):
    sql = [
        row[0]
        for row in connection.execute(
            "SELECT sql FROM sqlite_master "
            "WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
        )
        if row[0]
    ]
    return hashlib.sha256("\n".join(sql).encode()).hexdigest()


class Command(BaseCommand):
    help = "Import a WAL-safe snapshot of the legacy SQLAlchemy SQLite database."

    def add_arguments(self, parser):
        parser.add_argument("source", type=Path)
        parser.add_argument("--allow-unknown-schema", action="store_true")
        parser.add_argument("--merge", action="store_true")
        parser.add_argument("--dry-run", action="store_true")
        parser.add_argument("--manifest", type=Path)

    def handle(self, *args, **options):
        source = options["source"].expanduser().resolve()
        if not source.is_file():
            raise CommandError(f"SQLite source not found: {source}")
        with tempfile.NamedTemporaryFile(suffix=".sqlite3") as snapshot_file:
            source_db = sqlite3.connect(f"file:{source}?mode=ro", uri=True)
            snapshot = sqlite3.connect(snapshot_file.name)
            try:
                source_db.backup(snapshot)
                result = snapshot.execute("PRAGMA integrity_check").fetchone()[0]
                if result != "ok":
                    raise CommandError(f"SQLite integrity check failed: {result}")
                fingerprint = schema_fingerprint(snapshot)
                if (
                    fingerprint != EXPECTED_SCHEMA_FINGERPRINT
                    and not options["allow_unknown_schema"]
                ):
                    raise CommandError(
                        f"Unknown SQLite schema fingerprint {fingerprint}; "
                        "use --allow-unknown-schema only after manual review"
                    )
                rows = {table: source_rows(snapshot, table) for table in TABLES}
            finally:
                snapshot.close()
                source_db.close()
        manifest = self._source_manifest(rows, fingerprint)
        if options["dry_run"]:
            manifest["mode"] = "dry-run"
        else:
            manifest["target"] = self._import(rows, merge=options["merge"])
            manifest["mode"] = "imported"
        encoded = json.dumps(manifest, indent=2, sort_keys=True)
        if options["manifest"]:
            options["manifest"].write_text(encoded + "\n", encoding="utf-8")
        self.stdout.write(encoded)

    def _source_manifest(self, rows, fingerprint):
        invoices = rows["invoices"]
        return {
            "schemaFingerprint": fingerprint,
            "expectedSchemaFingerprint": EXPECTED_SCHEMA_FINGERPRINT,
            "tables": {
                table: {
                    "count": len(table_rows),
                    "rowSha256": rows_checksum(table_rows),
                    "idSha256": ids_checksum(table_rows),
                }
                for table, table_rows in rows.items()
            },
            "financialTotals": {
                "dues": str(sum(as_decimal(row["dues"]) for row in invoices)),
                "commissionUsd": str(sum(as_decimal(row["commission_usd"]) for row in invoices)),
                "commissionNgn": str(sum(as_decimal(row["commission_ngn"]) for row in invoices)),
            },
        }

    @transaction.atomic
    def _import(self, rows, *, merge):
        if not merge and any(
            model.objects.exists()
            for model in (Organization, User, VesselCall, Inspection, Invoice)
        ):
            raise CommandError("Target database is not empty; use --merge after reconciliation")
        organization_by_id = {}
        for row in rows["organizations"]:
            logo_key = self._import_logo(row["id"], row.get("logo"))
            created = aware_datetime(row.get("created_at"))
            organization, _ = Organization.objects.update_or_create(
                id=row["id"],
                defaults={
                    "registered": bool(row.get("registered")),
                    "name": row.get("name") or "",
                    "rc_number": row.get("rc_number") or "",
                    "email": (row.get("email") or "").lower(),
                    "phone": row.get("phone") or "",
                    "address": row.get("address") or "",
                    "primary_port": row.get("primary_port") or "Port of Calabar",
                    "ports": as_json(row.get("ports"), []),
                    "logo_object_key": logo_key,
                    "revision": row.get("rev") or 0,
                },
            )
            if created:
                Organization.objects.filter(pk=organization.pk).update(created_at=created)
            organization_by_id[organization.id] = organization
        settings_by_org = {row["org_id"]: row for row in rows["settings"]}
        for org_id, organization in organization_by_id.items():
            row = settings_by_org.get(org_id, {})
            liquid = as_json(row.get("liquid_dues_rates"), {}) or {}
            OrganizationSettings.objects.update_or_create(
                organization=organization,
                defaults={
                    "commission_rate": as_decimal(row.get("commission_rate", 3.5), "0.0001"),
                    "exchange_rate": as_decimal(row.get("exchange_rate", 1600), "0.0001"),
                    "government_liquid_rate": as_decimal(liquid.get("government", 1.68), "0.0001"),
                    "private_liquid_rate": as_decimal(liquid.get("private", 2.88), "0.0001"),
                    "international_liquid_rate": as_decimal(
                        liquid.get("international", 4.23), "0.0001"
                    ),
                    "dry_dues_rate": as_decimal(row.get("dry_dues_rate", 2.17), "0.0001"),
                    "port_name": row.get("port_name") or organization.primary_port,
                    "terminals": as_json(row.get("terminals"), []),
                },
            )
        user_by_id = {}
        seen_emails = set()
        for row in rows["users"]:
            email = (row["email"] or "").strip().lower()
            if email in seen_emails:
                raise CommandError(f"Legacy data contains duplicate global email: {email}")
            seen_emails.add(email)
            created = aware_datetime(row.get("created_at")) or timezone.now()
            user, _ = User.objects.update_or_create(
                id=row["id"],
                defaults={
                    "organization": organization_by_id[row["org_id"]],
                    "name": row.get("name") or email,
                    "email": email,
                    "password": row["password_hash"],
                    "role": row.get("role") or User.Role.VIEWER,
                    "status": (User.Status.ACTIVE if row.get("active") else User.Status.SUSPENDED),
                    "email_verified_at": created,
                },
            )
            User.objects.filter(pk=user.pk).update(created_at=created)
            user_by_id[user.id] = user
        calls = {}
        for row in rows["vessel_calls"]:
            registered = aware_datetime(row.get("registered")) or timezone.now()
            call, _ = VesselCall.objects.update_or_create(
                id=row["id"],
                defaults={
                    "organization": organization_by_id[row["org_id"]],
                    "vessel_name": row.get("vessel_name") or "",
                    "reference": row.get("reference") or "",
                    "vessel_type": row.get("type") or "",
                    "flag": row.get("flag") or "",
                    "nrt": as_decimal(row.get("nrt"), "0.001"),
                    "eta": aware_datetime(row.get("eta")),
                    "sailing_eta": aware_datetime(row.get("sailing_eta")),
                    "berth": row.get("berth") or "",
                    "berth_date": parse_date(str(row.get("berth_date"))[:10])
                    if row.get("berth_date")
                    else None,
                    "status": row.get("status") or VesselCall.Status.PENDING,
                    "notes": row.get("notes") or "",
                    "created_by": user_by_id.get(row.get("created_by")),
                },
            )
            VesselCall.objects.filter(pk=call.pk).update(registered_at=registered)
            calls[call.id] = call
        inspections = {}
        for row in rows["inspections"]:
            completed = aware_datetime(row.get("date"))
            inspection, _ = Inspection.objects.update_or_create(
                id=row["id"],
                defaults={
                    "organization": organization_by_id[row["org_id"]],
                    "vessel_call": calls[row["call_id"]],
                    "reference": row.get("reference") or "",
                    "vessel_name": row.get("vessel_name") or "",
                    "cargo_type": row.get("cargo_type") or "Liquid",
                    "product": row.get("product") or "",
                    "reconciled_tonnage": as_decimal(row.get("reconciled_tonnage"), "0.001"),
                    "jetty": as_json(row.get("jetty")),
                    "liquid": as_json(row.get("liquid")),
                    "dry": as_json(row.get("dry")),
                    "status": row.get("status") or Inspection.Status.COMPLETED,
                    "completed_at": completed if row.get("status") == "completed" else None,
                    "created_by": user_by_id.get(row.get("created_by")),
                },
            )
            if completed:
                Inspection.objects.filter(pk=inspection.pk).update(created_at=completed)
            inspections[inspection.id] = inspection
        for row in rows["invoices"]:
            issued = parse_date(str(row.get("issued") or "")[:10]) or timezone.localdate()
            due = parse_date(str(row.get("due") or "")[:10]) or issued
            invoice, _ = Invoice.objects.update_or_create(
                id=row["id"],
                defaults={
                    "organization": organization_by_id[row["org_id"]],
                    "vessel_call": calls[row["call_id"]],
                    "inspection": inspections[row["inspection_id"]],
                    "invoice_no": row.get("invoice_no") or "",
                    "cargo_type": row.get("cargo_type") or "",
                    "issued_on": issued,
                    "due_on": due,
                    "status": row.get("status") or Invoice.Status.UNPAID,
                    "dues": as_decimal(row.get("dues")),
                    "rate": as_decimal(row.get("rate"), "0.0001"),
                    "commission_usd": as_decimal(row.get("commission_usd")),
                    "commission_ngn": as_decimal(row.get("commission_ngn")),
                    "exchange_rate": as_decimal(row.get("fx"), "0.0001"),
                },
            )
            payment = as_json(row.get("payment"))
            if payment:
                Payment.objects.update_or_create(
                    id="pay-" + hashlib.sha256(invoice.id.encode()).hexdigest()[:12],
                    defaults={
                        "invoice": invoice,
                        "amount": as_decimal(payment.get("amount", invoice.dues)),
                        "paid_on": parse_date(str(payment.get("paidOn", ""))[:10]) or issued,
                        "method": payment.get("method") or "Legacy import",
                        "reference": payment.get("reference") or f"legacy-{invoice.id}",
                        "recorded_by": user_by_id.get(payment.get("recordedBy"))
                        or next(
                            user
                            for user in user_by_id.values()
                            if user.organization_id == invoice.organization_id
                        ),
                    },
                )
        self._rebuild_sequences()
        target_counts = {
            "organizations": Organization.objects.filter(id__in=organization_by_id).count(),
            "users": User.objects.filter(id__in=user_by_id).count(),
            "vessel_calls": VesselCall.objects.filter(id__in=calls).count(),
            "inspections": Inspection.objects.filter(id__in=inspections).count(),
            "invoices": Invoice.objects.filter(
                id__in=[row["id"] for row in rows["invoices"]]
            ).count(),
            "settings": OrganizationSettings.objects.filter(
                organization_id__in=organization_by_id
            ).count(),
        }
        expected = {table: len(rows[table]) for table in TABLES}
        if target_counts != expected:
            raise CommandError(
                f"Reconciliation count mismatch: expected={expected} actual={target_counts}"
            )
        imported_invoices = Invoice.objects.filter(id__in=[row["id"] for row in rows["invoices"]])
        return {
            "counts": target_counts,
            "financialTotals": {
                "dues": str(sum((item.dues for item in imported_invoices), Decimal("0"))),
                "commissionUsd": str(
                    sum((item.commission_usd for item in imported_invoices), Decimal("0"))
                ),
                "commissionNgn": str(
                    sum((item.commission_ngn for item in imported_invoices), Decimal("0"))
                ),
            },
        }

    def _import_logo(self, organization_id, value):
        if not value or not str(value).startswith("data:image/"):
            return ""
        try:
            header, encoded = value.split(",", 1)
            extension = "png" if "png" in header else "jpg"
            key = f"organizations/{organization_id}/logo/legacy.{extension}"
            if not default_storage.exists(key):
                default_storage.save(key, ContentFile(base64.b64decode(encoded)))
            return key
        except (ValueError, binascii.Error):
            return ""

    def _rebuild_sequences(self):
        for organization in Organization.objects.all():
            for kind, prefix, values in (
                (
                    "invoice",
                    "INV",
                    organization.invoices.values_list("invoice_no", flat=True),
                ),
                (
                    "inspection",
                    "INS",
                    organization.inspections.values_list("reference", flat=True),
                ),
            ):
                by_year: dict[int, int] = {}
                for value in values:
                    parts = str(value).split("-")
                    if len(parts) == 3 and parts[0] == prefix:
                        try:
                            by_year[int(parts[1])] = max(
                                by_year.get(int(parts[1]), 0), int(parts[2])
                            )
                        except ValueError:
                            pass
                for year, top in by_year.items():
                    NumberSequence.objects.update_or_create(
                        organization=organization,
                        kind=kind,
                        year=year,
                        defaults={"value": top},
                    )
