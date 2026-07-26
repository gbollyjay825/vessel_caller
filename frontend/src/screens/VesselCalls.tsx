// Vessel Calls — list (with a Register slide-over) + call detail.
// Ported from calabar/screens-ops.jsx (VesselCalls, RegisterCall, VesselCallDetail)
// to Vite + React + TS ES modules against the live store/api.
import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "../lib/navigation";

import { useStore } from "../app/store";
import { Icon } from "../components/Icon";
import {
  CargoTag, ConfirmModal, DataTable, Drawer, EmptyState, Field, PdfButton, StatusBadge,
  type Column,
} from "../components/ui";
import {
  fmtDate, fmtDateTime, fmtNGN, fmtNum, fmtTons, fmtUSD,
} from "../lib/format";
import type { Inspection, VesselCall } from "../types";

type StoreApi = ReturnType<typeof useStore>;

// Legacy lived in data.jsx (VESSEL_TYPES); inlined here for the register form.
const VESSEL_TYPES = ["Tanker", "Bulk Carrier", "Container", "General Cargo", "Other"];

// Inline row actions: completed -> Invoice + Report; else -> Open
function RowActions({ call }: { call: VesselCall }) {
  const store = useStore();
  const navigate = useNavigate();
  if (call.status === "completed") {
    const invoice = store.invoiceForCall(call.id);
    const inspection = store.inspectionsForCall(call.id).find((item) => item.status === "completed");
    return (
      <div className="cell-actions">
        <PdfButton kind="invoice" id={invoice?.id} />
        <PdfButton kind="report" id={inspection?.id} />
      </div>
    );
  }
  return (
    <div className="cell-actions">
      <button className="link-btn" onClick={(e) => { e.stopPropagation(); navigate("/app/vessel-calls/" + call.id); }}>
        Open <Icon name="chevronRight" size={14} strokeWidth={2.2} style={{ verticalAlign: "-2px" }} />
      </button>
    </div>
  );
}

// =========================================================
// Vessel Calls — list
// =========================================================
export function VesselCalls() {
  const store = useStore();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [registerOpen, setRegisterOpen] = useState(searchParams.get("register") != null);

  // keep in sync if we arrive with ?register (e.g. from the dashboard CTA)
  useEffect(() => {
    if (searchParams.get("register") != null) setRegisterOpen(true);
  }, [searchParams]);

  const closeRegister = () => {
    setRegisterOpen(false);
    if (searchParams.get("register") != null) {
      const next = new URLSearchParams(searchParams);
      next.delete("register");
      setSearchParams(next, { replace: true });
    }
  };

  const filtered = useMemo(() => {
    return store.calls.filter((c) => {
      if (statusFilter !== "all" && c.status !== statusFilter) return false;
      if (query) {
        const q = query.toLowerCase();
        return c.vesselName.toLowerCase().includes(q) || c.reference.toLowerCase().includes(q);
      }
      return true;
    }).sort((a, b) => +new Date(b.registered) - +new Date(a.registered));
  }, [store.calls, query, statusFilter]);

  const columns: Column<VesselCall>[] = [
    {
      key: "vesselName", label: "Vessel Name", sortable: true,
      render: (r) => <div className="cell-primary">{r.vesselName}</div>,
    },
    { key: "reference", label: "Rotation Number", render: (r) => <span className="mono-ref">{r.reference}</span> },
    { key: "type", label: "Type", sortable: true, render: (r) => <span className="muted">{r.type}</span> },
    { key: "status", label: "Status", sortable: true, render: (r) => <StatusBadge status={r.status} /> },
    {
      key: "eta", label: "Arrival / Berth", sortable: true, sortVal: (r) => r.eta,
      render: (r) => (
        <div>
          <div className="tnum">{fmtDate(r.eta)}</div>
          <div className="cell-sub tnum">
            {r.berthDate ? "Berthed " + fmtDate(r.berthDate) : "ETA " + new Date(r.eta).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}
          </div>
        </div>
      ),
    },
    {
      key: "dues", label: "Dues", num: true, sortable: true, sortVal: (r) => store.financialsForCall(r)?.dues || 0,
      render: (r) => {
        const f = store.financialsForCall(r);
        return f ? <span className="money tnum"><span className="usd">{fmtUSD(f.dues)}</span></span> : <span className="muted">—</span>;
      },
    },
    { key: "actions", label: "", num: true, render: (r) => <RowActions call={r} /> },
  ];

  const STATUSES: [string, string][] = [
    ["all", "All"],
    ["pending", "Pending"],
    ["in-progress", "In progress"],
    ["completed", "Completed"],
    ["cancelled", "Cancelled"],
  ];

  return (
    <div className="content-inner">
      <div className="page-head">
        <div>
          <h1 className="hide-sr">Vessel Calls</h1>
          <p className="desc">Every incoming vessel call across {store.portLabel}.</p>
        </div>
        <button className="btn btn-primary" disabled={!store.can("registerCall")}
          title={store.can("registerCall") ? undefined : "Requires the Admin or Operations role"}
          onClick={() => setRegisterOpen(true)}>
          <Icon name="plus" size={17} strokeWidth={2.2} /> Register Vessel Call
        </button>
      </div>

      <div className="filter-bar">
        <div className="search-input">
          <Icon name="search" size={17} />
          <input type="text" placeholder="Search vessel name or rotation no.…" value={query}
            onChange={(e) => setQuery(e.target.value)} aria-label="Search vessel calls" />
        </div>
        <div className="seg" role="tablist" aria-label="Filter by status">
          {STATUSES.map(([k, l]) => (
            <button key={k} className={statusFilter === k ? "on" : ""} onClick={() => setStatusFilter(k)}>{l}</button>
          ))}
        </div>
      </div>

      <div className="card">
        <DataTable columns={columns} rows={filtered} getKey={(r) => r.id}
          onRowClick={(r) => navigate("/app/vessel-calls/" + r.id)}
          emptyState={<EmptyState icon="search" title="No matching vessel calls" body="Try a different search term or status filter." />} />
      </div>

      {registerOpen && <RegisterCall store={store} onClose={closeRegister} />}
    </div>
  );
}

// =========================================================
// Register Vessel Call — slide-over
// =========================================================
interface RegisterForm {
  vesselName: string; reference: string; type: string; nrt: string;
  eta: string; sailingEta: string; berth: string; notes: string;
}

function RegisterCall({ store, onClose }: { store: StoreApi; onClose: () => void }) {
  const nextRef = useMemo(() => {
    const nums = store.calls.map((c) => parseInt(c.reference.split("-")[2], 10)).filter((n) => !isNaN(n));
    const next = (Math.max(0, ...nums) + 1).toString().padStart(4, "0");
    return `ROT-2026-${next}`;
  }, []);

  const [form, setForm] = useState<RegisterForm>({
    vesselName: "", reference: nextRef, type: "Tanker", nrt: "",
    eta: "", sailingEta: "", berth: store.settings.terminals[0] || "", notes: "",
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [refStatus, setRefStatus] = useState<"idle" | "checking" | "ok" | "taken">("idle");
  const [submitting, setSubmitting] = useState(false);
  const [dirty, setDirty] = useState(false);

  const set = (k: keyof RegisterForm, v: string) => { setForm((f) => ({ ...f, [k]: v })); setDirty(true); };

  // async uniqueness check on reference
  useEffect(() => {
    if (!form.reference) { setRefStatus("idle"); return; }
    setRefStatus("checking");
    const id = setTimeout(() => {
      const taken = store.calls.some((c) => c.reference.toLowerCase() === form.reference.toLowerCase());
      setRefStatus(taken ? "taken" : "ok");
    }, 650);
    return () => clearTimeout(id);
  }, [form.reference]);

  const validate = () => {
    const e: Record<string, string> = {};
    if (!form.vesselName.trim()) e.vesselName = "Vessel name is required.";
    if (!form.reference.trim()) e.reference = "Rotation number is required.";
    else if (refStatus === "taken") e.reference = "This rotation number is already in use.";
    if (!form.nrt || Number(form.nrt) <= 0) e.nrt = "Net tonnage is required.";
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const submit = async () => {
    if (!validate()) return;
    setSubmitting(true);
    try {
      const payload: Record<string, unknown> = {
        vesselName: form.vesselName.trim(), reference: form.reference.trim(), type: form.type,
        nrt: Number(form.nrt), eta: form.eta || new Date().toISOString().slice(0, 16),
        sailingEta: form.sailingEta || null, berth: form.berth, status: "pending", notes: form.notes.trim(),
      };
      await store.addCall(payload as Partial<VesselCall>);
      store.toast(`Vessel call ${form.reference.trim()} registered`, "success");
      onClose();
    } catch (e: any) {
      store.toast(e.message || "Could not register vessel call", "error");
    } finally {
      setSubmitting(false);
    }
  };

  const guard = () => dirty && !submitting && !window.confirm("Discard this vessel call? Your entered details will be lost.");

  return (
    <Drawer title="Register Vessel Call" sub="Log an incoming vessel and its particulars." onClose={onClose} guard={guard}
      footer={<>
        <button className="btn btn-secondary" onClick={onClose} disabled={submitting}>Cancel</button>
        <button className="btn btn-primary" onClick={submit} disabled={submitting || refStatus === "checking"}>
          {submitting ? <><Icon name="spinner" size={16} className="spin" strokeWidth={2} /> Registering…</> : "Register Call"}
        </button>
      </>}>
      <Field label="Vessel name" required error={errors.vesselName}>
        <input type="text" className={errors.vesselName ? "invalid" : ""} value={form.vesselName}
          placeholder="e.g. MT Sea Eagle" onChange={(e) => set("vesselName", e.target.value)}
          onBlur={() => !form.vesselName.trim() && setErrors((x) => ({ ...x, vesselName: "Vessel name is required." }))} />
      </Field>

      <Field label="Rotation number" required hint="Auto-suggested. Editable; must be unique."
        error={errors.reference || (refStatus === "taken" ? "This rotation number is already in use." : null)}
        ok={refStatus === "ok" && !errors.reference ? "Rotation number is available." : null}
        checking={refStatus === "checking" ? "Checking availability…" : null}>
        <input type="text" className={(errors.reference || refStatus === "taken") ? "invalid" : ""} value={form.reference}
          onChange={(e) => set("reference", e.target.value.toUpperCase())} />
      </Field>

      <div className="field-row">
        <Field label="Vessel type">
          <select value={form.type} onChange={(e) => set("type", e.target.value)}>
            {VESSEL_TYPES.map((t) => <option key={t}>{t}</option>)}
          </select>
        </Field>
        <Field label="Net tonnage" required hint="Drives the harbour-dues calculation." error={errors.nrt}>
          <input type="number" className={errors.nrt ? "invalid" : ""} value={form.nrt} placeholder="e.g. 57137"
            onChange={(e) => set("nrt", e.target.value)} min="0" />
        </Field>
      </div>

      <div className="field-row">
        <Field label="Arrival ETA">
          <input type="datetime-local" value={form.eta} onChange={(e) => set("eta", e.target.value)} />
        </Field>
        <Field label="Sailing ETA">
          <input type="datetime-local" value={form.sailingEta} onChange={(e) => set("sailingEta", e.target.value)} />
        </Field>
      </div>

      <Field label="Berth terminal">
        <select value={form.berth} onChange={(e) => set("berth", e.target.value)}>
          {store.settings.terminals.map((t) => <option key={t}>{t}</option>)}
        </select>
      </Field>

      <Field label="Notes" hint="Optional. Pilotage, cargo notes, special handling.">
        <textarea value={form.notes} placeholder="Anything the berth team should know…" onChange={(e) => set("notes", e.target.value)} />
      </Field>
    </Drawer>
  );
}

// =========================================================
// Vessel Call detail
// =========================================================
export function VesselCallDetail() {
  const store = useStore();
  const navigate = useNavigate();
  const { id } = useParams();
  const [confirmDel, setConfirmDel] = useState(false);
  const [cancelReason, setCancelReason] = useState("");
  const [editOpen, setEditOpen] = useState(false);
  const [statusBusy, setStatusBusy] = useState(false);

  const call = store.calls.find((c) => c.id === id);
  if (!call) return <div className="content-inner"><p className="muted">Vessel call not found.</p></div>;

  const f = store.financialsForCall(call);
  const inspections = store.inspectionsForCall(call.id);
  const completedInsp = inspections.find((i) => i.status === "completed");
  const invoice = store.invoiceForCall(call.id);

  const inspColumns: Column<Inspection>[] = [
    { key: "date", label: "Date", render: (r) => <span className="tnum">{fmtDate(r.date)}</span> },
    { key: "reference", label: "Reference", render: (r) => <span className="mono-ref">{r.reference}</span> },
    { key: "cargoType", label: "Cargo", render: (r) => <CargoTag type={r.cargoType} /> },
    {
      key: "reconciledTonnage", label: "Reconciled tonnage", num: true,
      render: (r) => <span className="tnum">{r.status === "draft" ? "—" : fmtTons(r.reconciledTonnage)}</span>,
    },
    { key: "status", label: "Status", render: (r) => <StatusBadge status={r.status} /> },
  ];

  return (
    <div className="content-inner">
      <button className="link-btn" style={{ marginBottom: 16 }} onClick={() => navigate("/app/vessel-calls")}>
        <Icon name="chevronLeft" size={15} strokeWidth={2.2} style={{ verticalAlign: "-3px" }} /> Vessel Calls
      </button>

      <div className="page-head" style={{ marginBottom: 24 }}>
        <div>
          <div className="flex items-center gap-3 wrap">
            <h1>{call.vesselName}</h1>
            <StatusBadge status={call.status} />
          </div>
          <p className="desc" style={{ marginTop: 6 }}>
            <span className="mono-ref">{call.reference}</span> &nbsp;·&nbsp; {call.type}
          </p>
        </div>
        <div className="flex gap-2">
          {store.can("cancelCall") && call.status !== "cancelled" && call.status !== "completed" && (
            <button className="btn btn-secondary btn-sm" type="button" onClick={() => setEditOpen(true)}>
              <Icon name="edit" size={16} /> Edit call
            </button>
          )}
          {store.can("cancelCall") && call.status === "pending" && (
            <button
              className="btn btn-secondary btn-sm"
              type="button"
              disabled={statusBusy}
              onClick={async () => {
                setStatusBusy(true);
                try {
                  await store.updateCallStatus(call.id, "in-progress", {
                    berth: call.berth,
                    berthDate: new Date().toISOString().slice(0, 10),
                  });
                  store.toast(`${call.reference} marked in progress`, "success");
                } catch (error) {
                  store.toast(error instanceof Error ? error.message : "Could not update vessel status", "error");
                } finally {
                  setStatusBusy(false);
                }
              }}
            >
              <Icon name="anchor" size={16} /> Mark berthed
            </button>
          )}
          <button className="btn btn-secondary btn-sm" disabled={!store.can("addInspection") || call.status === "cancelled" || call.status === "completed"}
            title={store.can("addInspection") ? undefined : "Requires the Admin or Operations role"}
            onClick={() => navigate("/app/inspections/new?callId=" + call.id)}>
            <Icon name="plus" size={16} strokeWidth={2.2} /> Add Inspection
          </button>
          {store.can("cancelCall") && call.status !== "cancelled" && call.status !== "completed" && (
            <button className="btn btn-ghost btn-sm" style={{ color: "var(--danger)" }} onClick={() => setConfirmDel(true)}>
              <Icon name="x" size={16} /> Cancel call
            </button>
          )}
        </div>
      </div>
      {call.status === "cancelled" && (
        <div className="auth-error section-gap" role="status">
          Cancelled{call.cancelledAt ? ` on ${fmtDateTime(call.cancelledAt)}` : ""}
          {call.cancellationReason ? ` — ${call.cancellationReason}` : ""}
        </div>
      )}

      <div className="card card-pad section-gap">
        <div className="card-title" style={{ marginBottom: 20 }}>Vessel particulars</div>
        <div className="kv-grid">
          <div className="kv"><div className="k">Net tonnage</div><div className="v tnum">{fmtNum(call.nrt)} NT</div></div>
          <div className="kv"><div className="k">Vessel type</div><div className="v">{call.type}</div></div>
          <div className="kv"><div className="k">Berth terminal</div><div className="v">{call.berth || "—"}</div></div>
          <div className="kv"><div className="k">Arrival ETA</div><div className="v tnum">{fmtDateTime(call.eta)}</div></div>
          <div className="kv"><div className="k">Sailing ETA</div><div className="v tnum">{call.sailingEta ? fmtDateTime(call.sailingEta) : "—"}</div></div>
          <div className="kv"><div className="k">Berth date</div><div className="v tnum">{call.berthDate ? fmtDate(call.berthDate) : "Not yet berthed"}</div></div>
          <div className="kv"><div className="k">Registered</div><div className="v tnum">{fmtDateTime(call.registered)}</div></div>
        </div>
        {call.notes && (
          <div style={{ marginTop: 20, paddingTop: 20, borderTop: "1px solid var(--hairline)" }}>
            <div className="k" style={{ fontSize: 12, fontWeight: 600, letterSpacing: "0.04em", textTransform: "uppercase", color: "var(--slate)" }}>Notes</div>
            <p style={{ marginTop: 6, color: "var(--ink)" }}>{call.notes}</p>
          </div>
        )}
      </div>

      <div className="card section-gap">
        <div className="card-head">
          <div className="card-title">Inspections on this call</div>
          <button className="btn btn-secondary btn-sm" disabled={!store.can("addInspection") || call.status === "cancelled" || call.status === "completed"}
            title={store.can("addInspection") ? undefined : "Requires the Admin or Operations role"}
            onClick={() => navigate("/app/inspections/new?callId=" + call.id)}>
            <Icon name="plus" size={16} strokeWidth={2.2} /> Add Inspection
          </button>
        </div>
        {inspections.length ? (
          <DataTable columns={inspColumns} rows={inspections} getKey={(r) => r.id}
            onRowClick={(r) => navigate("/app/inspections?focus=" + r.id)} />
        ) : (
          <div style={{ padding: "32px 24px", textAlign: "center", color: "var(--slate)" }}>
            No inspections logged on this call yet.
          </div>
        )}
      </div>

      {completedInsp && f && (
        <div className="card card-pad section-gap">
          <div className="card-title" style={{ marginBottom: 18 }}>Financials</div>
          <div style={{ maxWidth: 480 }}>
            <div className="fin-row">
              <div className="fl">NPA harbour dues<span className="basis">{fmtNum(call.nrt)} NT × {fmtUSD(f.rate)}/ton · {completedInsp.cargoType === "Liquid" ? (completedInsp.jetty ? (completedInsp.jetty.type === "International" ? "International jetty" : `${completedInsp.jetty.category} jetty`) : "liquid") : "dry cargo"}</span></div>
              <div className="fv">{fmtUSD(f.dues)}</div>
            </div>
            <div className="fin-row">
              <div className="fl">Commission rate</div>
              <div className="fv">{store.settings.commissionRate}%</div>
            </div>
            <div className="fin-row">
              <div className="fl">Agency commission<span className="basis">at ₦{fmtNum(store.settings.exchangeRate)}/USD</span></div>
              <div className="fv">{fmtUSD(f.commissionUsd)} <span style={{ color: "var(--slate)", fontWeight: 500 }}>· {fmtNGN(f.commissionNgn)}</span></div>
            </div>
            <div className="fin-total">
              <div className="fl">Invoice total</div>
              <div className="fv tnum">{fmtUSD(f.dues)}<span className="ngn">{fmtNGN(f.dues * store.settings.exchangeRate)}</span></div>
            </div>
          </div>
          <div className="flex gap-3 mt-6">
            <PdfButton kind="invoice" id={invoice?.id} />
            <PdfButton kind="report" id={completedInsp.id} />
          </div>
        </div>
      )}

      {confirmDel && (
        <ConfirmModal title="Cancel this vessel call?"
          body={(
            <>
              <p>
                {call.vesselName} ({call.reference}) will be marked cancelled. Its history, inspections, invoices, and audit records remain available.
              </p>
              <Field label="Cancellation reason" required>
                <textarea
                  value={cancelReason}
                  onChange={(event) => setCancelReason(event.target.value)}
                  placeholder="Operational reason for cancelling this call"
                />
              </Field>
            </>
          )}
          confirmLabel="Cancel call" danger
          confirmDisabled={cancelReason.trim().length < 3}
          onConfirm={async () => {
            try {
              await store.cancelCall(call.id, cancelReason.trim());
              store.toast(`${call.reference} cancelled`, "info");
              navigate("/app/vessel-calls");
            } catch (error) {
              store.toast(error instanceof Error ? error.message : "Could not cancel the call", "error");
            }
          }}
          onClose={() => setConfirmDel(false)} />
      )}
      {editOpen && <EditVesselCall store={store} call={call} onClose={() => setEditOpen(false)} />}
    </div>
  );
}

function EditVesselCall({
  store,
  call,
  onClose,
}: {
  store: StoreApi;
  call: VesselCall;
  onClose: () => void;
}) {
  const [form, setForm] = useState({
    vesselName: call.vesselName,
    type: call.type,
    flag: call.flag,
    nrt: String(call.nrt),
    eta: call.eta ? call.eta.slice(0, 16) : "",
    sailingEta: call.sailingEta ? call.sailingEta.slice(0, 16) : "",
    berth: call.berth,
    notes: call.notes,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (key: keyof typeof form, value: string) => {
    setForm((current) => ({ ...current, [key]: value }));
  };
  const save = async () => {
    if (!form.vesselName.trim() || Number(form.nrt) <= 0) return;
    setBusy(true);
    setError(null);
    try {
      await store.updateCall(call.id, {
        vesselName: form.vesselName.trim(),
        type: form.type,
        flag: form.flag.trim(),
        nrt: Number(form.nrt),
        eta: form.eta,
        sailingEta: form.sailingEta,
        berth: form.berth,
        notes: form.notes.trim(),
      });
      store.toast(`${call.reference} updated`, "success");
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not update the vessel call.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Drawer
      title="Edit vessel call"
      sub={call.reference}
      onClose={onClose}
      footer={(
        <>
          <button className="btn btn-secondary" type="button" disabled={busy} onClick={onClose}>Cancel</button>
          <button
            className="btn btn-primary"
            type="button"
            disabled={busy || !form.vesselName.trim() || Number(form.nrt) <= 0}
            onClick={save}
          >
            {busy ? "Saving…" : "Save changes"}
          </button>
        </>
      )}
    >
      {error && <div className="auth-error" role="alert">{error}</div>}
      <Field label="Vessel name" required>
        <input value={form.vesselName} onChange={(event) => set("vesselName", event.target.value)} />
      </Field>
      <div className="field-row">
        <Field label="Vessel type">
          <select value={form.type} onChange={(event) => set("type", event.target.value)}>
            {VESSEL_TYPES.map((type) => <option key={type}>{type}</option>)}
          </select>
        </Field>
        <Field label="Flag">
          <input value={form.flag} onChange={(event) => set("flag", event.target.value)} />
        </Field>
      </div>
      <Field label="Net tonnage" required>
        <input type="number" min="0.001" step="0.001" value={form.nrt} onChange={(event) => set("nrt", event.target.value)} />
      </Field>
      <div className="field-row">
        <Field label="Arrival ETA">
          <input type="datetime-local" value={form.eta} onChange={(event) => set("eta", event.target.value)} />
        </Field>
        <Field label="Sailing ETA">
          <input type="datetime-local" value={form.sailingEta} onChange={(event) => set("sailingEta", event.target.value)} />
        </Field>
      </div>
      <Field label="Berth terminal">
        <select value={form.berth} onChange={(event) => set("berth", event.target.value)}>
          {store.settings.terminals.map((terminal) => <option key={terminal}>{terminal}</option>)}
        </select>
      </Field>
      <Field label="Notes">
        <textarea value={form.notes} onChange={(event) => set("notes", event.target.value)} />
      </Field>
    </Drawer>
  );
}
