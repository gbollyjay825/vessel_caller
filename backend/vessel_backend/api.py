"""HTTP layer — /api/* routed here, everything else served statically.

  GET    /api/state[?rev=N]      full app state (or {changed:false} if rev is current)
  POST   /api/vessel-calls       register a vessel call            -> { call, rev }
  DELETE /api/vessel-calls/<id>  cancel a call (+ its inspections/invoices)
  POST   /api/inspections        submit an inspection; when completed the server
                                 marks the call completed and issues the invoice
                                 (with a dues/commission money snapshot)
                                 -> { inspection, invoice, call, rev }
  PUT    /api/organization       save organization profile, ports, logo and roles
  PUT    /api/invoices/<id>      record / clear payment tracking details
  PUT    /api/settings           save charge/notification/port settings
  POST   /api/reset              wipe the database back to the demo seeds

When config.allow_origin is set, API responses carry CORS headers and
OPTIONS preflights on /api/* answer 204.
"""
import json
import threading
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

from . import db, services
from .config import Config

_db_lock = threading.Lock()


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, config=None, **kwargs):
        self.config = config
        super().__init__(*args, directory=config.static_dir, **kwargs)

    def log_message(self, fmt, *args):
        # keep the console readable: only log API traffic
        if self.path.startswith('/api/'):
            SimpleHTTPRequestHandler.log_message(self, fmt, *args)

    # ---- helpers ----
    def cors_headers(self):
        if self.config.allow_origin:
            self.send_header('Access-Control-Allow-Origin', self.config.allow_origin)
            self.send_header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
            self.send_header('Access-Control-Allow-Headers', 'Content-Type')

    def send_json(self, obj, status=200):
        body = json.dumps(obj).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.cors_headers()
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
            con = db.connect(self.config.db_path)
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
                rev = db.get_rev(con)
                if client_rev == rev:
                    return {'rev': rev, 'changed': False}
                return db.full_state(con)
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
                call, rev = self.with_db(lambda con: services.create_call(con, data))
                return self.send_json({'call': call, 'rev': rev}, 201)
            except ValueError as e:
                return self.send_json({'error': str(e)}, 400)
        if url.path == '/api/inspections':
            data = self.read_json()
            if data is None:
                return self.send_json({'error': 'Invalid JSON'}, 400)
            try:
                inspection, invoice, call, rev = self.with_db(lambda con: services.create_inspection(con, data))
                return self.send_json({'inspection': inspection, 'invoice': invoice, 'call': call, 'rev': rev}, 201)
            except ValueError as e:
                return self.send_json({'error': str(e)}, 400)
        if url.path == '/api/reset':
            rev = self.with_db(services.reset)
            return self.send_json({'ok': True, 'rev': rev})
        return self.send_json({'error': 'Not found'}, 404)

    def do_PUT(self):
        url = urlparse(self.path)
        if url.path == '/api/settings':
            data = self.read_json()
            if not isinstance(data, dict):
                return self.send_json({'error': 'Invalid JSON'}, 400)
            rev = self.with_db(lambda con: services.save_settings(con, data))
            return self.send_json({'settings': data, 'rev': rev})
        if url.path == '/api/organization':
            data = self.read_json()
            if not isinstance(data, dict):
                return self.send_json({'error': 'Invalid JSON'}, 400)
            rev = self.with_db(lambda con: services.save_org(con, data))
            return self.send_json({'org': data, 'rev': rev})
        if url.path.startswith('/api/invoices/'):
            data = self.read_json()
            if not isinstance(data, dict):
                return self.send_json({'error': 'Invalid JSON'}, 400)
            invoice_id = url.path.rsplit('/', 1)[1]
            try:
                inv, rev = self.with_db(lambda con: services.update_invoice(con, invoice_id, data))
                return self.send_json({'invoice': inv, 'rev': rev})
            except ValueError as e:
                return self.send_json({'error': str(e)}, 400)
        return self.send_json({'error': 'Not found'}, 404)

    def do_DELETE(self):
        url = urlparse(self.path)
        if url.path.startswith('/api/vessel-calls/'):
            call_id = url.path.rsplit('/', 1)[1]
            rev = self.with_db(lambda con: services.delete_call(con, call_id))
            return self.send_json({'ok': True, 'rev': rev})
        return self.send_json({'error': 'Not found'}, 404)

    def do_OPTIONS(self):
        # CORS preflight (only meaningful when an origin is configured)
        url = urlparse(self.path)
        if url.path.startswith('/api/') and self.config.allow_origin:
            self.send_response(204)
            self.cors_headers()
            self.end_headers()
            return
        return self.send_json({'error': 'Not found'}, 404)


def make_server(config):
    """Init the database and return a ready-to-serve ThreadingHTTPServer."""
    db.init_db(config.db_path)
    return ThreadingHTTPServer((config.host, config.port), partial(Handler, config=config))


def main(config=None):
    config = config or Config()
    server = make_server(config)
    host, port = server.server_address[:2]
    print('Vessel Caller backend — http://%s:%d  (db: %s, static: %s)' % (host, port, config.db_path, config.static_dir))
    server.serve_forever()
