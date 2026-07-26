// Inspections — list of logged inspections + the 3-step "New inspection" wizard.
// Ported from calabar/screens-inspections.jsx (window-globals) to ES modules.
import { useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "../lib/navigation";

import { useStore } from "../app/store";
import { Icon } from "../components/Icon";
import {
  CargoTag, DataTable, EmptyState, Field, LiveCalc, PdfButton, StatusBadge, Stepper,
  type Column,
} from "../components/ui";
import { calcPreview, rateForInspection } from "../lib/calc";
import { fmtDate, fmtNGN, fmtNum, fmtTons, fmtUSD } from "../lib/format";
import type { CargoType, Inspection, Invoice, VesselCall } from "../types";

type StoreApi = ReturnType<typeof useStore>;

// ---- reconciled-tonnage maths (mirrors server) ----
function computeReconciled(cargoType: string, m: any): number {
  if (cargoType === "Liquid") {
    // Liquid cargo is reconciled by the surveyor and entered directly.
    return Math.round((Number(m.surveyorTonnage) || 0) * 100) / 100;
  }
  const before = Number(m.displBefore) || 0, after = Number(m.displAfter) || 0;
  const ded = Number(m.deductibles) || 0, con = Number(m.constant) || 0;
  return Math.round((before - after - ded + con) * 100) / 100;
}

// =========================================================
// Inspections — list
// =========================================================
export function Inspections() {
  const store = useStore();
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [cargoFilter, setCargoFilter] = useState<string>("all");

  const rows = useMemo(() => store.inspections
    .filter((i) => {
      if (cargoFilter !== "all" && i.cargoType !== cargoFilter) return false;
      if (query) { const q = query.toLowerCase(); return i.reference.toLowerCase().includes(q) || i.vesselName.toLowerCase().includes(q); }
      return true;
    })
    .sort((a, b) => +new Date(b.date) - +new Date(a.date)), [store.inspections, query, cargoFilter]);

  const columns: Column<Inspection>[] = [
    { key: "reference", label: "Reference", sortable: true, render: (r) => <span className="cell-primary mono-ref" style={{ color: "var(--ink)", fontWeight: 600 }}>{r.reference}</span> },
    { key: "vesselName", label: "Vessel", sortable: true, render: (r) => r.vesselName },
    { key: "cargoType", label: "Cargo Type", render: (r) => <CargoTag type={r.cargoType} /> },
    { key: "reconciledTonnage", label: "Reconciled Tonnage", num: true, sortable: true, render: (r) => <span className="tnum">{r.status === "draft" ? "—" : fmtTons(r.reconciledTonnage)}</span> },
    { key: "date", label: "Date", sortable: true, sortVal: (r) => r.date, render: (r) => <span className="tnum muted">{fmtDate(r.date)}</span> },
    { key: "status", label: "Status", sortable: true, render: (r) => <StatusBadge status={r.status} /> },
    {
      key: "actions", label: "", num: true, render: (r) => {
        return (
          <div className="cell-actions">
            {r.status === "completed"
              ? <PdfButton kind="report" id={r.id} />
              : r.status === "draft"
                ? <button className="link-btn" onClick={() => navigate("/app/inspections/new?inspectionId=" + r.id)}>Resume <Icon name="chevronRight" size={14} strokeWidth={2.2} style={{ verticalAlign: "-2px" }} /></button>
                : null}
          </div>
        );
      },
    },
  ];

  const FILTERS: [string, string][] = [["all", "All"], ["Liquid", "Liquid"], ["Dry", "Dry"]];

  return (
    <div className="content-inner">
      <div className="page-head">
        <div>
          <h1 className="hide-sr">Inspections</h1>
          <p className="desc">Liquid and dry cargo inspections logged against vessel calls.</p>
        </div>
        <button className="btn btn-primary" disabled={!store.can("addInspection")}
          title={store.can("addInspection") ? undefined : "Requires the Admin or Operations role"}
          onClick={() => navigate("/app/inspections/new")}>
          <Icon name="plus" size={17} strokeWidth={2.2} /> New Inspection
        </button>
      </div>

      <div className="filter-bar">
        <div className="search-input">
          <Icon name="search" size={17} />
          <input type="text" placeholder="Search reference or vessel…" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search inspections" />
        </div>
        <div className="seg" role="tablist" aria-label="Filter by cargo type">
          {FILTERS.map(([k, l]) => <button key={k} className={cargoFilter === k ? "on" : ""} onClick={() => setCargoFilter(k)}>{l}</button>)}
        </div>
      </div>

      <div className="card">
        <DataTable columns={columns} rows={rows} getKey={(r) => r.id}
          emptyState={<EmptyState icon="clipboard" title="No inspections yet" body="Start an inspection from a vessel call or create a new one." action={<button className="btn btn-primary" disabled={!store.can("addInspection")} onClick={() => navigate("/app/inspections/new")}><Icon name="plus" size={17} strokeWidth={2.2} /> New Inspection</button>} />} />
      </div>
    </div>
  );
}

// =========================================================
// New Inspection — 3-step wizard
// =========================================================
const WIZARD_STEPS = ["Link & type", "Cargo measurement", "Review & submit"];

interface LiquidMeasure {
  ullage: string; observedVol: string; temp: string; blQty: string;
  surveyorTonnage: string; jettyType: string; jettyCategory: string; jettyName: string;
}
interface DryMeasure { displBefore: string; displAfter: string; deductibles: string; constant: string; }

interface Submitted {
  invoice: Invoice | null;
  inspectionId: string | null;
  queued: boolean;
  call: VesselCall;
  reconciled: number;
  financials: { dues: number; commissionUsd: number; commissionNgn: number };
}

export function NewInspection() {
  const store = useStore();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const draftId = params.get("inspectionId") || "";
  const draft = store.inspections.find((inspection) => inspection.id === draftId);
  const lockedCallId = params.get("callId") || draft?.callId || "";
  const text = (value: unknown, fallback = "") => (
    value === null || value === undefined ? fallback : String(value)
  );

  const [step, setStep] = useState(draft ? 1 : 0);
  const [callId, setCallId] = useState(lockedCallId || "");
  const [cargoType, setCargoType] = useState<"" | CargoType>(draft?.cargoType ?? "");
  const [liquid, setLiquid] = useState<LiquidMeasure>({
    ullage: text(draft?.liquid?.ullage),
    observedVol: text(draft?.liquid?.observedVol),
    temp: text(draft?.liquid?.temp),
    blQty: text(draft?.liquid?.blQty),
    surveyorTonnage: text(draft?.liquid?.surveyorTonnage, draft ? String(draft.reconciledTonnage || "") : ""),
    jettyType: text(draft?.jetty?.type),
    jettyCategory: text(draft?.jetty?.category),
    jettyName: text(draft?.jetty?.name),
  });
  const [dry, setDry] = useState<DryMeasure>({
    displBefore: text(draft?.dry?.displBefore),
    displAfter: text(draft?.dry?.displAfter),
    deductibles: text(draft?.dry?.deductibles),
    constant: text(draft?.dry?.constant, "0"),
  });
  const [submitted, setSubmitted] = useState<Submitted | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const call = store.calls.find((c) => c.id === callId);
  const measure = cargoType === "Liquid" ? liquid : dry;
  const reconciled = useMemo(() => computeReconciled(cargoType, measure), [cargoType, liquid, dry]);
  const previewRate = rateForInspection(
    { cargoType, jetty: { type: liquid.jettyType, category: liquid.jettyType === "Local" ? liquid.jettyCategory : null } } as any,
    store.settings,
  );
  const preview = call ? calcPreview(call.nrt, previewRate, store.settings) : null;

  const jettyOk = cargoType !== "Liquid" || liquid.jettyType === "International" || (liquid.jettyType === "Local" && !!liquid.jettyCategory);
  const canNext0 = !!callId && !!cargoType;
  const canNext1 = reconciled > 0 && jettyOk;

  // ---- success screen ----
  if (submitted) {
    // Financials are snapshotted at submit time so a cross-tab write can
    // never null them out from under this screen.
    const { invoice, inspectionId, queued, call: sc, reconciled: rec, financials: f } = submitted;
    const insp = inspectionId ? store.inspections.find((i) => i.id === inspectionId) : undefined;
    const reference = insp?.reference || invoice?.invoiceNo || "The inspection";
    return (
      <div className="content-inner">
        <div className="success-wrap">
          <div className="success-check"><Icon name="check" size={38} strokeWidth={2.4} /></div>
          <h2>{queued ? "Inspection queued" : "Inspection submitted"}</h2>
          <p>
            {queued
              ? `${sc.vesselName} is stored securely on this device and will submit when the connection returns.`
              : `${reference} for ${sc.vesselName} has been recorded and the invoice generated.`}
          </p>

          <div className="card card-pad result-card">
            <div className="fin-row"><div className="fl">Reconciled tonnage</div><div className="fv tnum">{fmtTons(rec)}</div></div>
            <div className="fin-row"><div className="fl">NPA harbour dues</div><div className="fv tnum">{fmtUSD(f.dues)}</div></div>
            <div className="fin-row"><div className="fl">Commission · {store.settings.commissionRate}%</div><div className="fv tnum">{fmtUSD(f.commissionUsd)} <span style={{ color: "var(--slate)", fontWeight: 500 }}>· {fmtNGN(f.commissionNgn)}</span></div></div>
          </div>

          {!queued && (
            <div className="success-actions">
              <PdfButton kind="invoice" id={invoice?.id} />
              <PdfButton kind="report" id={inspectionId} />
            </div>
          )}
          <button className="link-btn" style={{ marginTop: 20 }} onClick={() => navigate("/app")}>Back to dashboard</button>
        </div>
      </div>
    );
  }

  const doSubmit = async (asDraft: boolean) => {
    setSubmitting(true);
    try {
      const result = await store.addInspection({
        callId, cargoType, reconciledTonnage: asDraft ? 0 : reconciled,
        status: asDraft ? "draft" : "completed",
        liquid: cargoType === "Liquid" ? liquid : undefined,
        dry: cargoType === "Dry" ? dry : undefined,
        jetty: cargoType === "Liquid"
          ? { type: liquid.jettyType, category: liquid.jettyType === "Local" ? liquid.jettyCategory : null, name: liquid.jettyName.trim() }
          : null,
        ...(draft ? { version: draft.version } : {}),
      }, { inspectionId: draft?.id });
      if (asDraft) {
        store.toast(result.queued ? "Draft queued and will sync when online" : "Draft inspection saved", "info");
        navigate("/app/inspections");
      } else if (call) {
        // snapshot the confirmed figures (prefer the server's issued invoice)
        setSubmitted({
          invoice: result.invoice,
          inspectionId: result.inspectionId,
          queued: result.queued,
          call,
          reconciled,
          financials: {
            dues: result.invoice?.dues ?? preview?.dues ?? 0,
            commissionUsd: result.invoice?.commissionUsd ?? preview?.commissionUsd ?? 0,
            commissionNgn: result.invoice?.commissionNgn ?? preview?.commissionNgn ?? 0,
          },
        });
      }
    } catch (e: any) {
      store.toast(e.message || "Could not submit the inspection", "error");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="content-inner">
      <button className="link-btn" style={{ marginBottom: 16 }} onClick={() => navigate(lockedCallId ? "/app/vessel-calls/" + lockedCallId : "/app/inspections")}>
        <Icon name="chevronLeft" size={15} strokeWidth={2.2} style={{ verticalAlign: "-3px" }} /> {lockedCallId ? "Back to vessel call" : "Inspections"}
      </button>
      <div className="page-head" style={{ marginBottom: 24 }}>
        <div><h1>{draft ? "Resume Inspection" : "New Inspection"}</h1><p className="desc">Reconcile cargo and generate the dues invoice.</p></div>
      </div>

      <div className="card card-pad" style={{ marginBottom: 24 }}>
        <Stepper steps={WIZARD_STEPS} current={step} />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: step === 1 ? "1fr 320px" : "1fr", gap: 24, alignItems: "start" }}>
        <div className="card card-pad">
          {/* ---------- Step 1 ---------- */}
          {step === 0 && (
            <div>
              <div className="card-title" style={{ marginBottom: 18 }}>Link to a vessel call</div>
              {lockedCallId && call ? (
                <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 14px", border: "1px solid var(--hairline)", borderRadius: 8, background: "var(--accent-tint-2)" }}>
                  <Icon name="ship" size={20} style={{ color: "var(--accent)" }} />
                  <div><div style={{ fontWeight: 600 }}>{call.vesselName}</div><div className="mono-ref">{call.reference} · {call.type}</div></div>
                  <span className="tag" style={{ marginLeft: "auto" }}>Locked</span>
                </div>
              ) : (
                <CallCombobox store={store} value={callId} onChange={setCallId} />
              )}

              <div className="card-title" style={{ margin: "28px 0 18px" }}>Cargo category</div>
              <div className="big-seg">
                <button className={cargoType === "Liquid" ? "on" : ""} onClick={() => setCargoType("Liquid")}>
                  <div className="bs-ic"><Icon name="droplet" size={22} strokeWidth={1.8} /></div>
                  <div><div className="bs-t">Liquid cargo</div><div className="bs-d">Ullage / sounding, observed volume &amp; the surveyor's reconciled tonnage, with jetty-based dues.</div></div>
                </button>
                <button className={cargoType === "Dry" ? "on" : ""} onClick={() => setCargoType("Dry")}>
                  <div className="bs-ic"><Icon name="package" size={22} strokeWidth={1.8} /></div>
                  <div><div className="bs-t">Dry / bulk cargo</div><div className="bs-d">Draft survey — displacement before / after, deductibles &amp; constants.</div></div>
                </button>
              </div>

              <div className="flex between mt-6" style={{ marginTop: 28 }}>
                <span />
                <button className="btn btn-primary" disabled={!canNext0} onClick={() => setStep(1)}>Continue <Icon name="arrowRight" size={16} strokeWidth={2.2} /></button>
              </div>
            </div>
          )}

          {/* ---------- Step 2 ---------- */}
          {step === 1 && (
            <div>
              <div className="flex between items-center" style={{ marginBottom: 18 }}>
                <div className="card-title">{cargoType === "Liquid" ? "Liquid cargo measurement" : "Draft survey"}</div>
                <CargoTag type={cargoType} />
              </div>

              {cargoType === "Liquid" ? (
                <>
                  <div className="field-row">
                    <Field label="Ullage / sounding (m)"><input type="number" step="0.01" value={liquid.ullage} placeholder="0.00" onChange={(e) => setLiquid({ ...liquid, ullage: e.target.value })} /></Field>
                    <Field label="Observed volume (m³)"><input type="number" step="0.1" value={liquid.observedVol} placeholder="0.0" onChange={(e) => setLiquid({ ...liquid, observedVol: e.target.value })} /></Field>
                  </div>
                  <div className="field-row">
                    <Field label="Temperature (°C)"><input type="number" step="0.1" value={liquid.temp} placeholder="15.0" onChange={(e) => setLiquid({ ...liquid, temp: e.target.value })} /></Field>
                    <Field label="Bill of Lading quantity (MT)" hint="For variance against the surveyor's figure."><input type="number" step="0.01" value={liquid.blQty} placeholder="0.00" onChange={(e) => setLiquid({ ...liquid, blQty: e.target.value })} /></Field>
                  </div>
                  <Field label="Reconciled Surveyor's Tonnage (MT)" required hint="The surveyor's reconciled cargo quantity — the dues basis of record.">
                    <input type="number" step="0.01" value={liquid.surveyorTonnage} placeholder="0.00" onChange={(e) => setLiquid({ ...liquid, surveyorTonnage: e.target.value })} />
                  </Field>
                  <div className="field-row">
                    <Field label="Jetty type" required>
                      <select value={liquid.jettyType} onChange={(e) => setLiquid({ ...liquid, jettyType: e.target.value, jettyCategory: e.target.value === "Local" ? liquid.jettyCategory : "" })}>
                        <option value="">Select jetty type…</option>
                        <option value="Local">Local Jetty</option>
                        <option value="International">International Jetty</option>
                      </select>
                    </Field>
                    {liquid.jettyType === "Local" && (
                      <Field label="Jetty category" required>
                        <select value={liquid.jettyCategory} onChange={(e) => setLiquid({ ...liquid, jettyCategory: e.target.value })}>
                          <option value="">Select category…</option>
                          <option value="Government">Government Jetty</option>
                          <option value="Private">Private Jetty</option>
                        </select>
                      </Field>
                    )}
                  </div>
                  <Field label="Jetty name" hint="The specific jetty / berth the vessel worked.">
                    <input type="text" value={liquid.jettyName} placeholder="e.g. UNICEM Jetty" onChange={(e) => setLiquid({ ...liquid, jettyName: e.target.value })} />
                  </Field>
                </>
              ) : (
                <>
                  <div className="field-row">
                    <Field label="Displacement before (MT)" required><input type="number" step="1" value={dry.displBefore} placeholder="0" onChange={(e) => setDry({ ...dry, displBefore: e.target.value })} /></Field>
                    <Field label="Displacement after (MT)" required><input type="number" step="1" value={dry.displAfter} placeholder="0" onChange={(e) => setDry({ ...dry, displAfter: e.target.value })} /></Field>
                  </div>
                  <div className="field-row">
                    <Field label="Deductibles (MT)" hint="Ballast, fuel, fresh water, stores."><input type="number" step="1" value={dry.deductibles} placeholder="0" onChange={(e) => setDry({ ...dry, deductibles: e.target.value })} /></Field>
                    <Field label="Constant (MT)"><input type="number" step="1" value={dry.constant} onChange={(e) => setDry({ ...dry, constant: e.target.value })} /></Field>
                  </div>
                </>
              )}

              <div className="flex between" style={{ marginTop: 12 }}>
                <button className="btn btn-secondary" onClick={() => setStep(0)}><Icon name="chevronLeft" size={16} strokeWidth={2.2} /> Back</button>
                <button className="btn btn-primary" disabled={!canNext1} onClick={() => setStep(2)}>Review <Icon name="arrowRight" size={16} strokeWidth={2.2} /></button>
              </div>
            </div>
          )}

          {/* ---------- Step 3 ---------- */}
          {step === 2 && call && preview && (
            <div>
              <div className="card-title" style={{ marginBottom: 18 }}>Review &amp; submit</div>
              <div className="kv-grid" style={{ marginBottom: 22 }}>
                <div className="kv"><div className="k">Vessel</div><div className="v">{call.vesselName}</div></div>
                <div className="kv"><div className="k">Rotation number</div><div className="v mono-ref" style={{ color: "var(--ink)" }}>{call.reference}</div></div>
                <div className="kv"><div className="k">Cargo type</div><div className="v"><CargoTag type={cargoType} /></div></div>
                <div className="kv"><div className="k">Reconciled tonnage</div><div className="v tnum">{fmtTons(reconciled)}</div></div>
                {cargoType === "Liquid" && (
                  <div className="kv"><div className="k">Jetty</div><div className="v">{liquid.jettyType === "International" ? "International Jetty" : `${liquid.jettyCategory} Jetty · Local`}{liquid.jettyName ? ` — ${liquid.jettyName}` : ""}</div></div>
                )}
              </div>

              <div className="live-calc" style={{ marginBottom: 8 }}>
                <div className="lc-label"><Icon name="gauge" size={14} strokeWidth={2} /> Calculated charges — preview</div>
                <div style={{ marginTop: 12 }}>
                  <div className="fin-row"><div className="fl">NPA harbour dues<span className="basis">{fmtNum(call.nrt)} NT × {fmtUSD(previewRate)}/ton · {cargoType === "Liquid" ? `${liquid.jettyType === "International" ? "International" : liquid.jettyCategory} jetty` : "dry rate"}</span></div><div className="fv tnum">{fmtUSD(preview.dues)}</div></div>
                  <div className="fin-row"><div className="fl">Commission · {store.settings.commissionRate}%</div><div className="fv tnum">{fmtUSD(preview.commissionUsd)} · {fmtNGN(preview.commissionNgn)}</div></div>
                </div>
                <div className="lc-foot">These figures are confirmed before submission. The server is the single source of truth on submit.</div>
              </div>

              <div className="flex between" style={{ marginTop: 22 }}>
                <button className="btn btn-secondary" onClick={() => setStep(1)} disabled={submitting}><Icon name="chevronLeft" size={16} strokeWidth={2.2} /> Back</button>
                <div className="flex gap-3">
                  <button className="btn btn-ghost" onClick={() => doSubmit(true)} disabled={submitting}>Save draft</button>
                  <button className="btn btn-primary" onClick={() => doSubmit(false)} disabled={submitting}>
                    {submitting ? <><Icon name="spinner" size={16} className="spin" strokeWidth={2} /> Submitting…</> : "Submit Inspection"}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* ---- right rail: running reconciled tonnage (step 2) ---- */}
        {step === 1 && (
          <div style={{ position: "sticky", top: 24 }}>
            <LiveCalc label="Reconciled tonnage" value={fmtNum(reconciled, 2)} unit="MTS" flashKey={reconciled}
              foot={cargoType === "Liquid"
                ? (liquid.blQty ? `Variance vs B/L: ${(reconciled - Number(liquid.blQty)).toFixed(2)} MT` : "Enter the surveyor's reconciled tonnage.")
                : "Displacement before − after − deductibles + constant."} />
            {cargoType === "Liquid" && (
              <div className="card card-pad mt-4" style={{ fontSize: 13 }}>
                <div className="kv" style={{ marginBottom: 10 }}><div className="k">Jetty</div><div className="v">{liquid.jettyType ? (liquid.jettyType === "International" ? "International" : (liquid.jettyCategory ? `${liquid.jettyCategory} · Local` : "Local — select category")) : "—"}</div></div>
                <div className="kv" style={{ marginBottom: 10 }}><div className="k">Applicable dues rate</div><div className="v tnum">{previewRate ? `${fmtUSD(previewRate)}/ton` : "—"}</div></div>
                <div className="kv"><div className="k">B/L quantity</div><div className="v tnum">{liquid.blQty ? fmtTons(Number(liquid.blQty)) : "—"}</div></div>
              </div>
            )}
            {cargoType === "Dry" && (
              <div className="card card-pad mt-4" style={{ fontSize: 13 }}>
                <div className="kv" style={{ marginBottom: 10 }}><div className="k">Applicable dues rate</div><div className="v tnum">{fmtUSD(store.settings.dryDuesRate)}/ton</div></div>
                <div className="kv" style={{ marginBottom: 10 }}><div className="k">Gross displacement Δ</div><div className="v tnum">{fmtNum((Number(dry.displBefore) || 0) - (Number(dry.displAfter) || 0))} MT</div></div>
                <div className="kv"><div className="k">Total deductibles</div><div className="v tnum">{fmtNum(Number(dry.deductibles) || 0)} MT</div></div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// searchable vessel-call combobox
function CallCombobox({ store, value, onChange }: { store: StoreApi; value: string; onChange: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const selected = store.calls.find((c) => c.id === value);
  const options = store.calls
    .filter((c) => c.status !== "completed" && c.status !== "cancelled")
    .filter((c) => !q || c.vesselName.toLowerCase().includes(q.toLowerCase()) || c.reference.toLowerCase().includes(q.toLowerCase()));

  return (
    <div style={{ position: "relative" }}>
      <div className="search-input" style={{ maxWidth: "none" }}>
        <Icon name="search" size={17} />
        <input type="text" placeholder="Search vessel name or reference…"
          value={open ? q : (selected ? `${selected.vesselName} · ${selected.reference}` : "")}
          onFocus={() => { setOpen(true); setQ(""); }}
          onChange={(e) => setQ(e.target.value)} />
      </div>
      {open && (
        <>
          <div style={{ position: "fixed", inset: 0, zIndex: 1 }} onClick={() => setOpen(false)} />
          <div style={{ position: "absolute", top: "110%", left: 0, right: 0, background: "#fff", border: "1px solid var(--hairline)", borderRadius: 8, boxShadow: "var(--shadow-pop)", zIndex: 2, maxHeight: 280, overflowY: "auto", padding: 6 }} className="scroll-host">
            {options.length ? options.map((c) => (
              <button key={c.id} className="sb-item" style={{ borderLeft: "none", justifyContent: "flex-start" }}
                onClick={() => { onChange(c.id); setOpen(false); }}>
                <Icon name="ship" size={17} />
                <span style={{ textAlign: "left" }}><span style={{ display: "block", fontWeight: 600, color: "var(--ink)" }}>{c.vesselName}</span><span className="mono-ref">{c.reference} · {c.type}</span></span>
                <StatusBadge status={c.status} />
              </button>
            )) : <div style={{ padding: 16, textAlign: "center", color: "var(--slate)", fontSize: 13 }}>No open vessel calls match.</div>}
          </div>
        </>
      )}
    </div>
  );
}
