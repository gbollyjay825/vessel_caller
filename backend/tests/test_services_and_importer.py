from __future__ import annotations

import json
import sqlite3
from datetime import timedelta
from pathlib import Path

import pytest
from django.core.cache import cache
from django.core.management import call_command, CommandError
from django.utils import timezone

from accounts.models import EmailOutbox, User
from accounts.services import queue_email
from accounts.tasks import deliver_outbox_email
from billing.models import Invoice, Payment
from operations.models import Inspection, VesselCall
from organizations.models import Organization, OrganizationSettings
from vessel_caller.sentry import (
    _before_breadcrumb,
    _before_send,
    _before_send_transaction,
    _strip_query,
)

pytestmark = pytest.mark.django_db


def test_transactional_outbox_memory_delivery(django_capture_on_commit_callbacks):
    organization = Organization.objects.create(name="Outbox Test Organization")
    with django_capture_on_commit_callbacks(execute=True):
        outbox = queue_email(
            to_email="recipient@example.test",
            subject="Test identity email",
            template="verify_email",
            context={"actionUrl": "https://example.test/verify"},
            idempotency_key="test-outbox-1",
            organization=organization,
        )
        assert "actionUrl" not in json.dumps(outbox.context)
        assert "ciphertext" in outbox.context
    outbox.refresh_from_db()
    assert outbox.status == EmailOutbox.Status.SENT
    assert outbox.context == {"redacted": True}
    delivered = cache.get("email:test-outbox-1")
    assert delivered["to"] == "recipient@example.test"
    assert "https://example.test/verify" in delivered["html"]
    assert deliver_outbox_email(str(outbox.id)) == outbox.provider_id


def test_sentry_redacts_request_and_user_data():
    event = {
        "request": {
            "headers": {
                "Authorization": "Bearer secret",
                "Cookie": "session=secret",
                "Accept": "application/json",
                "Referer": "https://vesselcalls.test/system?email=private@example.test",
            },
            "cookies": {"session": "secret"},
            "data": {"password": "secret"},
            "env": {"QUERY_STRING": "phone=08000000000"},
            "query_string": "search=RC-PRIVATE&email=private@example.test",
            "url": "https://vesselcalls.test/api/system/organizations?search=RC-PRIVATE#private",
        },
        "transaction": "/api/system/organizations?search=private@example.test",
        "breadcrumbs": {
            "values": [
                {
                    "category": "http",
                    "data": {
                        "url": "https://vesselcalls.test/api/system/audit?search=private@example.test",
                        "params": {"search": "private@example.test"},
                    },
                }
            ]
        },
        "spans": [{"description": "search=private@example.test"}],
        "user": {"id": "u-1", "email": "private@example.test"},
    }
    redacted = _before_send(event, {})
    assert redacted["request"]["headers"]["Authorization"] == "[REDACTED]"
    assert "cookies" not in redacted["request"]
    assert "data" not in redacted["request"]
    assert "env" not in redacted["request"]
    assert "query_string" not in redacted["request"]
    assert redacted["request"]["url"] == "https://vesselcalls.test/api/system/organizations"
    assert redacted["request"]["headers"]["Referer"] == "[REDACTED]"
    assert redacted["transaction"] == "/api/system/organizations"
    assert "spans" not in redacted
    assert redacted["user"] == {"id": "u-1"}
    assert "private@example.test" not in json.dumps(redacted)
    assert "08000000000" not in json.dumps(redacted)
    assert "RC-PRIVATE" not in json.dumps(redacted)
    transaction_redacted = _before_send_transaction(event, {})
    assert "private@example.test" not in json.dumps(transaction_redacted)
    breadcrumb = _before_breadcrumb(
        {
            "data": {
                "url": "https://vesselcalls.test/api/system/audit?search=private@example.test",
                "query_string": "search=private@example.test",
            }
        },
        {},
    )
    assert "private@example.test" not in json.dumps(breadcrumb)


def test_sentry_sanitizers_are_safe_for_non_platform_and_malformed_shapes():
    assert _strip_query(None) is None
    assert _strip_query("http://[invalid?secret=value") == "http://[invalid"
    event = {
        "request": {
            "headers": {},
            "url": "https://vesselcalls.test/api/health?probe=private",
        },
        "breadcrumbs": {"values": ["opaque", {"data": "not-a-mapping"}]},
        "spans": [{"description": "non-platform-span"}],
    }
    sanitized = _before_send(event, {})
    assert sanitized["request"]["url"] == "https://vesselcalls.test/api/health"
    assert sanitized["spans"] == [{"description": "non-platform-span"}]
    assert sanitized["breadcrumbs"]["values"] == ["opaque", {"data": "not-a-mapping"}]
    assert _before_send({}, {}) == {}


def create_legacy_database(path: Path):
    connection = sqlite3.connect(path)
    connection.executescript(
        """
        CREATE TABLE organizations (
          id TEXT PRIMARY KEY, registered BOOLEAN NOT NULL, name TEXT NOT NULL,
          rc_number TEXT, email TEXT, phone TEXT, address TEXT, primary_port TEXT,
          ports JSON, logo TEXT, rev INTEGER NOT NULL, created_at DATETIME
        );
        CREATE TABLE users (
          id TEXT PRIMARY KEY, org_id TEXT, name TEXT NOT NULL, email TEXT NOT NULL,
          password_hash TEXT NOT NULL, role TEXT NOT NULL, active BOOLEAN NOT NULL,
          created_at DATETIME
        );
        CREATE TABLE vessel_calls (
          id TEXT PRIMARY KEY, org_id TEXT, vessel_name TEXT NOT NULL, reference TEXT NOT NULL,
          type TEXT, flag TEXT, nrt FLOAT, eta TEXT, sailing_eta TEXT, berth TEXT,
          berth_date TEXT, status TEXT, notes TEXT, registered TEXT, created_by TEXT
        );
        CREATE TABLE inspections (
          id TEXT PRIMARY KEY, org_id TEXT, call_id TEXT, reference TEXT NOT NULL,
          vessel_name TEXT, cargo_type TEXT, product TEXT, reconciled_tonnage FLOAT,
          jetty JSON, liquid JSON, dry JSON, date TEXT, status TEXT, created_by TEXT
        );
        CREATE TABLE invoices (
          id TEXT PRIMARY KEY, org_id TEXT, call_id TEXT, inspection_id TEXT,
          invoice_no TEXT NOT NULL, cargo_type TEXT, issued TEXT, due TEXT, status TEXT,
          dues FLOAT, rate FLOAT, commission_usd FLOAT, commission_ngn FLOAT,
          fx FLOAT, payment JSON
        );
        CREATE TABLE settings (
          org_id TEXT PRIMARY KEY, commission_rate FLOAT, exchange_rate FLOAT,
          liquid_dues_rates JSON, dry_dues_rate FLOAT, port_name TEXT,
          terminals JSON, smtp JSON, sms JSON
        );
        """
    )
    connection.execute(
        "INSERT INTO organizations VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
        (
            "org-legacy",
            1,
            "Legacy Marine",
            "RC-1",
            "legacy@example.test",
            "",
            "",
            "Port of Calabar",
            json.dumps(["Port of Calabar"]),
            None,
            7,
            "2026-01-01T00:00:00+00:00",
        ),
    )
    connection.execute(
        "INSERT INTO users VALUES (?,?,?,?,?,?,?,?)",
        (
            "u-legacy",
            "org-legacy",
            "Legacy Admin",
            "legacy@example.test",
            "$pbkdf2-sha256$29000$salt$invalidbutpreserved",
            "Admin",
            1,
            "2026-01-01T00:00:00+00:00",
        ),
    )
    connection.execute(
        "INSERT INTO vessel_calls VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (
            "vc-legacy",
            "org-legacy",
            "MT Legacy",
            "ROT-LEGACY",
            "Tanker",
            "NG",
            1000.0,
            "2026-01-02T10:00:00+00:00",
            "",
            "Berth 1",
            "2026-01-02",
            "completed",
            "",
            "2026-01-01T10:00:00+00:00",
            "u-legacy",
        ),
    )
    connection.execute(
        "INSERT INTO inspections VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (
            "in-legacy",
            "org-legacy",
            "vc-legacy",
            "INS-2026-0004",
            "MT Legacy",
            "Liquid",
            "PMS",
            900.0,
            json.dumps({"type": "International"}),
            None,
            None,
            "2026-01-02T12:00:00+00:00",
            "completed",
            "u-legacy",
        ),
    )
    connection.execute(
        "INSERT INTO invoices VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (
            "iv-legacy",
            "org-legacy",
            "vc-legacy",
            "in-legacy",
            "INV-2026-0009",
            "Liquid",
            "2026-01-02",
            "2026-01-16",
            "paid",
            4230.0,
            4.23,
            148.05,
            236880.0,
            1600.0,
            json.dumps(
                {
                    "paidOn": "2026-01-10",
                    "method": "Transfer",
                    "reference": "LEGACY-PAY",
                    "amount": 4230.0,
                    "recordedBy": "u-legacy",
                }
            ),
        ),
    )
    connection.execute(
        "INSERT INTO settings VALUES (?,?,?,?,?,?,?,?,?)",
        (
            "org-legacy",
            3.5,
            1600.0,
            json.dumps({"government": 1.68, "private": 2.88, "international": 4.23}),
            2.17,
            "Port of Calabar",
            json.dumps(["Legacy Jetty"]),
            None,
            None,
        ),
    )
    connection.commit()
    connection.close()


def test_wal_safe_legacy_import_and_reconciliation(tmp_path):
    source = tmp_path / "legacy.sqlite3"
    manifest = tmp_path / "manifest.json"
    create_legacy_database(source)
    call_command(
        "import_legacy_sqlite",
        source,
        allow_unknown_schema=True,
        manifest=manifest,
    )
    assert Organization.objects.get(pk="org-legacy").revision == 7
    user = User.objects.get(pk="u-legacy")
    assert user.password.startswith("$pbkdf2-sha256$")
    assert VesselCall.objects.get(pk="vc-legacy").nrt == 1000
    jetty = Inspection.objects.get(pk="in-legacy").jetty
    assert isinstance(jetty, dict)
    assert jetty["type"] == "International"
    invoice = Invoice.objects.get(pk="iv-legacy")
    assert invoice.dues == 4230
    assert Payment.objects.get(invoice=invoice).reference == "LEGACY-PAY"
    assert float(
        OrganizationSettings.objects.get(organization_id="org-legacy").international_liquid_rate
    ) == pytest.approx(4.23)
    result = json.loads(manifest.read_text())
    assert result["mode"] == "imported"
    assert result["target"]["counts"] == {
        "organizations": 1,
        "users": 1,
        "vessel_calls": 1,
        "inspections": 1,
        "invoices": 1,
        "settings": 1,
    }


def test_seed_e2e_is_idempotent_with_explicit_local_password(settings):
    settings.DEBUG = True
    settings.ENVIRONMENT = "test"
    password = "Local-E2E-Strong-Password-2026!"
    call_command("seed_e2e", password=password)
    call_command("seed_e2e", password=password)
    assert User.objects.filter(email__endswith="@e2e.vesselcalls.test").count() == 4
    assert User.objects.get(email="admin@e2e.vesselcalls.test").check_password(password)


def test_seed_e2e_restores_existing_admin_fixture_mfa_grace(settings):
    settings.DEBUG = True
    settings.ENVIRONMENT = "test"
    password = "Local-E2E-Strong-Password-2026!"
    call_command("seed_e2e", password=password)
    admin = User.objects.get(email="admin@e2e.vesselcalls.test")
    admin.mfa_secret = "fixture-secret"
    admin.mfa_enabled_at = timezone.now()
    admin.mfa_grace_ends_at = timezone.now() - timedelta(days=1)
    admin.save()

    call_command("seed_e2e", password=password)

    admin.refresh_from_db()
    assert admin.mfa_secret == ""
    assert admin.mfa_enabled_at is None
    assert admin.mfa_grace_ends_at is not None
    assert admin.mfa_grace_ends_at > timezone.now()
    assert not admin.mfa_enrollment_required


def test_seed_e2e_requires_strong_protected_password(settings, monkeypatch):
    settings.DEBUG = False
    settings.ENVIRONMENT = "staging"
    monkeypatch.delenv("VC_E2E_PASSWORD", raising=False)
    with pytest.raises(CommandError, match="disabled outside DEBUG"):
        call_command("seed_e2e")

    with pytest.raises(CommandError, match="VC_E2E_PASSWORD is required"):
        call_command("seed_e2e", force=True)

    monkeypatch.setenv("VC_E2E_PASSWORD", "weak")
    with pytest.raises(CommandError, match="strength policy"):
        call_command("seed_e2e", force=True)

    with pytest.raises(CommandError, match="allowed only for local DEBUG"):
        call_command("seed_e2e", force=True, password="Local-E2E-Strong-Password-2026!")

    password = "Staging-E2E-Strong-Password-2026!"
    monkeypatch.setenv("VC_E2E_PASSWORD", password)
    call_command("seed_e2e", force=True)
    assert User.objects.get(email="admin@e2e.vesselcalls.test").check_password(password)


def test_seed_e2e_is_permanently_disabled_in_production(settings, monkeypatch):
    settings.DEBUG = True
    settings.ENVIRONMENT = "production"
    monkeypatch.setenv("VC_E2E_PASSWORD", "Production-E2E-Strong-Password-2026!")

    with pytest.raises(CommandError, match="permanently disabled in production"):
        call_command("seed_e2e", force=True)
