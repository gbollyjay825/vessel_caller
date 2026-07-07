#!/usr/bin/env python3
"""
Vessel Caller — Python backend (stdlib only, no dependencies).

Serves the static frontend AND the REST API with SQLite persistence:

  GET    /api/state[?rev=N]      full app state (or {changed:false} if rev is current)
  POST   /api/vessel-calls       register a vessel call            -> { call, rev }
  DELETE /api/vessel-calls/<id>  cancel a call (+ its inspections/invoices)
  POST   /api/inspections        submit an inspection; when completed the server
                                 marks the call completed and issues the invoice
                                 -> { inspection, invoice, call, rev }
  PUT    /api/organization       save organization profile, port, logo and roles
  PUT    /api/invoices/<id>      record / clear payment tracking details
  PUT    /api/settings           save charge/notification/port settings
  POST   /api/reset              wipe the database back to the demo seeds

Run:  python3 server.py            (http://localhost:8000)
Env:  PORT=8000  HOST=127.0.0.1  VESSEL_DB=<path to sqlite file>

The frontend (calabar/api.jsx) auto-detects this API at boot; when the app is
served statically without it (e.g. the Vercel deploy), it falls back to
browser localStorage so the demo keeps working.
"""
import json
import os
import sqlite3
import threading
import time
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from datetime import datetime, timedelta
from urllib.parse import urlparse, parse_qs

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.environ.get('VESSEL_DB', os.path.join(BASE_DIR, 'vessel_caller.db'))
HOST = os.environ.get('HOST', '127.0.0.1')
PORT = int(os.environ.get('PORT', '8000'))

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


# ------------------------------------------------------------------
# Demo seeds — field-for-field the same records as calabar/data.jsx
# ------------------------------------------------------------------
SEED_SETTINGS = {
    'commissionRate': 3.5,
    'exchangeRate': 1600,
    'liquidDuesRates': {'government': 1.68, 'private': 2.88, 'international': 4.23},
    'dryDuesRate': 2.17,
    'portName': 'Port of Calabar',
    'terminals': ['Calabar New Port — Berth 3', 'Calabar Old Port — Berth 1', 'Intels Calabar Terminal', 'Calabar Bulk Terminal', 'UNICEM Jetty'],
    'smtp': {'host': 'smtp.calabarport.ng', 'port': '587', 'user': 'noreply@calabarport.ng', 'from': 'Calabar Port <noreply@calabarport.ng>', 'connected': True},
    'sms': {'sid': 'AC••••••••••••3f2a', 'from': '+2349011223344', 'connected': False},
}

SEED_CALLS = [
    {'id': 'vc-001', 'vesselName': 'MT Sea Eagle',     'reference': 'ROT-2026-0438', 'type': 'Tanker',        'nrt': 57137, 'eta': '2026-06-02T06:30', 'sailingEta': '2026-06-04T18:00', 'berth': 'UNICEM Jetty',               'berthDate': '2026-06-02', 'status': 'completed',   'registered': '2026-05-29T10:12', 'notes': 'AGO cargo discharge. Pilot booked.'},
    {'id': 'vc-002', 'vesselName': 'MV Calabar Pride', 'reference': 'ROT-2026-0437', 'type': 'Bulk Carrier',  'nrt': 42180, 'eta': '2026-06-01T14:00', 'sailingEta': '2026-06-03T20:00', 'berth': 'Calabar Bulk Terminal',      'berthDate': '2026-06-01', 'status': 'completed',   'registered': '2026-05-28T08:40', 'notes': 'Wheat in bulk, draft survey required.'},
    {'id': 'vc-003', 'vesselName': 'MT Qua Iboe',      'reference': 'ROT-2026-0436', 'type': 'Tanker',        'nrt': 49870, 'eta': '2026-05-30T22:15', 'sailingEta': '2026-06-01T12:00', 'berth': 'UNICEM Jetty',               'berthDate': '2026-05-31', 'status': 'completed',   'registered': '2026-05-27T16:05', 'notes': ''},
    {'id': 'vc-004', 'vesselName': 'MV Atlantic Dawn', 'reference': 'ROT-2026-0435', 'type': 'Container',     'nrt': 61340, 'eta': '2026-05-29T09:00', 'sailingEta': '2026-05-31T10:00', 'berth': 'Calabar New Port — Berth 3', 'berthDate': '2026-05-29', 'status': 'completed',   'registered': '2026-05-26T11:22', 'notes': ''},
    {'id': 'vc-005', 'vesselName': 'MT Niger Trader',  'reference': 'ROT-2026-0439', 'type': 'Tanker',        'nrt': 38420, 'eta': '2026-06-07T05:45', 'sailingEta': '2026-06-09T16:00', 'berth': 'UNICEM Jetty',               'berthDate': '2026-06-07', 'status': 'in-progress', 'registered': '2026-06-04T09:30', 'notes': 'Ullage survey scheduled 08:00.'},
    {'id': 'vc-006', 'vesselName': 'MV Cross River',   'reference': 'ROT-2026-0440', 'type': 'Bulk Carrier',  'nrt': 33500, 'eta': '2026-06-08T11:30', 'sailingEta': '2026-06-10T22:00', 'berth': 'Calabar Bulk Terminal',      'berthDate': '2026-06-08', 'status': 'in-progress', 'registered': '2026-06-05T13:10', 'notes': 'Bagged fertiliser. Draft survey underway.'},
    {'id': 'vc-007', 'vesselName': 'MT Bonny Spirit',  'reference': 'ROT-2026-0441', 'type': 'Tanker',        'nrt': 29760, 'eta': '2026-06-10T16:00', 'sailingEta': '2026-06-12T18:00', 'berth': 'Calabar Old Port — Berth 1', 'berthDate': None,         'status': 'pending',     'registered': '2026-06-06T07:48', 'notes': ''},
    {'id': 'vc-008', 'vesselName': 'MV Gulf Carrier',  'reference': 'ROT-2026-0442', 'type': 'General Cargo', 'nrt': 18950, 'eta': '2026-06-11T08:20', 'sailingEta': '2026-06-13T14:00', 'berth': 'Calabar New Port — Berth 3', 'berthDate': None,         'status': 'pending',     'registered': '2026-06-06T15:33', 'notes': 'Project cargo — heavy lift.'},
]

SEED_INSPECTIONS = [
    {'id': 'in-001', 'reference': 'INS-2026-0312', 'callId': 'vc-001', 'vesselName': 'MT Sea Eagle',    'cargoType': 'Liquid', 'reconciledTonnage': 48920.40, 'date': '2026-06-02T13:40', 'status': 'completed',
     'jetty': {'type': 'International', 'category': None, 'name': 'UNICEM Jetty'},
     'liquid': {'ullage': 1.82, 'observedVol': 49210.0, 'temp': 31.4, 'surveyorTonnage': 48920.40, 'bl': 49050.0, 'outturn': 48920.4}},
    {'id': 'in-002', 'reference': 'INS-2026-0311', 'callId': 'vc-002', 'vesselName': 'MV Calabar Pride', 'cargoType': 'Dry',    'reconciledTonnage': 38470.00, 'date': '2026-06-01T18:05', 'status': 'completed',
     'dry': {'displBefore': 51230, 'displAfter': 12180, 'deductibles': 580, 'constant': 0}},
    {'id': 'in-003', 'reference': 'INS-2026-0310', 'callId': 'vc-003', 'vesselName': 'MT Qua Iboe',      'cargoType': 'Liquid', 'reconciledTonnage': 41260.75, 'date': '2026-05-31T09:50', 'status': 'completed',
     'jetty': {'type': 'Local', 'category': 'Government', 'name': 'UNICEM Jetty'},
     'liquid': {'ullage': 2.10, 'observedVol': 41500.0, 'temp': 29.8, 'surveyorTonnage': 41260.75, 'bl': 41390.0, 'outturn': 41260.75}},
    {'id': 'in-004', 'reference': 'INS-2026-0309', 'callId': 'vc-004', 'vesselName': 'MV Atlantic Dawn', 'cargoType': 'Dry',    'reconciledTonnage': 52310.00, 'date': '2026-05-29T20:15', 'status': 'completed',
     'dry': {'displBefore': 67400, 'displAfter': 14510, 'deductibles': 580, 'constant': 0}},
    {'id': 'in-005', 'reference': 'INS-2026-0313', 'callId': 'vc-005', 'vesselName': 'MT Niger Trader',  'cargoType': 'Liquid', 'reconciledTonnage': 0, 'date': '2026-06-07T08:30', 'status': 'draft',
     'jetty': {'type': 'Local', 'category': 'Private', 'name': ''},
     'liquid': {'ullage': 1.55, 'observedVol': 0, 'temp': 30.2, 'surveyorTonnage': 0, 'bl': 33100.0, 'outturn': 0}},
]

SEED_INVOICES = [
    {'id': 'iv-001', 'invoiceNo': 'INV-2026-0288', 'callId': 'vc-001', 'inspectionId': 'in-001', 'vesselName': 'MT Sea Eagle',    'callRef': 'ROT-2026-0438', 'status': 'paid',   'issued': '2026-06-02T14:10', 'due': '2026-06-09',
     'payment': {'paidOn': '2026-06-05', 'method': 'Bank transfer', 'reference': 'NPA-TRF-88213', 'recordedBy': 'Bassey Effiong'}},
    {'id': 'iv-002', 'invoiceNo': 'INV-2026-0287', 'callId': 'vc-002', 'inspectionId': 'in-002', 'vesselName': 'MV Calabar Pride', 'callRef': 'ROT-2026-0437', 'status': 'unpaid', 'issued': '2026-06-01T18:30', 'due': '2026-07-15', 'payment': None},
    {'id': 'iv-003', 'invoiceNo': 'INV-2026-0286', 'callId': 'vc-003', 'inspectionId': 'in-003', 'vesselName': 'MT Qua Iboe',      'callRef': 'ROT-2026-0436', 'status': 'paid',   'issued': '2026-05-31T10:20', 'due': '2026-06-07',
     'payment': {'paidOn': '2026-06-02', 'method': 'Bank transfer', 'reference': 'NPA-TRF-88102', 'recordedBy': 'Bassey Effiong'}},
    {'id': 'iv-004', 'invoiceNo': 'INV-2026-0285', 'callId': 'vc-004', 'inspectionId': 'in-004', 'vesselName': 'MV Atlantic Dawn', 'callRef': 'ROT-2026-0435', 'status': 'unpaid', 'issued': '2026-05-29T20:40', 'due': '2026-06-05', 'payment': None},
]

# Organization profile — fresh installs run the Register Organization
# onboarding in the frontend (registered: False).
SEED_ORG = {
    'registered': False,
    'name': '', 'rcNumber': '', 'email': '', 'phone': '', 'address': '',
    'designatedPort': 'Port of Calabar',
    'logo': None,
    'members': [],
}


# ------------------------------------------------------------------
# Storage — document tables in SQLite; newest-first via rowid DESC
# ------------------------------------------------------------------
def connect():
    con = sqlite3.connect(DB_PATH, timeout=10)
    con.execute('PRAGMA journal_mode=WAL')
    return con


def init_db():
    con = connect()
    con.execute("CREATE TABLE IF NOT EXISTS docs (col TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY (col, id))")
    con.execute("CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)")
    if con.execute("SELECT v FROM meta WHERE k='rev'").fetchone() is None:
        seed(con)
    con.commit()
    con.close()


def seed(con):
    con.execute("DELETE FROM docs")
    con.execute("DELETE FROM meta")
    # insert in reverse so rowid DESC == original seed order (newest-first UX)
    for call in reversed(SEED_CALLS):
        con.execute("INSERT INTO docs (col, id, data) VALUES ('calls', ?, ?)", (call['id'], json.dumps(call)))
    for insp in reversed(SEED_INSPECTIONS):
        con.execute("INSERT INTO docs (col, id, data) VALUES ('inspections', ?, ?)", (insp['id'], json.dumps(insp)))
    for inv in reversed(SEED_INVOICES):
        con.execute("INSERT INTO docs (col, id, data) VALUES ('invoices', ?, ?)", (inv['id'], json.dumps(inv)))
    con.execute("INSERT INTO meta (k, v) VALUES ('settings', ?)", (json.dumps(SEED_SETTINGS),))
    con.execute("INSERT INTO meta (k, v) VALUES ('org', ?)", (json.dumps(SEED_ORG),))
    con.execute("INSERT INTO meta (k, v) VALUES ('rev', '1')")


def get_rev(con):
    return int(con.execute("SELECT v FROM meta WHERE k='rev'").fetchone()[0])


def bump_rev(con):
    rev = get_rev(con) + 1
    con.execute("UPDATE meta SET v=? WHERE k='rev'", (str(rev),))
    return rev


def col_docs(con, col):
    rows = con.execute("SELECT data FROM docs WHERE col=? ORDER BY rowid DESC", (col,)).fetchall()
    return [json.loads(r[0]) for r in rows]


def get_doc(con, col, doc_id):
    row = con.execute("SELECT data FROM docs WHERE col=? AND id=?", (col, doc_id)).fetchone()
    return json.loads(row[0]) if row else None


def put_doc(con, col, doc):
    con.execute("INSERT OR REPLACE INTO docs (col, id, data) VALUES (?, ?, ?)", (col, doc['id'], json.dumps(doc)))


def full_state(con):
    org_row = con.execute("SELECT v FROM meta WHERE k='org'").fetchone()
    return {
        'rev': get_rev(con),
        'calls': col_docs(con, 'calls'),
        'inspections': col_docs(con, 'inspections'),
        'invoices': col_docs(con, 'invoices'),
        'settings': json.loads(con.execute("SELECT v FROM meta WHERE k='settings'").fetchone()[0]),
        'org': json.loads(org_row[0]) if org_row else SEED_ORG,
    }


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
# Business logic — mirrors calabar/api.jsx applyInspection
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
    if any(c['reference'].lower() == call['reference'].lower() for c in col_docs(con, 'calls')):
        raise ValueError('This rotation number is already in use')
    put_doc(con, 'calls', call)
    rev = bump_rev(con)
    return call, rev


def create_inspection(con, data):
    call = get_doc(con, 'calls', data.get('callId'))
    if call is None:
        raise ValueError('Unknown vessel call')
    inspections = col_docs(con, 'inspections')
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
    put_doc(con, 'inspections', inspection)

    invoice = None
    if inspection['status'] == 'completed':
        call = dict(call)
        call['status'] = 'completed'
        call['berthDate'] = call.get('berthDate') or today()
        put_doc(con, 'calls', call)
        invoices = col_docs(con, 'invoices')
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
        }
        put_doc(con, 'invoices', invoice)

    rev = bump_rev(con)
    return inspection, invoice, call, rev


def delete_call(con, call_id):
    con.execute("DELETE FROM docs WHERE col='calls' AND id=?", (call_id,))
    for insp in col_docs(con, 'inspections'):
        if insp.get('callId') == call_id:
            con.execute("DELETE FROM docs WHERE col='inspections' AND id=?", (insp['id'],))
    for inv in col_docs(con, 'invoices'):
        if inv.get('callId') == call_id:
            con.execute("DELETE FROM docs WHERE col='invoices' AND id=?", (inv['id'],))
    return bump_rev(con)


def save_settings(con, settings):
    con.execute("UPDATE meta SET v=? WHERE k='settings'", (json.dumps(settings),))
    return bump_rev(con)


def save_org(con, org):
    # upsert: databases created before the org feature lack the row
    con.execute("INSERT OR REPLACE INTO meta (k, v) VALUES ('org', ?)", (json.dumps(org),))
    return bump_rev(con)


def update_invoice(con, invoice_id, patch):
    """Payment tracking: merge {status, payment} into an invoice."""
    inv = get_doc(con, 'invoices', invoice_id)
    if inv is None:
        raise ValueError('Unknown invoice')
    if 'status' in patch:
        if patch['status'] not in ('paid', 'unpaid'):
            raise ValueError('status must be paid or unpaid')
        inv['status'] = patch['status']
    if 'payment' in patch:
        inv['payment'] = patch['payment']
    put_doc(con, 'invoices', inv)
    rev = bump_rev(con)
    return inv, rev


# ------------------------------------------------------------------
# HTTP layer — /api/* routed here, everything else served statically
# ------------------------------------------------------------------
_db_lock = threading.Lock()


class Handler(SimpleHTTPRequestHandler):
    def log_message(self, fmt, *args):
        # keep the console readable: only log API traffic
        if self.path.startswith('/api/'):
            SimpleHTTPRequestHandler.log_message(self, fmt, *args)

    # ---- helpers ----
    def send_json(self, obj, status=200):
        body = json.dumps(obj).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(body)

    def read_json(self):
        try:
            length = int(self.headers.get('Content-Length', '0'))
            return json.loads(self.rfile.read(length).decode('utf-8')) if length else {}
        except (ValueError, json.JSONDecodeError):
            return None

    def with_db(self, fn):
        with _db_lock:
            con = connect()
            try:
                result = fn(con)
                con.commit()
                return result
            finally:
                con.close()

    # ---- routes ----
    def do_GET(self):
        url = urlparse(self.path)
        if url.path == '/api/state':
            qs = parse_qs(url.query)
            client_rev = int(qs.get('rev', ['-1'])[0]) if qs.get('rev', [''])[0].lstrip('-').isdigit() else -1
            def read(con):
                rev = get_rev(con)
                if client_rev == rev:
                    return {'rev': rev, 'changed': False}
                return full_state(con)
            return self.send_json(self.with_db(read))
        if url.path.startswith('/api/'):
            return self.send_json({'error': 'Not found'}, 404)
        return SimpleHTTPRequestHandler.do_GET(self)

    def do_POST(self):
        url = urlparse(self.path)
        if url.path == '/api/vessel-calls':
            data = self.read_json()
            if data is None:
                return self.send_json({'error': 'Invalid JSON'}, 400)
            try:
                call, rev = self.with_db(lambda con: create_call(con, data))
                return self.send_json({'call': call, 'rev': rev}, 201)
            except ValueError as e:
                return self.send_json({'error': str(e)}, 400)
        if url.path == '/api/inspections':
            data = self.read_json()
            if data is None:
                return self.send_json({'error': 'Invalid JSON'}, 400)
            try:
                inspection, invoice, call, rev = self.with_db(lambda con: create_inspection(con, data))
                return self.send_json({'inspection': inspection, 'invoice': invoice, 'call': call, 'rev': rev}, 201)
            except ValueError as e:
                return self.send_json({'error': str(e)}, 400)
        if url.path == '/api/reset':
            def do_reset(con):
                seed(con)
                return get_rev(con)
            rev = self.with_db(do_reset)
            return self.send_json({'ok': True, 'rev': rev})
        return self.send_json({'error': 'Not found'}, 404)

    def do_PUT(self):
        url = urlparse(self.path)
        if url.path == '/api/settings':
            data = self.read_json()
            if not isinstance(data, dict):
                return self.send_json({'error': 'Invalid JSON'}, 400)
            rev = self.with_db(lambda con: save_settings(con, data))
            return self.send_json({'settings': data, 'rev': rev})
        if url.path == '/api/organization':
            data = self.read_json()
            if not isinstance(data, dict):
                return self.send_json({'error': 'Invalid JSON'}, 400)
            rev = self.with_db(lambda con: save_org(con, data))
            return self.send_json({'org': data, 'rev': rev})
        if url.path.startswith('/api/invoices/'):
            data = self.read_json()
            if not isinstance(data, dict):
                return self.send_json({'error': 'Invalid JSON'}, 400)
            invoice_id = url.path.rsplit('/', 1)[1]
            try:
                inv, rev = self.with_db(lambda con: update_invoice(con, invoice_id, data))
                return self.send_json({'invoice': inv, 'rev': rev})
            except ValueError as e:
                return self.send_json({'error': str(e)}, 400)
        return self.send_json({'error': 'Not found'}, 404)

    def do_DELETE(self):
        url = urlparse(self.path)
        if url.path.startswith('/api/vessel-calls/'):
            call_id = url.path.rsplit('/', 1)[1]
            rev = self.with_db(lambda con: delete_call(con, call_id))
            return self.send_json({'ok': True, 'rev': rev})
        return self.send_json({'error': 'Not found'}, 404)


def main():
    init_db()
    server = ThreadingHTTPServer((HOST, PORT), partial(Handler, directory=BASE_DIR))
    print('Vessel Caller backend — http://%s:%d  (db: %s)' % (HOST, PORT, DB_PATH))
    server.serve_forever()


if __name__ == '__main__':
    main()
