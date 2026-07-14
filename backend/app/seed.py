"""Demo seed: one organization, a team across all four roles, and ~12 months
of vessel calls / inspections / invoices so analytics has real data.

Demo credentials (documented in README):  admin@calabarport.ng / demo1234
"""
import random
from datetime import date, datetime, timedelta

from sqlalchemy.orm import Session

from .ids import new_id
from .models import Inspection, Invoice, Organization, Settings, User, VesselCall
from .security import hash_password
from .services import calc_commission, calc_dues, rate_for_inspection

DEMO_PASSWORD = "demo1234"

_TEAM = [
    ("Etim Okon", "admin@calabarport.ng", "Admin"),
    ("Bassey Effiong", "operations@calabarport.ng", "Operations"),
    ("Ngozi Kalu", "finance@calabarport.ng", "Finance"),
    ("Ama Douglas", "viewer@calabarport.ng", "Viewer"),
]
_VESSELS = [
    ("MT Sea Eagle", "Tanker", "Liberia"), ("MV Calabar Pride", "Bulk Carrier", "Panama"),
    ("MT Qua Iboe", "Tanker", "Liberia"), ("MV Atlantic Dawn", "Container", "Singapore"),
    ("MT Niger Trader", "Tanker", "Marshall Islands"), ("MV Cross River", "Bulk Carrier", "Nigeria"),
    ("MT Bonny Spirit", "Tanker", "Nigeria"), ("MV Gulf Carrier", "General Cargo", "Malta"),
    ("MT Delta Star", "Tanker", "Liberia"), ("MV Ocean Harmony", "Bulk Carrier", "Panama"),
]
_PRODUCTS = ["PMS", "AGO", "DPK"]
_JETTIES = [
    {"type": "International", "category": None, "name": "UNICEM Jetty"},
    {"type": "Local", "category": "Government", "name": "Calabar New Port — Berth 3"},
    {"type": "Local", "category": "Private", "name": "Intels Calabar Terminal"},
]


def _month_starts(n: int):
    today = date.today()
    y, m = today.year, today.month
    out = []
    for _ in range(n):
        out.append((y, m))
        m -= 1
        if m == 0:
            m, y = 12, y - 1
    return list(reversed(out))


def seed_if_empty(db: Session) -> bool:
    if db.query(Organization).first():
        return False

    rng = random.Random(42)
    org = Organization(
        id=new_id("org"), registered=True, name="Calabar Port Services Ltd",
        rc_number="RC-1043928", email="ops@calabarport.ng", phone="+234 803 000 0000",
        address="12 Marina Road, Calabar, Cross River", primary_port="Port of Calabar",
        ports=["Port of Calabar", "Onne Port, Rivers"], logo=None, rev=1,
    )
    db.add(org)
    s = Settings(
        org_id=org.id, commission_rate=3.5, exchange_rate=1600,
        liquid_dues_rates={"government": 1.68, "private": 2.88, "international": 4.23},
        dry_dues_rate=2.17, port_name="Port of Calabar",
        terminals=["Calabar New Port — Berth 3", "Calabar Bulk Terminal", "UNICEM Jetty",
                   "Intels Calabar Terminal", "Calabar Old Port — Berth 1"],
        smtp={"host": "smtp.calabarport.ng", "port": "587", "user": "noreply@calabarport.ng",
              "from": "Calabar Port <noreply@calabarport.ng>", "connected": True},
        sms={"sid": "AC••••••••••••3f2a", "from": "+2349011223344", "connected": False},
    )
    db.add(s)
    for name, email, role in _TEAM:
        db.add(User(id=new_id("u"), org_id=org.id, name=name, email=email,
                    password_hash=hash_password(DEMO_PASSWORD), role=role, active=True))

    rot = 400
    today = date.today()
    for (y, m) in _month_starts(12):
        for _ in range(rng.randint(3, 5)):
            rot += 1
            vessel, vtype, flag = rng.choice(_VESSELS)
            day = rng.randint(1, 26)
            when = datetime(y, m, day, rng.randint(6, 20), rng.choice([0, 15, 30]))
            nrt = rng.randint(18000, 62000)
            is_dry = rng.random() < 0.4
            cargo = "Dry" if is_dry else "Liquid"
            jetty = None if is_dry else rng.choice(_JETTIES)
            product = None if is_dry else rng.choice(_PRODUCTS)
            recon = round(nrt * rng.uniform(0.80, 0.98), 2)

            call = VesselCall(
                id=new_id("vc"), org_id=org.id, vessel_name=vessel,
                reference=f"ROT-{y}-{rot:04d}", type=vtype, flag=flag, nrt=nrt,
                eta=when.isoformat(timespec="minutes"),
                sailing_eta=(when + timedelta(days=2)).isoformat(timespec="minutes"),
                berth=jetty["name"] if jetty else "Calabar Bulk Terminal",
                berth_date=when.strftime("%Y-%m-%d"), status="completed",
                registered=(when - timedelta(days=3)).isoformat(timespec="minutes"),
            )
            db.add(call)
            db.flush()   # parent row must exist before its inspection/invoice (FK on)
            insp = Inspection(
                id=new_id("in"), org_id=org.id, call_id=call.id,
                reference=f"INS-{y}-{rot:04d}", vessel_name=vessel, cargo_type=cargo,
                product=product, reconciled_tonnage=recon, jetty=jetty,
                liquid=None if is_dry else {"surveyorTonnage": recon},
                dry={"draftSurvey": recon} if is_dry else None,
                date=when.isoformat(timespec="minutes"), status="completed",
            )
            db.add(insp)
            rate = rate_for_inspection(cargo, jetty, s)
            dues = calc_dues(nrt, rate)
            usd, ngn = calc_commission(dues, s)
            issued = when.date()
            due = issued + timedelta(days=14)
            age_days = (today - issued).days
            # older invoices mostly paid; recent ones open; a few overdue
            paid = age_days > 25 and rng.random() < 0.85
            payment = None
            if paid:
                payment = {"paidOn": (issued + timedelta(days=rng.randint(3, 12))).strftime("%Y-%m-%d"),
                           "method": rng.choice(["Bank transfer", "Cheque", "RTGS"]),
                           "reference": f"NPA-TRF-{rng.randint(10000, 99999)}",
                           "amount": dues, "recordedBy": "Ngozi Kalu"}
            db.add(Invoice(
                id=new_id("iv"), org_id=org.id, call_id=call.id, inspection_id=insp.id,
                invoice_no=f"INV-{y}-{rot:04d}", cargo_type=cargo,
                issued=issued.strftime("%Y-%m-%d"), due=due.strftime("%Y-%m-%d"),
                status="paid" if paid else "unpaid", dues=dues, rate=rate or 0,
                commission_usd=usd, commission_ngn=ngn, fx=s.exchange_rate, payment=payment,
            ))
    db.commit()
    return True
