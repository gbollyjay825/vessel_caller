"""Request/response schemas (Pydantic v2). Field names are camelCase to match
the frontend payloads. `str` is used for email to avoid the email-validator dep."""
from typing import Any, Optional

from pydantic import BaseModel, Field


# ---- auth ----
class RegisterRequest(BaseModel):
    name: str
    email: str
    password: str = Field(min_length=8)
    orgName: str
    rcNumber: str = ""
    phone: str = ""
    address: str = ""
    designatedPort: str = "Port of Calabar"
    ports: list[str] = []


class LoginRequest(BaseModel):
    email: str
    password: str


# ---- organization / team ----
class OrgUpdate(BaseModel):
    name: Optional[str] = None
    rcNumber: Optional[str] = None
    email: Optional[str] = None
    phone: Optional[str] = None
    address: Optional[str] = None
    designatedPort: Optional[str] = None
    primaryPort: Optional[str] = None
    ports: Optional[list[str]] = None
    logo: Optional[str] = None
    registered: Optional[bool] = None


class MemberCreate(BaseModel):
    name: str
    email: str
    password: str = Field(min_length=8)
    role: str = "Viewer"


class MemberUpdate(BaseModel):
    name: Optional[str] = None
    role: Optional[str] = None
    active: Optional[bool] = None
    password: Optional[str] = Field(default=None, min_length=8)


# ---- operations ----
class CallCreate(BaseModel):
    vesselName: str
    reference: str
    type: str = ""
    flag: str = ""
    nrt: float = 0
    eta: str = ""
    sailingEta: str = ""
    berth: str = ""
    notes: str = ""


class InspectionCreate(BaseModel):
    callId: str
    cargoType: str = "Liquid"
    product: Optional[str] = None
    reconciledTonnage: float = 0
    jetty: Optional[dict[str, Any]] = None
    liquid: Optional[dict[str, Any]] = None
    dry: Optional[dict[str, Any]] = None
    status: str = "completed"


class InvoicePatch(BaseModel):
    status: Optional[str] = None
    payment: Optional[dict[str, Any]] = None


class SettingsUpdate(BaseModel):
    commissionRate: Optional[float] = None
    exchangeRate: Optional[float] = None
    liquidDuesRates: Optional[dict[str, float]] = None
    dryDuesRate: Optional[float] = None
    portName: Optional[str] = None
    terminals: Optional[list[str]] = None
    smtp: Optional[dict[str, Any]] = None
    sms: Optional[dict[str, Any]] = None
