"""End-to-end API tests — boots the real server on an ephemeral port.

Run from backend/:  python3 -m unittest discover -s tests -t .
"""
import json
import os
import shutil
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request

TESTS_DIR = os.path.dirname(os.path.abspath(__file__))
BACKEND_DIR = os.path.dirname(TESTS_DIR)
REPO_ROOT = os.path.dirname(BACKEND_DIR)
sys.path.insert(0, BACKEND_DIR)

from vessel_backend import services  # noqa: E402
from vessel_backend.api import make_server  # noqa: E402
from vessel_backend.config import Config  # noqa: E402
from vessel_backend.seeds import SEED_CALLS, SEED_INVOICES  # noqa: E402


def start_server(allow_origin=None):
    """Boot the real server on port 0 (ephemeral) with a temp database."""
    tmp = tempfile.mkdtemp(prefix='vessel-test-')
    config = Config(
        host='127.0.0.1', port=0,
        db_path=os.path.join(tmp, 'test.db'),
        static_dir=REPO_ROOT,
        allow_origin=allow_origin,
    )
    server = make_server(config)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, thread, tmp


class ServerTestCase(unittest.TestCase):
    allow_origin = None

    @classmethod
    def setUpClass(cls):
        cls.server, cls.thread, cls.tmp = start_server(cls.allow_origin)
        cls.port = cls.server.server_address[1]

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=5)
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def request(self, method, path, body=None):
        """-> (status, parsed json or None, headers dict)"""
        url = 'http://127.0.0.1:%d%s' % (self.port, path)
        data = json.dumps(body).encode('utf-8') if body is not None else None
        req = urllib.request.Request(url, data=data, method=method,
                                     headers={'Content-Type': 'application/json'})
        try:
            with urllib.request.urlopen(req) as res:
                raw = res.read()
                return res.status, json.loads(raw) if raw else None, dict(res.headers)
        except urllib.error.HTTPError as e:
            raw = e.read()
            return e.code, json.loads(raw) if raw else None, dict(e.headers)


class ApiTests(ServerTestCase):
    def setUp(self):
        # every test starts from pristine seeds (rev back to 1)
        status, body, _ = self.request('POST', '/api/reset')
        self.assertEqual(status, 200)
        self.assertEqual(body['rev'], 1)

    # ---- state & seeds ----
    def test_state_returns_seeds_and_rev(self):
        status, state, _ = self.request('GET', '/api/state')
        self.assertEqual(status, 200)
        self.assertEqual(state['rev'], 1)
        self.assertEqual(len(state['calls']), len(SEED_CALLS))
        self.assertEqual(state['calls'][0]['id'], 'vc-001')  # newest-first
        self.assertEqual(state['calls'][0]['sailingEta'], '2026-06-04T18:00')
        self.assertEqual(len(state['invoices']), len(SEED_INVOICES))
        self.assertEqual(state['settings']['liquidDuesRates']['international'], 4.23)
        self.assertIn('org', state)
        self.assertEqual(state['org']['ports'], ['Port of Calabar'])
        # seed invoices carry the money snapshot
        by_id = {iv['id']: iv for iv in state['invoices']}
        self.assertEqual(by_id['iv-001']['dues'], 241689.51)
        self.assertEqual(by_id['iv-001']['commissionUsd'], 8459.13)
        self.assertEqual(by_id['iv-001']['commissionNgn'], 13534608)
        self.assertEqual(by_id['iv-001']['payment']['amount'], 241689.51)
        self.assertEqual(by_id['iv-002']['dues'], 91530.60)
        self.assertEqual(by_id['iv-003']['dues'], 83781.60)
        self.assertEqual(by_id['iv-003']['payment']['amount'], 83781.60)
        self.assertEqual(by_id['iv-004']['dues'], 133107.80)
        self.assertEqual(by_id['iv-004']['fx'], 1600)

    def test_state_with_current_rev_reports_unchanged(self):
        _, state, _ = self.request('GET', '/api/state')
        status, body, _ = self.request('GET', '/api/state?rev=%d' % state['rev'])
        self.assertEqual(status, 200)
        self.assertEqual(body, {'rev': state['rev'], 'changed': False})

    # ---- vessel calls ----
    def test_create_call_and_duplicate_rotation_rejected(self):
        payload = {'vesselName': 'MT Test Vessel', 'reference': 'ROT-2026-9001',
                   'type': 'Tanker', 'nrt': 50000, 'berth': 'UNICEM Jetty'}
        status, body, _ = self.request('POST', '/api/vessel-calls', payload)
        self.assertEqual(status, 201)
        self.assertEqual(body['call']['vesselName'], 'MT Test Vessel')
        self.assertEqual(body['call']['status'], 'pending')
        self.assertEqual(body['rev'], 2)
        # duplicate rotation number (case-insensitive) -> 400
        status, body, _ = self.request('POST', '/api/vessel-calls', dict(payload, reference='rot-2026-9001'))
        self.assertEqual(status, 400)
        self.assertIn('already in use', body['error'])

    # ---- inspections & invoice snapshot ----
    def test_completed_liquid_inspection_snapshots_invoice(self):
        _, created, _ = self.request('POST', '/api/vessel-calls', {
            'vesselName': 'MT Snapshot', 'reference': 'ROT-2026-9002',
            'type': 'Tanker', 'nrt': 50000, 'berth': 'UNICEM Jetty'})
        call_id = created['call']['id']
        rev_before = created['rev']
        status, body, _ = self.request('POST', '/api/inspections', {
            'callId': call_id, 'cargoType': 'Liquid', 'status': 'completed',
            'reconciledTonnage': 41234.5,
            'jetty': {'type': 'International', 'category': None, 'name': 'UNICEM Jetty'},
            'liquid': {'ullage': 1.5, 'observedVol': 41500.0, 'temp': 30.0,
                       'surveyorTonnage': 41234.5, 'bl': 41300.0, 'outturn': 41234.5}})
        self.assertEqual(status, 201)
        self.assertGreater(body['rev'], rev_before)
        self.assertEqual(body['call']['status'], 'completed')
        inv = body['invoice']
        self.assertIsNotNone(inv)
        expected_dues = services.round2(50000 * 4.23)
        expected_comm = services.calc_commission(expected_dues, {'commissionRate': 3.5, 'exchangeRate': 1600})
        self.assertEqual(inv['dues'], expected_dues)
        self.assertEqual(inv['rate'], 4.23)
        self.assertEqual(inv['commissionUsd'], expected_comm['usd'])
        self.assertEqual(inv['commissionNgn'], expected_comm['ngn'])
        self.assertEqual(inv['fx'], 1600)
        self.assertEqual(inv['status'], 'unpaid')
        # the snapshot survives a settings change (the point of the fix)
        _, state, _ = self.request('GET', '/api/state')
        settings = dict(state['settings'])
        settings['liquidDuesRates'] = dict(settings['liquidDuesRates'], international=9.99)
        self.request('PUT', '/api/settings', settings)
        _, state, _ = self.request('GET', '/api/state')
        stored = next(v for v in state['invoices'] if v['id'] == inv['id'])
        self.assertEqual(stored['dues'], expected_dues)
        self.assertEqual(stored['rate'], 4.23)

    # ---- payment tracking ----
    def test_record_payment_stamps_snapshot_amount(self):
        status, body, _ = self.request('PUT', '/api/invoices/iv-002', {
            'status': 'paid',
            'payment': {'paidOn': '2026-06-20', 'method': 'Bank transfer',
                        'reference': 'NPA-TRF-99001', 'recordedBy': 'Bassey Effiong'}})
        self.assertEqual(status, 200)
        inv = body['invoice']
        self.assertEqual(inv['status'], 'paid')
        self.assertEqual(inv['payment']['amount'], 91530.60)  # snapshotted dues
        # a client-supplied amount is preserved
        status, body, _ = self.request('PUT', '/api/invoices/iv-004', {
            'status': 'paid',
            'payment': {'paidOn': '2026-06-21', 'method': 'Cash', 'reference': '', 'amount': 5.0}})
        self.assertEqual(status, 200)
        self.assertEqual(body['invoice']['payment']['amount'], 5.0)
        # clearing the payment keeps working
        status, body, _ = self.request('PUT', '/api/invoices/iv-002', {'status': 'unpaid', 'payment': None})
        self.assertEqual(status, 200)
        self.assertIsNone(body['invoice']['payment'])

    def test_update_unknown_invoice_is_400(self):
        status, body, _ = self.request('PUT', '/api/invoices/iv-nope', {'status': 'paid'})
        self.assertEqual(status, 400)
        self.assertIn('Unknown invoice', body['error'])

    # ---- organization ----
    def test_organization_roundtrip(self):
        org = {'registered': True, 'name': 'Test Org Ltd', 'rcNumber': 'RC-000001',
               'email': 'ops@test.ng', 'phone': '+234 000 000 0000', 'address': '1 Test Rd',
               'designatedPort': 'Onne Port, Rivers',
               'ports': ['Onne Port, Rivers', 'Port of Calabar'],
               'logo': None,
               'members': [{'id': 'u-001', 'name': 'Ada', 'email': 'ada@test.ng', 'role': 'Admin'}]}
        status, body, _ = self.request('PUT', '/api/organization', org)
        self.assertEqual(status, 200)
        _, state, _ = self.request('GET', '/api/state')
        self.assertEqual(state['rev'], body['rev'])
        self.assertEqual(state['org']['name'], 'Test Org Ltd')
        self.assertEqual(state['org']['ports'], ['Onne Port, Rivers', 'Port of Calabar'])
        self.assertEqual(state['org']['designatedPort'], 'Onne Port, Rivers')
        self.assertEqual(state['org']['members'][0]['role'], 'Admin')

    # ---- reset ----
    def test_reset_restores_seeds(self):
        self.request('POST', '/api/vessel-calls', {
            'vesselName': 'MT Ephemeral', 'reference': 'ROT-2026-9003', 'type': 'Tanker', 'nrt': 1000})
        _, state, _ = self.request('GET', '/api/state')
        self.assertEqual(len(state['calls']), len(SEED_CALLS) + 1)
        status, body, _ = self.request('POST', '/api/reset')
        self.assertEqual(status, 200)
        self.assertEqual(body['rev'], 1)
        _, state, _ = self.request('GET', '/api/state')
        self.assertEqual(len(state['calls']), len(SEED_CALLS))
        self.assertEqual(state['rev'], 1)

    # ---- static serving ----
    def test_static_frontend_served(self):
        url = 'http://127.0.0.1:%d/calabar/styles.css' % self.port
        with urllib.request.urlopen(url) as res:
            self.assertEqual(res.status, 200)
            self.assertTrue(res.read())

    # ---- no CORS headers by default ----
    def test_no_cors_headers_when_origin_unset(self):
        _, _, headers = self.request('GET', '/api/state')
        self.assertNotIn('Access-Control-Allow-Origin', headers)


class CorsTests(ServerTestCase):
    allow_origin = '*'

    def test_preflight_answers_204_with_cors_headers(self):
        status, body, headers = self.request('OPTIONS', '/api/state')
        self.assertEqual(status, 204)
        self.assertIsNone(body)
        self.assertEqual(headers.get('Access-Control-Allow-Origin'), '*')
        self.assertIn('PUT', headers.get('Access-Control-Allow-Methods', ''))
        self.assertIn('Content-Type', headers.get('Access-Control-Allow-Headers', ''))

    def test_api_responses_carry_cors_origin(self):
        status, state, headers = self.request('GET', '/api/state')
        self.assertEqual(status, 200)
        self.assertTrue(state['calls'])
        self.assertEqual(headers.get('Access-Control-Allow-Origin'), '*')


if __name__ == '__main__':
    unittest.main()
