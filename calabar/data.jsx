// ============================================================
// Calabar Port — mock data, dues/commission calc, formatters
// The real app sources figures from the API; here we model them
// client-side so the prototype is fully interactive & consistent.
// ============================================================

// ---- Settings (charge configuration) ----
const DEFAULT_SETTINGS = {
  commissionRate: 3.5,        // %
  exchangeRate: 1600,         // USD -> NGN
  // Harbour-dues rates (USD per net-tonnage ton). Liquid cargo varies by
  // jetty classification; dry/bulk is a single flat rate. (Surveyor tariff.)
  liquidDuesRates: { government: 1.68, private: 2.88, international: 4.23 },
  dryDuesRate: 2.17,
  portName: 'Port of Calabar',
  terminals: ['Calabar New Port — Berth 3', 'Calabar Old Port — Berth 1', 'Intels Calabar Terminal', 'Calabar Bulk Terminal', 'UNICEM Jetty'],
  smtp: { host: 'smtp.calabarport.ng', port: '587', user: 'noreply@calabarport.ng', from: 'Calabar Port <noreply@calabarport.ng>', connected: true },
  sms: { sid: 'AC••••••••••••3f2a', from: '+2349011223344', connected: false },
};

// ---- Calc (mirrors the server-side maths) ----
// Harbour dues = net tonnage × the applicable rate. The rate for liquid
// cargo is set by jetty classification (government / private / international);
// dry/bulk uses the flat dry rate.
function rateForInspection(insp, settings) {
  if (!insp) return null;
  if (insp.cargoType === 'Dry') return settings.dryDuesRate;
  const j = insp.jetty || {};
  if (j.type === 'International') return settings.liquidDuesRates.international;
  if (j.type === 'Local' && j.category === 'Government') return settings.liquidDuesRates.government;
  if (j.type === 'Local' && j.category === 'Private') return settings.liquidDuesRates.private;
  return null;
}
function calcDues(netTonnage, rate) {
  if (!rate || rate <= 0) return 0;
  return Math.round((Number(netTonnage) || 0) * rate * 100) / 100;
}
function calcCommission(dues, settings) {
  const usd = Math.round(dues * (settings.commissionRate / 100) * 100) / 100;
  const ngn = Math.round(usd * settings.exchangeRate);
  return { usd, ngn };
}
function calcPreview(netTonnage, rate, settings) {
  const dues = calcDues(netTonnage, rate);
  const c = calcCommission(dues, settings);
  return { dues, rate, commissionUsd: c.usd, commissionNgn: c.ngn };
}

// ---- Formatters ----
function fmtUSD(n, dp = 2) {
  if (n == null || isNaN(n)) return '—';
  return '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
}
function fmtNGN(n) {
  if (n == null || isNaN(n)) return '—';
  return '₦' + Math.round(Number(n)).toLocaleString('en-US');
}
function fmtNum(n, dp = 0) {
  if (n == null || isNaN(n)) return '—';
  return Number(n).toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
}
function fmtTons(n) {
  if (n == null || isNaN(n)) return '—';
  return fmtNum(n, 2) + ' MTS';
}
function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}
function fmtDateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) +
    ' · ' + d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

// ---- Seed vessel calls ----
// status: pending | in-progress | completed
const SEED_CALLS = [
  { id: 'vc-001', vesselName: 'MT Sea Eagle',     reference: 'ROT-2026-0438', type: 'Tanker',        flag: 'Liberia',          nrt: 57137, eta: '2026-06-02T06:30', sailingEta: '2026-06-04T18:00', berth: 'UNICEM Jetty',                 berthDate: '2026-06-02', status: 'completed',   registered: '2026-05-29T10:12', notes: 'AGO cargo discharge. Pilot booked.' },
  { id: 'vc-002', vesselName: 'MV Calabar Pride',  reference: 'ROT-2026-0437', type: 'Bulk Carrier',  flag: 'Panama',           nrt: 42180, eta: '2026-06-01T14:00', sailingEta: '2026-06-03T20:00', berth: 'Calabar Bulk Terminal',        berthDate: '2026-06-01', status: 'completed',   registered: '2026-05-28T08:40', notes: 'Wheat in bulk, draft survey required.' },
  { id: 'vc-003', vesselName: 'MT Qua Iboe',       reference: 'ROT-2026-0436', type: 'Tanker',        flag: 'Liberia',          nrt: 49870, eta: '2026-05-30T22:15', sailingEta: '2026-06-01T12:00', berth: 'UNICEM Jetty',                 berthDate: '2026-05-31', status: 'completed',   registered: '2026-05-27T16:05', notes: '' },
  { id: 'vc-004', vesselName: 'MV Atlantic Dawn',  reference: 'ROT-2026-0435', type: 'Container',     flag: 'Singapore',        nrt: 61340, eta: '2026-05-29T09:00', sailingEta: '2026-05-31T10:00', berth: 'Calabar New Port — Berth 3',   berthDate: '2026-05-29', status: 'completed',   registered: '2026-05-26T11:22', notes: '' },
  { id: 'vc-005', vesselName: 'MT Niger Trader',   reference: 'ROT-2026-0439', type: 'Tanker',        flag: 'Marshall Islands', nrt: 38420, eta: '2026-06-07T05:45', sailingEta: '2026-06-09T16:00', berth: 'UNICEM Jetty',                 berthDate: '2026-06-07', status: 'in-progress', registered: '2026-06-04T09:30', notes: 'Ullage survey scheduled 08:00.' },
  { id: 'vc-006', vesselName: 'MV Cross River',    reference: 'ROT-2026-0440', type: 'Bulk Carrier',  flag: 'Nigeria',          nrt: 33500, eta: '2026-06-08T11:30', sailingEta: '2026-06-10T22:00', berth: 'Calabar Bulk Terminal',        berthDate: '2026-06-08', status: 'in-progress', registered: '2026-06-05T13:10', notes: 'Bagged fertiliser. Draft survey underway.' },
  { id: 'vc-007', vesselName: 'MT Bonny Spirit',   reference: 'ROT-2026-0441', type: 'Tanker',        flag: 'Nigeria',          nrt: 29760, eta: '2026-06-10T16:00', sailingEta: '2026-06-12T18:00', berth: 'Calabar Old Port — Berth 1',   berthDate: null,         status: 'pending',     registered: '2026-06-06T07:48', notes: '' },
  { id: 'vc-008', vesselName: 'MV Gulf Carrier',   reference: 'ROT-2026-0442', type: 'General Cargo', flag: 'Malta',            nrt: 18950, eta: '2026-06-11T08:20', sailingEta: '2026-06-13T14:00', berth: 'Calabar New Port — Berth 3',   berthDate: null,         status: 'pending',     registered: '2026-06-06T15:33', notes: 'Project cargo — heavy lift.' },
];

// ---- Seed inspections ----
// cargoType: Liquid | Dry  · status: draft | completed
const SEED_INSPECTIONS = [
  { id: 'in-001', reference: 'INS-2026-0312', callId: 'vc-001', vesselName: 'MT Sea Eagle',    cargoType: 'Liquid', reconciledTonnage: 48920.40, date: '2026-06-02T13:40', status: 'completed',
    jetty: { type: 'International', category: null, name: 'UNICEM Jetty' },
    liquid: { ullage: 1.82, observedVol: 49210.0, temp: 31.4, surveyorTonnage: 48920.40, bl: 49050.0, outturn: 48920.4 } },
  { id: 'in-002', reference: 'INS-2026-0311', callId: 'vc-002', vesselName: 'MV Calabar Pride', cargoType: 'Dry',    reconciledTonnage: 38470.00, date: '2026-06-01T18:05', status: 'completed',
    dry: { displBefore: 51230, displAfter: 12180, deductibles: 580, constant: 0 } },
  { id: 'in-003', reference: 'INS-2026-0310', callId: 'vc-003', vesselName: 'MT Qua Iboe',      cargoType: 'Liquid', reconciledTonnage: 41260.75, date: '2026-05-31T09:50', status: 'completed',
    jetty: { type: 'Local', category: 'Government', name: 'UNICEM Jetty' },
    liquid: { ullage: 2.10, observedVol: 41500.0, temp: 29.8, surveyorTonnage: 41260.75, bl: 41390.0, outturn: 41260.75 } },
  { id: 'in-004', reference: 'INS-2026-0309', callId: 'vc-004', vesselName: 'MV Atlantic Dawn', cargoType: 'Dry',    reconciledTonnage: 52310.00, date: '2026-05-29T20:15', status: 'completed',
    dry: { displBefore: 67400, displAfter: 14510, deductibles: 580, constant: 0 } },
  { id: 'in-005', reference: 'INS-2026-0313', callId: 'vc-005', vesselName: 'MT Niger Trader',  cargoType: 'Liquid', reconciledTonnage: 0, date: '2026-06-07T08:30', status: 'draft',
    jetty: { type: 'Local', category: 'Private', name: '' },
    liquid: { ullage: 1.55, observedVol: 0, temp: 30.2, surveyorTonnage: 0, bl: 33100.0, outturn: 0 } },
];

// ---- Seed invoices ----
// status: paid | unpaid | overdue
const SEED_INVOICES = [
  { id: 'iv-001', invoiceNo: 'INV-2026-0288', callId: 'vc-001', inspectionId: 'in-001', vesselName: 'MT Sea Eagle',    callRef: 'ROT-2026-0438', status: 'paid',   issued: '2026-06-02T14:10', due: '2026-06-09',
    payment: { paidOn: '2026-06-05', method: 'Bank transfer', reference: 'NPA-TRF-88213', recordedBy: 'Bassey Effiong' } },
  { id: 'iv-002', invoiceNo: 'INV-2026-0287', callId: 'vc-002', inspectionId: 'in-002', vesselName: 'MV Calabar Pride', callRef: 'ROT-2026-0437', status: 'unpaid', issued: '2026-06-01T18:30', due: '2026-07-15', payment: null },
  { id: 'iv-003', invoiceNo: 'INV-2026-0286', callId: 'vc-003', inspectionId: 'in-003', vesselName: 'MT Qua Iboe',      callRef: 'ROT-2026-0436', status: 'paid',   issued: '2026-05-31T10:20', due: '2026-06-07',
    payment: { paidOn: '2026-06-02', method: 'Bank transfer', reference: 'NPA-TRF-88102', recordedBy: 'Bassey Effiong' } },
  { id: 'iv-004', invoiceNo: 'INV-2026-0285', callId: 'vc-004', inspectionId: 'in-004', vesselName: 'MV Atlantic Dawn', callRef: 'ROT-2026-0435', status: 'unpaid', issued: '2026-05-29T20:40', due: '2026-06-05', payment: null },
];

const VESSEL_TYPES = ['Tanker', 'Bulk Carrier', 'Container', 'General Cargo', 'Other'];

// ---- Ports (lon, lat) for the voyage tracker ----
const PORT = {
  calabar:    { name: 'Calabar, Nigeria',     code: 'NGCBQ', lon: 8.32,  lat: 4.97 },
  lome:       { name: 'Lomé, Togo',           code: 'TGLFW', lon: 1.22,  lat: 6.13 },
  abidjan:    { name: 'Abidjan, Côte d’Ivoire',code: 'CIABJ', lon: -4.01, lat: 5.25 },
  tema:       { name: 'Tema, Ghana',          code: 'GHTEM', lon: 0.02,  lat: 5.62 },
  lagos:      { name: 'Apapa, Lagos',         code: 'NGLOS', lon: 3.36,  lat: 6.43 },
  douala:     { name: 'Douala, Cameroon',     code: 'CMDLA', lon: 9.70,  lat: 4.05 },
  cotonou:    { name: 'Cotonou, Benin',       code: 'BJCOO', lon: 2.43,  lat: 6.34 },
  takoradi:   { name: 'Takoradi, Ghana',      code: 'GHTKD', lon: -1.75, lat: 4.88 },
};

// ---- Voyages keyed by call id (destination is always Calabar) ----
// progress 0..1 along the route · navStatus per AIS
const VOYAGES = {
  'vc-001': { origin: 'lome',     progress: 1,    speed: 0,    course: 0,   draught: 11.2, navStatus: 'Moored',           mmsi: '636019214', imo: '9412305', callSign: 'D5QA7', lastReport: '2026-06-02T05:48' },
  'vc-002': { origin: 'douala',   progress: 1,    speed: 0,    course: 0,   draught: 10.4, navStatus: 'Moored',           mmsi: '352001138', imo: '9337210', callSign: '3FXR8', lastReport: '2026-06-01T13:10' },
  'vc-003': { origin: 'cotonou',  progress: 1,    speed: 0,    course: 0,   draught: 10.9, navStatus: 'Moored',           mmsi: '636017720', imo: '9388114', callSign: 'D5RT2', lastReport: '2026-05-31T07:20' },
  'vc-004': { origin: 'takoradi', progress: 1,    speed: 0,    course: 0,   draught: 12.1, navStatus: 'Moored',           mmsi: '563112000', imo: '9501338', callSign: '9V6312', lastReport: '2026-05-29T08:15' },
  'vc-005': { origin: 'lome',     progress: 0.93, speed: 8.4,  course: 96,  draught: 9.8,  navStatus: 'Under way using engine', mmsi: '538071224', imo: '9456319', callSign: 'V7DM4', lastReport: '2026-06-06T22:10' },
  'vc-006': { origin: 'lagos',    progress: 0.86, speed: 10.1, course: 121, draught: 9.1,  navStatus: 'Under way using engine', mmsi: '657124900', imo: '9277045', callSign: '5NBR9', lastReport: '2026-06-06T21:42' },
  'vc-007': { origin: 'abidjan',  progress: 0.58, speed: 12.6, course: 104, draught: 8.6,  navStatus: 'Under way using engine', mmsi: '657221140', imo: '9188233', callSign: '5NTQ7', lastReport: '2026-06-06T20:05' },
  'vc-008': { origin: 'tema',     progress: 0.39, speed: 13.2, course: 99,  draught: 7.9,  navStatus: 'Under way using engine', mmsi: '229884000', imo: '9622158', callSign: '9HA4721', lastReport: '2026-06-06T19:18' },
};

// quadratic-bezier point along a voyage (bows south into the Gulf of Guinea)
function bezierAt(o, d, t) {
  const mx = (o.lon + d.lon) / 2, my = (o.lat + d.lat) / 2;
  const dx = d.lon - o.lon, dy = d.lat - o.lat;
  const len = Math.hypot(dx, dy) || 1;
  // perpendicular offset, pushed south (negative lat) for a coastal arc
  const off = len * 0.16;
  const cx = mx + (dy / len) * 0 - 0, cy = my - off;
  const u = 1 - t;
  return {
    lon: u * u * o.lon + 2 * u * t * cx + t * t * d.lon,
    lat: u * u * o.lat + 2 * u * t * cy + t * t * d.lat,
  };
}
function haversineNm(a, b) {
  const R = 3440.065, toR = Math.PI / 180;
  const dLat = (b.lat - a.lat) * toR, dLon = (b.lon - a.lon) * toR;
  const la1 = a.lat * toR, la2 = b.lat * toR;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(h)));
}
function bearing(a, b) {
  const toR = Math.PI / 180, toD = 180 / Math.PI;
  const dLon = (b.lon - a.lon) * toR;
  const y = Math.sin(dLon) * Math.cos(b.lat * toR);
  const x = Math.cos(a.lat * toR) * Math.sin(b.lat * toR) - Math.sin(a.lat * toR) * Math.cos(b.lat * toR) * Math.cos(dLon);
  return Math.round((Math.atan2(y, x) * toD + 360) % 360);
}
function fmtLatLon(lon, lat) {
  const fmt = (v, pos, neg) => {
    const dir = v >= 0 ? pos : neg, av = Math.abs(v);
    const deg = Math.floor(av), min = ((av - deg) * 60).toFixed(1);
    return `${deg}°${min.padStart(4, '0')}′${dir}`;
  };
  return { lat: fmt(lat, 'N', 'S'), lon: fmt(lon, 'E', 'W') };
}

const CURRENT_USER = { name: 'Etim Okon', role: 'Port Agent', initials: 'EO' };

// ---- Organization, roles & permissions ----
const NPA_PORTS = [
  'Port of Calabar',
  'Apapa Port, Lagos',
  'Tin Can Island Port, Lagos',
  'Onne Port, Rivers',
  'Port Harcourt Port',
  'Warri Port, Delta',
];

const ROLES = ['Admin', 'Operations', 'Finance', 'Viewer'];

// action -> roles allowed. Viewer is read-only everywhere.
const PERMS = {
  registerCall:   ['Admin', 'Operations'],
  cancelCall:     ['Admin', 'Operations'],
  addInspection:  ['Admin', 'Operations'],
  recordPayment:  ['Admin', 'Finance'],
  manageSettings: ['Admin'],
  manageTeam:     ['Admin'],
};
function canUser(user, action) {
  const allowed = PERMS[action];
  return !!(user && allowed && allowed.indexOf(user.role) !== -1);
}
function userInitials(name) {
  return String(name || '?').trim().split(/\s+/).slice(0, 2).map((p) => p[0] || '').join('').toUpperCase() || '?';
}

// Fresh installs run the Register Organization onboarding (registered:false).
// "Use demo organization" fills DEMO_ORG_PROFILE for quick walk-throughs.
const SEED_ORG = {
  registered: false,
  name: '', rcNumber: '', email: '', phone: '', address: '',
  designatedPort: 'Port of Calabar',
  ports: ['Port of Calabar'],
  logo: null, // data-URL image set via Upload logo
  members: [],
};
const DEMO_ORG_PROFILE = {
  registered: true,
  name: 'Vessel Caller Ltd', rcNumber: 'RC-482913',
  email: 'ops@vesselcaller.ng', phone: '+234 901 122 3344',
  address: '14 Marina Road, Calabar, Cross River',
  designatedPort: 'Port of Calabar',
  ports: ['Port of Calabar', 'Onne Port, Rivers'],
  logo: null,
  members: [
    { id: 'u-001', name: 'Etim Okon',      email: 'etim@vesselcaller.ng',   role: 'Admin' },
    { id: 'u-002', name: 'Adaeze Nwosu',   email: 'adaeze@vesselcaller.ng', role: 'Operations' },
    { id: 'u-003', name: 'Bassey Effiong', email: 'bassey@vesselcaller.ng', role: 'Finance' },
    { id: 'u-004', name: 'Ngozi Kalu',     email: 'ngozi@vesselcaller.ng',  role: 'Viewer' },
  ],
};

function uniquePorts(ports) {
  const out = [];
  (Array.isArray(ports) ? ports : []).forEach((p) => {
    const port = String(p || '').trim();
    if (port && out.indexOf(port) === -1) out.push(port);
  });
  return out;
}
function normalizeOrg(org) {
  const base = { ...SEED_ORG, ...(org || {}) };
  let ports = uniquePorts(base.ports);
  if (!ports.length) ports = uniquePorts([base.designatedPort || NPA_PORTS[0]]);
  const designatedPort = ports.indexOf(base.designatedPort) !== -1 ? base.designatedPort : ports[0];
  return { ...base, ports, designatedPort };
}
function orgPorts(org) {
  return normalizeOrg(org).ports;
}
function primaryOrgPort(org, fallback = 'Port of Calabar') {
  return normalizeOrg(org).designatedPort || fallback;
}
function orgPortsLabel(org, fallback = 'Port of Calabar') {
  const ports = orgPorts(org);
  if (ports.length <= 1) return ports[0] || fallback;
  return `${ports[0]} + ${ports.length - 1} more`;
}

// ---- Invoice payment tracking ----
// Stored status is paid | unpaid; "overdue" is DERIVED from the due date so
// tracking stays automatic. payment = {paidOn, method, reference, recordedBy}.
function effectiveInvoiceStatus(inv) {
  if (!inv) return 'unpaid';
  if (inv.status === 'paid') return 'paid';
  if (inv.due && new Date(inv.due + 'T23:59:59') < new Date()) return 'overdue';
  return 'unpaid';
}

Object.assign(window, {
  DEFAULT_SETTINGS, SEED_CALLS, SEED_INSPECTIONS, SEED_INVOICES, VESSEL_TYPES, CURRENT_USER,
  SEED_ORG, DEMO_ORG_PROFILE, NPA_PORTS, ROLES, PERMS, canUser, userInitials,
  normalizeOrg, orgPorts, primaryOrgPort, orgPortsLabel, effectiveInvoiceStatus,
  PORT, VOYAGES, bezierAt, haversineNm, bearing, fmtLatLon,
  calcDues, calcCommission, calcPreview, rateForInspection,
  fmtUSD, fmtNGN, fmtNum, fmtTons, fmtDate, fmtDateTime,
});
