/* global SEED_CALLS, SEED_INSPECTIONS, SEED_INVOICES, DEFAULT_SETTINGS, SEED_ORG, normalizeOrg, rateForInspection, calcDues, calcCommission */
// ============================================================
// api.jsx — the application wiring seam (backend client).
//
// At boot the client probes the Python backend (server.py):
//   - Backend present  -> all reads/writes go to the REST API and
//     SQLite is the source of truth. Clients poll /api/state?rev=N
//     so a capture on the mobile app appears on the desktop even
//     across different devices.
//   - Backend absent (e.g. the static Vercel deploy) -> falls back
//     to browser localStorage so the demo stays fully interactive.
//
// Every mutation returns a Promise in both modes; nothing else in
// the app knows where the data lives.
// ============================================================

const PORT_STORE_KEY = 'vessel-caller:v1';
let API_ON = false;

function apiActive() { return API_ON; }

async function apiFetch(path, options) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  let body = null;
  try { body = await res.json(); } catch (e) { /* non-JSON error body */ }
  if (!res.ok) throw new Error((body && body.error) || ('Request failed (' + res.status + ')'));
  return body;
}

// ---- boot ----
async function bootPortData() {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2500);
    const res = await fetch('/api/state', { signal: controller.signal });
    clearTimeout(timer);
    if (res.ok) {
      const state = await res.json();
      if (state && Array.isArray(state.calls)) {
        API_ON = true;
        if (state.org) state.org = normalizeOrg(state.org);
        return state; // { rev, calls, inspections, invoices, settings }
      }
    }
  } catch (e) { /* no backend — fall through to local mode */ }
  API_ON = false;
  return { rev: 0, ...loadLocalData() };
}

// ---- local fallback store ----
function loadLocalData() {
  try {
    const raw = localStorage.getItem(PORT_STORE_KEY);
    if (raw) {
      const d = JSON.parse(raw);
      if (d && Array.isArray(d.calls) && Array.isArray(d.inspections) && Array.isArray(d.invoices) && d.settings) {
        // migrate stores saved before the organization feature
        if (!d.org) d.org = SEED_ORG;
        d.org = normalizeOrg(d.org);
        return d;
      }
    }
  } catch (e) { /* corrupted store falls back to seeds */ }
  return {
    calls: SEED_CALLS,
    inspections: SEED_INSPECTIONS,
    invoices: SEED_INVOICES,
    settings: DEFAULT_SETTINGS,
    org: normalizeOrg(SEED_ORG),
  };
}

function savePortData(data) {
  if (API_ON) return; // backend is the source of truth
  try {
    localStorage.setItem(PORT_STORE_KEY, JSON.stringify(data));
  } catch (e) { /* storage unavailable — app still works in-memory */ }
}

// ------------------------------------------------------------
// Mutations — REST in backend mode, local engine in fallback.
// All return Promises with the same shapes.
// ------------------------------------------------------------

/** -> { call, rev } */
async function apiCreateCall(data) {
  if (API_ON) return apiFetch('/api/vessel-calls', { method: 'POST', body: JSON.stringify(data) });
  const call = {
    id: 'vc-' + Date.now(), ...data,
    berthDate: null, registered: new Date().toISOString().slice(0, 16),
  };
  return { call, rev: 0 };
}

/** -> { inspection, invoice|null, call, rev } */
async function apiCreateInspection(state, data) {
  if (API_ON) return apiFetch('/api/inspections', { method: 'POST', body: JSON.stringify(data) });
  const res = applyInspection(state, data);
  return { inspection: res.inspection, invoice: res.invoice, call: res.call, rev: 0 };
}

async function apiDeleteCall(callId) {
  if (API_ON) return apiFetch('/api/vessel-calls/' + encodeURIComponent(callId), { method: 'DELETE' });
  return { ok: true, rev: 0 };
}

async function apiUpdateSettings(settings) {
  if (API_ON) return apiFetch('/api/settings', { method: 'PUT', body: JSON.stringify(settings) });
  return { settings, rev: 0 };
}

async function apiUpdateOrganization(org) {
  org = normalizeOrg(org);
  if (API_ON) return apiFetch('/api/organization', { method: 'PUT', body: JSON.stringify(org) });
  return { org, rev: 0 };
}

/** Payment tracking: patch = { status, payment } -> { invoice, rev } */
async function apiUpdateInvoice(state, invoiceId, patch) {
  if (API_ON) return apiFetch('/api/invoices/' + encodeURIComponent(invoiceId), { method: 'PUT', body: JSON.stringify(patch) });
  const current = state.invoices.find((v) => v.id === invoiceId);
  if (!current) throw new Error('Unknown invoice');
  const invoice = { ...current, ...('status' in patch ? { status: patch.status } : {}), ...('payment' in patch ? { payment: patch.payment } : {}) };
  // a recorded payment settles the snapshotted dues — stamp the amount
  // unless the caller already sent one (mirrors the server)
  if (patch.payment && invoice.payment && invoice.payment.amount == null && current.dues != null) {
    invoice.payment = { ...invoice.payment, amount: current.dues };
  }
  return { invoice, rev: 0 };
}

async function apiResetData() {
  if (API_ON) return apiFetch('/api/reset', { method: 'POST' });
  try { localStorage.removeItem(PORT_STORE_KEY); } catch (e) { /* noop */ }
  return { ok: true, rev: 0 };
}

/** Poll: full state when the server rev moved on, else null. */
async function fetchStateIfChanged(rev) {
  if (!API_ON) return null;
  try {
    const state = await apiFetch('/api/state?rev=' + encodeURIComponent(rev));
    return state && state.changed === false ? null : state;
  } catch (e) {
    return null; // transient network error — next poll retries
  }
}

// ------------------------------------------------------------
// applyInspection — fallback mutation engine (mirrors the server's
// create_inspection). Adds the inspection; when completed it also
// marks the vessel call completed and issues the invoice.
// ------------------------------------------------------------
function applyInspection(state, data) {
  const { calls, inspections, invoices, settings } = state;

  const insNum = Math.max(0, ...inspections.map((i) => parseInt(i.reference.split('-')[2], 10) || 0)) + 1;
  const insId = 'in-' + Date.now();
  const sourceCall = calls.find((c) => c.id === data.callId) || {};
  const inspection = {
    id: insId,
    reference: `INS-2026-${insNum.toString().padStart(4, '0')}`,
    callId: data.callId,
    vesselName: sourceCall.vesselName || '—',
    cargoType: data.cargoType,
    reconciledTonnage: data.reconciledTonnage,
    date: new Date().toISOString().slice(0, 16),
    status: data.status,
    liquid: data.liquid,
    dry: data.dry,
    jetty: data.jetty || null,
  };

  let nextCalls = calls;
  let nextInvoices = invoices;
  let invoice = null;
  let call = calls.find((c) => c.id === data.callId);

  if (data.status === 'completed') {
    nextCalls = calls.map((c) => c.id === data.callId
      ? { ...c, status: 'completed', berthDate: c.berthDate || new Date().toISOString().slice(0, 10) }
      : c);
    call = nextCalls.find((c) => c.id === data.callId);
    const invNum = Math.max(0, ...invoices.map((v) => parseInt(v.invoiceNo.split('-')[2], 10) || 0)) + 1;
    // money snapshot — frozen at issue time so later rate changes never
    // rewrite what an invoice was worth (mirrors the server)
    const rate = rateForInspection(inspection, settings);
    const dues = calcDues(call ? call.nrt : 0, rate);
    const c = calcCommission(dues, settings);
    invoice = {
      id: 'iv-' + Date.now(),
      invoiceNo: `INV-2026-${invNum.toString().padStart(4, '0')}`,
      callId: data.callId,
      inspectionId: insId,
      vesselName: call ? call.vesselName : '—',
      callRef: call ? call.reference : '—',
      status: 'unpaid',
      issued: new Date().toISOString().slice(0, 16),
      due: new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10),
      dues, rate, commissionUsd: c.usd, commissionNgn: c.ngn, fx: settings.exchangeRate,
    };
    nextInvoices = [invoice, ...invoices];
  }

  return {
    state: { calls: nextCalls, inspections: [inspection, ...inspections], invoices: nextInvoices, settings },
    inspection,
    invoice,
    call,
  };
}

Object.assign(window, {
  PORT_STORE_KEY, apiActive, bootPortData, savePortData, applyInspection,
  apiCreateCall, apiCreateInspection, apiDeleteCall, apiUpdateSettings, apiResetData, fetchStateIfChanged,
  apiUpdateOrganization, apiUpdateInvoice,
});
