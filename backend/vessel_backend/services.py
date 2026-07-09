"""Business logic — mirrors calabar/api.jsx applyInspection + calabar/data.jsx maths."""
import json
import math
import threading
import time
from datetime import datetime, timedelta

from . import db
from .seeds import normalize_org

_id_lock = threading.Lock()
_last_id_ms = [0]


def new_id(prefix):
    """Millisecond ids like the frontend's ('vc-'+Date.now()), collision-safe."""
    with _id_lock:
        ms = int(time.time() * 1000)
        if ms <= _last_id_ms[0]:
            ms = _last_id_ms[0] + 1
        _last_id_ms[0] = ms
        return '%s-%d' % (prefix, ms)


def now_minute():
    return datetime.now().isoformat()[:16]


def today():
    return datetime.now().date().isoformat()


def next_ref_number(docs, key):
    best = 0
    for d in docs:
        parts = str(d.get(key, '')).split('-')
        if len(parts) >= 3:
            try:
                best = max(best, int(parts[2]))
            except ValueError:
                pass
    return best + 1


# ------------------------------------------------------------------
# Rate logic — mirrors calabar/data.jsx (round2 matches JS Math.round
# semantics for positives: floor(x*100 + 0.5) / 100)
# ------------------------------------------------------------------
def round2(x):
    return math.floor(x * 100 + 0.5) / 100.0


def rate_for_inspection(insp, settings):
    if not insp:
        return None
    if insp.get('cargoType') == 'Dry':
        return settings.get('dryDuesRate')
    j = insp.get('jetty') or {}
    liquid = settings.get('liquidDuesRates') or {}
    if j.get('type') == 'International':
        return liquid.get('international')
    if j.get('type') == 'Local' and j.get('category') == 'Government':
        return liquid.get('government')
    if j.get('type') == 'Local' and j.get('category') == 'Private':
        return liquid.get('private')
    return None


def calc_dues(net_tonnage, rate):
    if not rate or rate <= 0:
        return 0
    try:
        nrt = float(net_tonnage or 0)
    except (TypeError, ValueError):
        nrt = 0.0
    return round2(nrt * rate)


def calc_commission(dues, settings):
    usd = round2(dues * (settings.get('commissionRate', 0) / 100.0))
    ngn = int(math.floor(usd * settings.get('exchangeRate', 0) + 0.5))
    return {'usd': usd, 'ngn': ngn}


# ------------------------------------------------------------------
# Mutations — each takes an open connection, returns the new rev
# ------------------------------------------------------------------
def create_call(con, data):
    call = {
        'id': new_id('vc'),
        'vesselName': str(data.get('vesselName', '')).strip(),
        'reference': str(data.get('reference', '')).strip(),
        'type': data.get('type', 'Tanker'),
        'nrt': data.get('nrt', 0),
        'eta': data.get('eta') or now_minute(),
        'sailingEta': data.get('sailingEta'),
        'berth': data.get('berth', ''),
        'berthDate': None,
        'status': 'pending',
        'registered': now_minute(),
        'notes': str(data.get('notes', '')).strip(),
    }
    if not call['vesselName'] or not call['reference'] or not call['nrt']:
        raise ValueError('vesselName, reference and nrt are required')
    if any(c['reference'].lower() == call['reference'].lower() for c in db.col_docs(con, 'calls')):
        raise ValueError('This rotation number is already in use')
    db.put_doc(con, 'calls', call)
    rev = db.bump_rev(con)
    return call, rev


def create_inspection(con, data):
    call = db.get_doc(con, 'calls', data.get('callId'))
    if call is None:
        raise ValueError('Unknown vessel call')
    inspections = db.col_docs(con, 'inspections')
    inspection = {
        'id': new_id('in'),
        'reference': 'INS-2026-%04d' % next_ref_number(inspections, 'reference'),
        'callId': call['id'],
        'vesselName': call['vesselName'],
        'cargoType': data.get('cargoType'),
        'reconciledTonnage': data.get('reconciledTonnage', 0),
        'date': now_minute(),
        'status': data.get('status', 'completed'),
        'liquid': data.get('liquid'),
        'dry': data.get('dry'),
        'jetty': data.get('jetty'),
    }
    if inspection['cargoType'] not in ('Liquid', 'Dry'):
        raise ValueError('cargoType must be Liquid or Dry')
    db.put_doc(con, 'inspections', inspection)

    invoice = None
    if inspection['status'] == 'completed':
        call = dict(call)
        call['status'] = 'completed'
        call['berthDate'] = call.get('berthDate') or today()
        db.put_doc(con, 'calls', call)
        invoices = db.col_docs(con, 'invoices')
        # money snapshot — frozen at issue time so later rate changes never
        # rewrite what an invoice was worth
        settings = db.get_settings(con)
        rate = rate_for_inspection(inspection, settings)
        dues = calc_dues(call.get('nrt'), rate)
        comm = calc_commission(dues, settings)
        invoice = {
            'id': new_id('iv'),
            'invoiceNo': 'INV-2026-%04d' % next_ref_number(invoices, 'invoiceNo'),
            'callId': call['id'],
            'inspectionId': inspection['id'],
            'vesselName': call['vesselName'],
            'callRef': call['reference'],
            'status': 'unpaid',
            'issued': now_minute(),
            'due': (datetime.now() + timedelta(days=7)).date().isoformat(),
            'dues': dues,
            'rate': rate,
            'commissionUsd': comm['usd'],
            'commissionNgn': comm['ngn'],
            'fx': settings.get('exchangeRate'),
        }
        db.put_doc(con, 'invoices', invoice)

    rev = db.bump_rev(con)
    return inspection, invoice, call, rev


def delete_call(con, call_id):
    con.execute("DELETE FROM docs WHERE col='calls' AND id=?", (call_id,))
    for insp in db.col_docs(con, 'inspections'):
        if insp.get('callId') == call_id:
            con.execute("DELETE FROM docs WHERE col='inspections' AND id=?", (insp['id'],))
    for inv in db.col_docs(con, 'invoices'):
        if inv.get('callId') == call_id:
            con.execute("DELETE FROM docs WHERE col='invoices' AND id=?", (inv['id'],))
    return db.bump_rev(con)


def save_settings(con, settings):
    con.execute("UPDATE meta SET v=? WHERE k='settings'", (json.dumps(settings),))
    return db.bump_rev(con)


def save_org(con, org):
    # upsert: databases created before the org feature lack the row
    org = normalize_org(org)
    con.execute("INSERT OR REPLACE INTO meta (k, v) VALUES ('org', ?)", (json.dumps(org),))
    return db.bump_rev(con)


def update_invoice(con, invoice_id, patch):
    """Payment tracking: merge {status, payment} into an invoice."""
    inv = db.get_doc(con, 'invoices', invoice_id)
    if inv is None:
        raise ValueError('Unknown invoice')
    if 'status' in patch:
        if patch['status'] not in ('paid', 'unpaid'):
            raise ValueError('status must be paid or unpaid')
        inv['status'] = patch['status']
    if 'payment' in patch:
        payment = patch['payment']
        # a recorded payment settles the snapshotted dues — stamp the amount
        # unless the client already sent one
        if payment and payment.get('amount') is None and inv.get('dues') is not None:
            payment = dict(payment)
            payment['amount'] = inv['dues']
        inv['payment'] = payment
    db.put_doc(con, 'invoices', inv)
    rev = db.bump_rev(con)
    return inv, rev


def reset(con):
    """Wipe the database back to the demo seeds."""
    db.seed(con)
    return db.get_rev(con)
