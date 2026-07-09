"""Demo seeds — field-for-field the same records as calabar/data.jsx."""

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

# Invoices carry a money snapshot (dues/rate/commission/fx) frozen at issue
# time so later rate changes never rewrite what an invoice was worth.
# Figures = seed nrt × seed jetty rate under SEED_SETTINGS (fx 1600, 3.5%).
SEED_INVOICES = [
    {'id': 'iv-001', 'invoiceNo': 'INV-2026-0288', 'callId': 'vc-001', 'inspectionId': 'in-001', 'vesselName': 'MT Sea Eagle',    'callRef': 'ROT-2026-0438', 'status': 'paid',   'issued': '2026-06-02T14:10', 'due': '2026-06-09',
     'dues': 241689.51, 'rate': 4.23, 'commissionUsd': 8459.13, 'commissionNgn': 13534608, 'fx': 1600,
     'payment': {'paidOn': '2026-06-05', 'method': 'Bank transfer', 'reference': 'NPA-TRF-88213', 'recordedBy': 'Bassey Effiong', 'amount': 241689.51}},
    {'id': 'iv-002', 'invoiceNo': 'INV-2026-0287', 'callId': 'vc-002', 'inspectionId': 'in-002', 'vesselName': 'MV Calabar Pride', 'callRef': 'ROT-2026-0437', 'status': 'unpaid', 'issued': '2026-06-01T18:30', 'due': '2026-07-15',
     'dues': 91530.60, 'rate': 2.17, 'commissionUsd': 3203.57, 'commissionNgn': 5125712, 'fx': 1600, 'payment': None},
    {'id': 'iv-003', 'invoiceNo': 'INV-2026-0286', 'callId': 'vc-003', 'inspectionId': 'in-003', 'vesselName': 'MT Qua Iboe',      'callRef': 'ROT-2026-0436', 'status': 'paid',   'issued': '2026-05-31T10:20', 'due': '2026-06-07',
     'dues': 83781.60, 'rate': 1.68, 'commissionUsd': 2932.36, 'commissionNgn': 4691776, 'fx': 1600,
     'payment': {'paidOn': '2026-06-02', 'method': 'Bank transfer', 'reference': 'NPA-TRF-88102', 'recordedBy': 'Bassey Effiong', 'amount': 83781.60}},
    {'id': 'iv-004', 'invoiceNo': 'INV-2026-0285', 'callId': 'vc-004', 'inspectionId': 'in-004', 'vesselName': 'MV Atlantic Dawn', 'callRef': 'ROT-2026-0435', 'status': 'unpaid', 'issued': '2026-05-29T20:40', 'due': '2026-06-05',
     'dues': 133107.80, 'rate': 2.17, 'commissionUsd': 4658.77, 'commissionNgn': 7454032, 'fx': 1600, 'payment': None},
]

# Organization profile — fresh installs run the Register Organization
# onboarding in the frontend (registered: False).
SEED_ORG = {
    'registered': False,
    'name': '', 'rcNumber': '', 'email': '', 'phone': '', 'address': '',
    'designatedPort': 'Port of Calabar',
    'ports': ['Port of Calabar'],
    'logo': None,
    'members': [],
}


def normalize_org(org):
    """Mirror calabar/data.jsx normalizeOrg: unique ports list + valid designatedPort."""
    base = dict(SEED_ORG)
    if isinstance(org, dict):
        base.update(org)
    raw_ports = base.get('ports') if isinstance(base.get('ports'), list) else []
    if not raw_ports:
        raw_ports = [base.get('designatedPort') or 'Port of Calabar']
    ports = []
    for raw in raw_ports:
        port = str(raw or '').strip()
        if port and port not in ports:
            ports.append(port)
    if not ports:
        ports = ['Port of Calabar']
    designated = base.get('designatedPort') if base.get('designatedPort') in ports else ports[0]
    base['ports'] = ports
    base['designatedPort'] = designated
    return base
