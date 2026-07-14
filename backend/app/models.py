"""Relational schema. A proper set of tables (users, organizations, vessel
calls, inspections, invoices, settings) — replacing the old JSON doc-store.

Multi-tenant: every row is scoped by org_id. A per-org `rev` counter powers
the frontend's change-polling. Money is snapshotted onto invoices at issue
time so changing tariff rates never rewrites issued figures.
"""
from datetime import datetime, timezone

from sqlalchemy import (
    Boolean, Column, DateTime, Float, ForeignKey, Integer, JSON, String, Text,
    UniqueConstraint,
)

from .db import Base

ROLES = ("Admin", "Operations", "Finance", "Viewer")


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class Organization(Base):
    __tablename__ = "organizations"
    id = Column(String, primary_key=True)
    registered = Column(Boolean, default=True, nullable=False)
    name = Column(String, default="", nullable=False)
    rc_number = Column(String, default="")
    email = Column(String, default="")
    phone = Column(String, default="")
    address = Column(String, default="")
    primary_port = Column(String, default="Port of Calabar")
    ports = Column(JSON, default=list)          # list[str] of operating ports
    logo = Column(Text, nullable=True)          # data-URL PNG, optional
    rev = Column(Integer, default=0, nullable=False)
    created_at = Column(DateTime, default=utcnow)


class User(Base):
    __tablename__ = "users"
    __table_args__ = (UniqueConstraint("org_id", "email", name="uq_user_org_email"),)
    id = Column(String, primary_key=True)
    org_id = Column(String, ForeignKey("organizations.id", ondelete="CASCADE"), index=True)
    name = Column(String, nullable=False)
    email = Column(String, nullable=False, index=True)
    password_hash = Column(String, nullable=False)
    role = Column(String, default="Viewer", nullable=False)   # one of ROLES
    active = Column(Boolean, default=True, nullable=False)
    created_at = Column(DateTime, default=utcnow)


class VesselCall(Base):
    __tablename__ = "vessel_calls"
    __table_args__ = (UniqueConstraint("org_id", "reference", name="uq_call_org_ref"),)
    id = Column(String, primary_key=True)
    org_id = Column(String, ForeignKey("organizations.id", ondelete="CASCADE"), index=True)
    vessel_name = Column(String, nullable=False)
    reference = Column(String, nullable=False)          # rotation number
    type = Column(String, default="")
    flag = Column(String, default="")
    nrt = Column(Float, default=0)                      # net registered tonnage
    eta = Column(String, default="")                    # ISO datetime-local string
    sailing_eta = Column(String, default="")
    berth = Column(String, default="")
    berth_date = Column(String, nullable=True)
    status = Column(String, default="pending")          # pending|in-progress|completed
    notes = Column(String, default="")
    registered = Column(String, default="")             # ISO string (matches UI)
    created_by = Column(String, nullable=True)


class Inspection(Base):
    __tablename__ = "inspections"
    id = Column(String, primary_key=True)
    org_id = Column(String, ForeignKey("organizations.id", ondelete="CASCADE"), index=True)
    call_id = Column(String, ForeignKey("vessel_calls.id", ondelete="CASCADE"), index=True)
    reference = Column(String, nullable=False)
    vessel_name = Column(String, default="")
    cargo_type = Column(String, default="Liquid")       # Liquid | Dry
    product = Column(String, nullable=True)             # PMS | AGO | DPK (liquid)
    reconciled_tonnage = Column(Float, default=0)
    jetty = Column(JSON, nullable=True)                 # {type, category, name}
    liquid = Column(JSON, nullable=True)
    dry = Column(JSON, nullable=True)
    date = Column(String, default="")                   # ISO string
    status = Column(String, default="completed")        # draft | completed
    created_by = Column(String, nullable=True)


class Invoice(Base):
    __tablename__ = "invoices"
    id = Column(String, primary_key=True)
    org_id = Column(String, ForeignKey("organizations.id", ondelete="CASCADE"), index=True)
    call_id = Column(String, ForeignKey("vessel_calls.id", ondelete="CASCADE"), index=True)
    inspection_id = Column(String, ForeignKey("inspections.id", ondelete="SET NULL"), nullable=True)
    invoice_no = Column(String, nullable=False)
    cargo_type = Column(String, default="")
    issued = Column(String, default="")                 # ISO string
    due = Column(String, default="")
    status = Column(String, default="unpaid")           # unpaid | paid (overdue derived)
    # money snapshot — locked at issue time
    dues = Column(Float, default=0)
    rate = Column(Float, default=0)
    commission_usd = Column(Float, default=0)
    commission_ngn = Column(Float, default=0)
    fx = Column(Float, default=0)
    payment = Column(JSON, nullable=True)               # {paidOn, method, reference, amount, recordedBy}


class Settings(Base):
    __tablename__ = "settings"
    org_id = Column(String, ForeignKey("organizations.id", ondelete="CASCADE"), primary_key=True)
    commission_rate = Column(Float, default=3.5)
    exchange_rate = Column(Float, default=1600)
    liquid_dues_rates = Column(JSON, default=lambda: {"government": 1.68, "private": 2.88, "international": 4.23})
    dry_dues_rate = Column(Float, default=2.17)
    port_name = Column(String, default="Port of Calabar")
    terminals = Column(JSON, default=list)
    smtp = Column(JSON, nullable=True)
    sms = Column(JSON, nullable=True)
