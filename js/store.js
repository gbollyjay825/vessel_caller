/* ============================================================
   store.js — mock data + calc engine + async "api" layer.

   The api object mirrors the REST contract in spec §1.12 one-to-one.
   To go live, replace each method body with a fetch() to the matching
   endpoint — call sites and the rest of the UI do not change.

   The frontend never *decides* the regulatory maths; computeCharges()
   here stands in for the server's calc-preview / inspection endpoints
   so the live preview (§1.7.2) works offline. Swap it for the API call
   when wiring the backend.
   ============================================================ */

const STORAGE_KEY = "cpip:v1";

/* ---------- numeric helpers ---------- */
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const delay = (ms = 320) => new Promise((r) => setTimeout(r, ms));
const uid = (p) => `${p}_${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;

/* ============================================================
   Calc engine — single source of the figures the UI displays.
   ============================================================ */

/**
 * Harbour dues + agency commission from a reconciled cargo tonnage.
 * Tuned so 28,722.94 MT @ $1.85/MT, 3.5%, ₦1,600/$ reproduces the
 * spec showcase: $53,137.44 dues · $1,859.81 · ₦2,975,696.
 */
export function computeCharges(reconciledTonnage, charge) {
  const tonnage = Number(reconciledTonnage) || 0;
  const duesRatePerTon = charge.duesRatePerTon;
  const commissionRate = charge.commissionRate;
  const exchangeRate = charge.exchangeRate;

  const harbourDues = round2(tonnage * duesRatePerTon);
  const commissionUSD = round2((harbourDues * commissionRate) / 100);
  const commissionNGN = Math.round(commissionUSD * exchangeRate);

  return {
    reconciledTonnage: tonnage,
    duesRatePerTon,
    commissionRate,
    exchangeRate,
    harbourDues,
    commissionUSD,
    commissionNGN,
  };
}

/**
 * Liquid cargo → reconciled tonnage (mock of a server reconciliation).
 * GSV ≈ Gross Observed Volume × VCF; weight = GSV × density.
 */
export function reconcileLiquid(m) {
  const gov = Number(m.observedVolume) || 0; // m³
  const temp = Number(m.temperature);
  const density = Number(m.density) || 0; // t/m³ @15°C
  const vcf = Number.isFinite(temp) ? 1 - 0.00064 * (temp - 15) : 1;
  const gsv = gov * vcf;
  return round2(gsv * density);
}

/**
 * Dry / bulk cargo → reconciled tonnage via draft survey:
 * cargo = (displacement after − before) − deductibles − constant.
 */
export function reconcileDry(m) {
  const before = Number(m.displacementBefore) || 0;
  const after = Number(m.displacementAfter) || 0;
  const deductibles = Number(m.deductibles) || 0;
  const constant = Number(m.constant) || 0;
  return round2(after - before - deductibles - constant);
}

/* ============================================================
   Seed data
   ============================================================ */

const DEFAULT_SETTINGS = {
  charge: {
    commissionRate: 3.5, // %
    exchangeRate: 1600, // ₦ per $1
    duesRatePerTon: 1.85, // $ per MT (reconciled tonnage basis)
    duesBasis: "Reconciled cargo tonnage (per MT)",
  },
  notifications: {
    smtp: {
      host: "smtp.calabarport.ng",
      port: "587",
      user: "noreply@calabarport.ng",
      from: "Calabar Port <noreply@calabarport.ng>",
      connected: true,
    },
    sms: {
      accountSid: "ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      fromNumber: "+2348000000000",
      connected: false,
    },
  },
  port: {
    name: "Port of Calabar",
    terminals: [
      "Calabar Oil Terminal",
      "Calabar Bulk Terminal",
      "Calabar General Cargo Wharf",
      "Intels Calabar Terminal",
    ],
  },
};

function seed() {
  const charge = DEFAULT_SETTINGS.charge;

  const callDefs = [
    {
      ref: "ROT-2026-0440",
      vesselName: "MT Sea Phoenix",
      type: "Tanker",
      flag: "Liberia",
      nrt: 31240,
      eta: "2026-05-10T08:30",
      berth: "Calabar Oil Terminal",
      status: "completed",
      registeredDate: "2026-05-09T14:10",
      notes: "Crude parcel for Calabar refinery feedstock.",
      insp: {
        cargoCategory: "liquid",
        cargoType: "Crude Oil",
        tonnage: 28722.94,
        date: "2026-05-11T16:40",
        measurement: {
          ullage: 1.82,
          observedVolume: 34250,
          temperature: 28.5,
          density: 0.852,
          blQuantity: 28800,
          outturnQuantity: 28722.94,
        },
        invoiceStatus: "paid",
        issued: "2026-05-12T09:00",
      },
    },
    {
      ref: "ROT-2026-0441",
      vesselName: "MV Gulf Trader",
      type: "Bulk Carrier",
      flag: "Panama",
      nrt: 22890,
      eta: "2026-05-18T06:00",
      berth: "Calabar Bulk Terminal",
      status: "completed",
      registeredDate: "2026-05-17T11:20",
      notes: "",
      insp: {
        cargoCategory: "dry",
        cargoType: "Iron Ore",
        tonnage: 45000,
        date: "2026-05-19T13:15",
        measurement: {
          displacementBefore: 12500,
          displacementAfter: 58300,
          deductibles: 620,
          constant: 180,
        },
        invoiceStatus: "unpaid",
        issued: "2026-05-20T10:30",
      },
    },
    {
      ref: "ROT-2026-0442",
      vesselName: "MV Niger Star",
      type: "General Cargo",
      flag: "Nigeria",
      nrt: 9870,
      eta: "2026-06-02T07:45",
      berth: "Calabar General Cargo Wharf",
      status: "in-progress",
      registeredDate: "2026-06-01T15:05",
      notes: "Project cargo + bagged fertiliser.",
      insp: {
        draft: true,
        cargoCategory: "dry",
        cargoType: "Bagged Fertiliser",
        tonnage: 0,
        date: "2026-06-03T09:00",
        measurement: {
          displacementBefore: 6400,
          displacementAfter: 0,
          deductibles: 0,
          constant: 0,
        },
      },
    },
    {
      ref: "ROT-2026-0443",
      vesselName: "MV Atlantic Dawn",
      type: "Container",
      flag: "Marshall Islands",
      nrt: 18450,
      eta: "2026-06-12T05:30",
      berth: "Intels Calabar Terminal",
      status: "pending",
      registeredDate: "2026-06-08T16:40",
      notes: "",
    },
    {
      ref: "ROT-2026-0444",
      vesselName: "MT Calabar Spirit",
      type: "Tanker",
      flag: "Nigeria",
      nrt: 14220,
      eta: "2026-04-26T10:15",
      berth: "Calabar Oil Terminal",
      status: "completed",
      registeredDate: "2026-04-25T08:50",
      notes: "Coastal gasoil discharge.",
      insp: {
        cargoCategory: "liquid",
        cargoType: "Gasoil (AGO)",
        tonnage: 18500,
        date: "2026-04-27T12:00",
        measurement: {
          ullage: 2.4,
          observedVolume: 21900,
          temperature: 31.2,
          density: 0.845,
          blQuantity: 18540,
          outturnQuantity: 18500,
        },
        invoiceStatus: "overdue",
        issued: "2026-04-28T09:30",
      },
    },
    {
      ref: "ROT-2026-0445",
      vesselName: "MV Bonny River",
      type: "Bulk Carrier",
      flag: "Malta",
      nrt: 26310,
      eta: "2026-06-05T04:20",
      berth: "Calabar Bulk Terminal",
      status: "in-progress",
      registeredDate: "2026-06-04T18:00",
      notes: "",
    },
    {
      ref: "ROT-2026-0446",
      vesselName: "MV Delta Pride",
      type: "General Cargo",
      flag: "Togo",
      nrt: 7640,
      eta: "2026-06-15T09:00",
      berth: "Calabar General Cargo Wharf",
      status: "pending",
      registeredDate: "2026-06-09T07:30",
      notes: "",
    },
    {
      ref: "ROT-2026-0447",
      vesselName: "MT Cross River",
      type: "Tanker",
      flag: "Liberia",
      nrt: 16980,
      eta: "2026-05-28T11:40",
      berth: "Calabar Oil Terminal",
      status: "completed",
      registeredDate: "2026-05-27T13:25",
      notes: "Jet fuel import.",
      insp: {
        cargoCategory: "liquid",
        cargoType: "Jet A1",
        tonnage: 22300,
        date: "2026-05-29T15:10",
        measurement: {
          ullage: 1.95,
          observedVolume: 28100,
          temperature: 29.0,
          density: 0.802,
          blQuantity: 22360,
          outturnQuantity: 22300,
        },
        invoiceStatus: "paid",
        issued: "2026-05-30T08:15",
      },
    },
  ];

  const vesselCalls = [];
  const inspections = [];
  const invoices = [];
  let insSeq = 21;
  let invSeq = 440;

  for (const c of callDefs) {
    const callId = uid("call");
    const { insp, ...rest } = c;
    const call = { id: callId, ...rest, dues: null };

    if (insp) {
      const charges = computeCharges(insp.tonnage, charge);
      const insRef = `INS-2026-${String(insSeq++).padStart(4, "0")}`;
      const inspectionId = uid("insp");
      const isDraft = !!insp.draft;

      let invoiceFile = null;
      let reportFile = null;
      if (!isDraft) {
        invoiceFile = `invoice-${c.ref}.pdf`;
        reportFile = `report-${c.ref}.pdf`;
        call.dues = charges.harbourDues;
      }

      inspections.push({
        id: inspectionId,
        ref: insRef,
        callId,
        callRef: c.ref,
        vesselName: c.vesselName,
        cargoCategory: insp.cargoCategory,
        cargoType: insp.cargoType,
        reconciledTonnage: insp.tonnage,
        date: insp.date,
        status: isDraft ? "draft" : "completed",
        measurement: insp.measurement,
        charges: isDraft ? null : charges,
        invoiceFile,
        reportFile,
      });

      if (!isDraft) {
        const invNo = `INV-2026-${String(invSeq++).padStart(4, "0")}`;
        invoices.push({
          id: uid("inv"),
          invoiceNo: invNo,
          inspectionId,
          callRef: c.ref,
          vesselName: c.vesselName,
          amountUSD: charges.harbourDues,
          commissionUSD: charges.commissionUSD,
          commissionNGN: charges.commissionNGN,
          status: insp.invoiceStatus,
          issued: insp.issued,
          invoiceFile,
          reportFile,
          basis: {
            tonnage: insp.tonnage,
            duesRatePerTon: charges.duesRatePerTon,
            commissionRate: charges.commissionRate,
            exchangeRate: charges.exchangeRate,
            cargoType: insp.cargoType,
            cargoCategory: insp.cargoCategory,
          },
        });
      }
    } else {
      insSeq++; // keep refs spaced even without an inspection
    }

    vesselCalls.push(call);
  }

  return {
    settings: structuredClone(DEFAULT_SETTINGS),
    vesselCalls,
    inspections,
    invoices,
    counters: { call: 448, ins: insSeq, inv: invSeq },
  };
}

/* ============================================================
   Persistence (localStorage) so created records survive reload.
   ============================================================ */

let db;
function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch {
    /* ignore */
  }
  return null;
}
function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(db));
  } catch {
    /* storage may be unavailable; in-memory still works */
  }
}
db = load() || seed();

export function resetData() {
  db = seed();
  persist();
}

/* ============================================================
   Derived helpers
   ============================================================ */

function inspectionsForCall(callId) {
  return db.inspections.filter((i) => i.callId === callId);
}

function decorateCall(call) {
  const insps = inspectionsForCall(call.id);
  return { ...call, inspections: insps };
}

/* ============================================================
   api — mirrors spec §1.12 endpoints. All async to drive the
   loading/skeleton states (spec §1.11).
   ============================================================ */

export const api = {
  /* ---- Vessel calls ---- */
  async listVesselCalls() {
    await delay();
    return db.vesselCalls.map((c) => ({ ...c }));
  },

  async getVesselCall(id) {
    await delay();
    const call = db.vesselCalls.find((c) => c.id === id);
    if (!call) throw new Error("Vessel call not found");
    return decorateCall(call);
  },

  /** Next suggested reference, e.g. ROT-2026-0448. */
  suggestRef() {
    return `ROT-2026-${String(db.counters.call).padStart(4, "0")}`;
  },

  async checkRefUnique(ref) {
    await delay(500);
    return !db.vesselCalls.some(
      (c) => c.ref.toLowerCase() === String(ref).trim().toLowerCase()
    );
  },

  async createVesselCall(data) {
    await delay(600);
    if (db.vesselCalls.some((c) => c.ref.toLowerCase() === data.ref.toLowerCase())) {
      throw new Error(`Reference ${data.ref} already exists`);
    }
    const call = {
      id: uid("call"),
      ref: data.ref,
      vesselName: data.vesselName,
      type: data.type,
      flag: data.flag || "—",
      nrt: Number(data.nrt) || 0,
      eta: data.eta || null,
      berth: data.berth || "—",
      notes: data.notes || "",
      status: "pending",
      registeredDate: new Date().toISOString(),
      dues: null,
    };
    db.vesselCalls.unshift(call);
    if (call.ref === api.suggestRef()) db.counters.call += 1;
    persist();
    return { ...call };
  },

  /* ---- Inspections ---- */
  async listInspections() {
    await delay();
    return db.inspections.map((i) => ({ ...i }));
  },

  async getInspection(id) {
    await delay();
    const insp = db.inspections.find((i) => i.id === id);
    if (!insp) throw new Error("Inspection not found");
    return { ...insp };
  },

  /** Live charge preview — stands in for the calc-preview endpoint. */
  calcPreview({ reconciledTonnage }) {
    return computeCharges(reconciledTonnage, db.settings.charge);
  },

  async createInspection(data) {
    await delay(700);
    const call = db.vesselCalls.find((c) => c.id === data.callId);
    if (!call) throw new Error("Linked vessel call not found");

    const charges = computeCharges(data.reconciledTonnage, db.settings.charge);
    const ref = `INS-2026-${String(db.counters.ins++).padStart(4, "0")}`;
    const id = uid("insp");
    const isDraft = data.status === "draft";

    const invoiceFile = isDraft ? null : `invoice-${call.ref}.pdf`;
    const reportFile = isDraft ? null : `report-${call.ref}.pdf`;

    const inspection = {
      id,
      ref,
      callId: call.id,
      callRef: call.ref,
      vesselName: call.vesselName,
      cargoCategory: data.cargoCategory,
      cargoType: data.cargoType,
      reconciledTonnage: data.reconciledTonnage,
      date: new Date().toISOString(),
      status: isDraft ? "draft" : "completed",
      measurement: data.measurement || {},
      charges: isDraft ? null : charges,
      invoiceFile,
      reportFile,
    };
    db.inspections.unshift(inspection);

    if (!isDraft) {
      call.status = "completed";
      call.dues = charges.harbourDues;
      const invNo = `INV-2026-${String(db.counters.inv++).padStart(4, "0")}`;
      db.invoices.unshift({
        id: uid("inv"),
        invoiceNo: invNo,
        inspectionId: id,
        callRef: call.ref,
        vesselName: call.vesselName,
        amountUSD: charges.harbourDues,
        commissionUSD: charges.commissionUSD,
        commissionNGN: charges.commissionNGN,
        status: "unpaid",
        issued: new Date().toISOString(),
        invoiceFile,
        reportFile,
        basis: {
          tonnage: data.reconciledTonnage,
          duesRatePerTon: charges.duesRatePerTon,
          commissionRate: charges.commissionRate,
          exchangeRate: charges.exchangeRate,
          cargoType: data.cargoType,
          cargoCategory: data.cargoCategory,
        },
      });
    } else if (call.status === "pending") {
      call.status = "in-progress";
    }

    persist();
    return { ...inspection, charges };
  },

  /* ---- Invoices ---- */
  async listInvoices() {
    await delay();
    return db.invoices.map((i) => ({ ...i }));
  },

  async getInvoice(id) {
    await delay();
    const inv = db.invoices.find((i) => i.id === id);
    if (!inv) throw new Error("Invoice not found");
    return { ...inv };
  },

  /* ---- Settings ---- */
  async getSettings() {
    await delay(200);
    return structuredClone(db.settings);
  },

  async updateSettings(next) {
    await delay(500);
    db.settings = structuredClone(next);
    persist();
    return structuredClone(db.settings);
  },

  /* ---- Dashboard aggregates ---- */
  async getDashboard() {
    await delay();
    const activeCalls = db.vesselCalls.filter(
      (c) => c.status === "pending" || c.status === "in-progress"
    ).length;
    const inspectionsThisMonth = db.inspections.filter(
      (i) => i.status === "completed"
    ).length;
    const duesCollected = db.invoices
      .filter((i) => i.status === "paid")
      .reduce((s, i) => s + i.amountUSD, 0);
    const commissionUSD = db.invoices.reduce((s, i) => s + i.commissionUSD, 0);
    const commissionNGN = db.invoices.reduce((s, i) => s + i.commissionNGN, 0);
    return {
      activeCalls,
      inspectionsThisMonth,
      duesCollected,
      commissionUSD,
      commissionNGN,
      recentCalls: db.vesselCalls.slice(0, 6).map((c) => ({ ...c })),
    };
  },

  /* ---- PDF document model ----
     Synchronous join used by every PDF action button to assemble the
     printable invoice/report. In production each button instead opens
     GET /api/pdf/:filename directly; this stands in for that file. */
  buildDoc({ callId, inspectionId, invoiceId } = {}) {
    let invoice = invoiceId ? db.invoices.find((i) => i.id === invoiceId) : null;
    let inspection = inspectionId
      ? db.inspections.find((i) => i.id === inspectionId)
      : null;
    if (!inspection && invoice)
      inspection = db.inspections.find((i) => i.id === invoice.inspectionId);
    let call = callId ? db.vesselCalls.find((c) => c.id === callId) : null;
    if (!call && inspection)
      call = db.vesselCalls.find((c) => c.id === inspection.callId);
    if (!inspection && call)
      inspection = db.inspections.find(
        (i) => i.callId === call.id && i.status === "completed"
      );
    if (!invoice && inspection)
      invoice = db.invoices.find((i) => i.inspectionId === inspection.id);

    const charges =
      inspection?.charges ||
      (invoice
        ? {
            harbourDues: invoice.amountUSD,
            commissionUSD: invoice.commissionUSD,
            commissionNGN: invoice.commissionNGN,
            duesRatePerTon: invoice.basis.duesRatePerTon,
            commissionRate: invoice.basis.commissionRate,
            exchangeRate: invoice.basis.exchangeRate,
            reconciledTonnage: invoice.basis.tonnage,
          }
        : null);

    return {
      port: db.settings.port.name,
      vesselName: call?.vesselName || inspection?.vesselName || invoice?.vesselName,
      callRef: call?.ref || inspection?.callRef || invoice?.callRef,
      vesselType: call?.type,
      flag: call?.flag,
      nrt: call?.nrt,
      berth: call?.berth,
      eta: call?.eta,
      cargoType: inspection?.cargoType,
      cargoCategory: inspection?.cargoCategory,
      reconciledTonnage: charges?.reconciledTonnage ?? inspection?.reconciledTonnage,
      measurement: inspection?.measurement,
      duesRatePerTon: charges?.duesRatePerTon,
      harbourDues: charges?.harbourDues,
      commissionRate: charges?.commissionRate,
      commissionUSD: charges?.commissionUSD,
      exchangeRate: charges?.exchangeRate,
      commissionNGN: charges?.commissionNGN,
      invoiceNo: invoice?.invoiceNo,
      issued: invoice?.issued,
      invoiceStatus: invoice?.status,
      inspectionRef: inspection?.ref,
      inspectionDate: inspection?.date,
    };
  },

  /* ---- Current user (for the shell) ---- */
  getUser() {
    return { name: "Adaeze Okon", role: "Port Agent" };
  },
};
