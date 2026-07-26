// Invoices screen — harbour-dues invoices, payment-tracking KPIs, and a
// per-invoice detail drawer for recording payments. Ported from calabar/screens-ops.jsx.
import { useMemo, useState } from "react";

import { useStore } from "../app/store";
import { Icon } from "../components/Icon";
import {
  CargoTag, DataTable, Drawer, EmptyState, Field, PdfButton, StatCard, StatusBadge,
  type Column,
} from "../components/ui";
import { effectiveInvoiceStatus, fmtDate, fmtNGN, fmtNum, fmtUSD } from "../lib/format";
import type { EffectiveInvoiceStatus, Invoice, VesselCall } from "../types";

type Store = ReturnType<typeof useStore>;

// A store invoice enriched with the joined call + display/snapshot fields the
// table and drawer read. cargoType is derived from the linked inspection.
type InvoiceRow = Omit<Invoice, "cargoType"> & {
  call: VesselCall | undefined;
  effective: EffectiveInvoiceStatus;
  cargoType: string | null;
  vesselName: string;
  callRef: string;
};

export function Invoices() {
  const store = useStore();
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [detail, setDetail] = useState<InvoiceRow | null>(null);

  const allRows = useMemo<InvoiceRow[]>(() => {
    return store.invoices.map((iv) => {
      const call = store.calls.find((c) => c.id === iv.callId);
      const insp = store.inspections.find((i) => i.id === iv.inspectionId);
      // prefer the amounts snapshotted on the invoice at issue time; recompute
      // from current settings only for legacy invoices without a snapshot
      const f = iv.dues != null ? null : store.financialsForCall(call);
      return {
        ...iv, call, effective: effectiveInvoiceStatus(iv), cargoType: insp?.cargoType || null,
        vesselName: call?.vesselName || (iv as any).vesselName || "—",
        callRef: call?.reference || (iv as any).callRef || "—",
        dues: iv.dues != null ? iv.dues : (f?.dues || 0),
        rate: iv.dues != null ? (iv.rate || 0) : (f?.rate || 0),
        commissionUsd: iv.dues != null ? (iv.commissionUsd || 0) : (f?.commissionUsd || 0),
        commissionNgn: iv.dues != null ? (iv.commissionNgn || 0) : (f?.commissionNgn || 0),
      };
    }).sort((a, b) => +new Date(b.issued) - +new Date(a.issued));
  }, [store.invoices, store.calls, store.inspections, store.settings]);

  // Payment tracking summary across ALL invoices (unfiltered)
  const tracking = useMemo(() => {
    const t = { invoiced: 0, collected: 0, outstanding: 0, overdue: 0, overdueCount: 0 };
    allRows.forEach((r) => {
      if (r.effective === "void") return;
      t.invoiced += r.dues;
      if (r.effective === "paid") t.collected += r.dues;
      else { t.outstanding += r.dues; if (r.effective === "overdue") { t.overdue += r.dues; t.overdueCount += 1; } }
    });
    return t;
  }, [allRows]);

  const rows = useMemo(() => {
    return allRows.filter((r) => {
      if (statusFilter !== "all" && r.effective !== statusFilter) return false;
      if (query) { const q = query.toLowerCase(); return r.invoiceNo.toLowerCase().includes(q) || r.vesselName.toLowerCase().includes(q); }
      return true;
    });
  }, [allRows, query, statusFilter]);

  const columns: Column<InvoiceRow>[] = [
    { key: "invoiceNo", label: "Invoice No.", sortable: true, render: (r) => <span className="cell-primary mono-ref" style={{ color: "var(--ink)", fontWeight: 600 }}>{r.invoiceNo}</span> },
    { key: "vesselName", label: "Vessel", sortable: true, render: (r) => r.vesselName },
    { key: "callRef", label: "Rotation Number", render: (r) => <span className="mono-ref">{r.callRef}</span> },
    { key: "cargoType", label: "Cargo", render: (r) => r.cargoType ? <CargoTag type={r.cargoType} /> : <span className="muted">—</span> },
    { key: "dues", label: "Amount (USD)", num: true, sortable: true, render: (r) => <span className="money tnum"><span className="usd">{fmtUSD(r.dues)}</span></span> },
    { key: "commissionUsd", label: "Commission", num: true, render: (r) => <span className="money tnum"><span className="usd">{fmtUSD(r.commissionUsd)}</span><span className="ngn">{fmtNGN(r.commissionNgn)}</span></span> },
    { key: "status", label: "Status", sortable: true, sortVal: (r) => r.effective, render: (r) => <StatusBadge status={r.effective} /> },
    { key: "due", label: "Due", sortable: true, sortVal: (r) => r.due, render: (r) => <span className="tnum muted">{fmtDate(r.due)}</span> },
    { key: "actions", label: "", num: true, render: (r) => (
      <div className="cell-actions">
        <PdfButton kind="invoice" id={r.id} />
        <PdfButton kind="report" id={r.inspectionId} />
      </div>) },
  ];

  const STATUSES: [string, string][] = [["all", "All"], ["paid", "Paid"], ["unpaid", "Unpaid"], ["overdue", "Overdue"], ["void", "Void"]];

  return (
    <div className="content-inner">
      <div className="page-head">
        <div>
          <h1 className="hide-sr">Invoices</h1>
          <p className="desc">Harbour-dues invoices, payment tracking and receivables.</p>
        </div>
      </div>

      <div className="kpi-strip" style={{ marginBottom: 20 }}>
        <StatCard label="Total Invoiced" value={fmtUSD(tracking.invoiced, 0).replace("$", "")} cur="$" sub={`${allRows.length} invoice${allRows.length === 1 ? "" : "s"}`} />
        <StatCard label="Collected" value={fmtUSD(tracking.collected, 0).replace("$", "")} cur="$" sub="payments recorded" />
        <StatCard label="Outstanding" value={fmtUSD(tracking.outstanding, 0).replace("$", "")} cur="$" sub="awaiting payment" />
        <StatCard label="Overdue" value={fmtUSD(tracking.overdue, 0).replace("$", "")} cur="$" sub={`${tracking.overdueCount} past due date`} />
      </div>

      <div className="filter-bar">
        <div className="search-input">
          <Icon name="search" size={17} />
          <input type="text" placeholder="Search invoice no. or vessel…" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search invoices" />
        </div>
        <div className="seg" role="tablist" aria-label="Filter by status">
          {STATUSES.map(([k, l]) => <button key={k} className={statusFilter === k ? "on" : ""} onClick={() => setStatusFilter(k)}>{l}</button>)}
        </div>
      </div>

      <div className="card">
        <DataTable columns={columns} rows={rows} getKey={(r) => r.id} onRowClick={(r) => setDetail(r)} mobileCards={false}
          emptyState={<EmptyState icon="invoice" title="No invoices found" body="Invoices appear here once an inspection is completed." />} />
        {/* mobile cards */}
        <div className="m-cards" style={{ padding: 16 }}>
          {rows.map((r) => (
            <div className="m-card" key={r.id} onClick={() => setDetail(r)}>
              <div className="mc-top">
                <div><div className="mc-title">{r.vesselName}</div><div className="mc-sub mono-ref">{r.invoiceNo}{r.cargoType ? " · " + r.cargoType : ""}</div></div>
                <StatusBadge status={r.effective} />
              </div>
              <div className="mc-amt tnum">{fmtUSD(r.dues)}<span className="ngn">Commission {fmtUSD(r.commissionUsd)} · {fmtNGN(r.commissionNgn)}</span></div>
              <div className="mc-actions" onClick={(e) => e.stopPropagation()}>
                <PdfButton kind="invoice" id={r.id} />
                <PdfButton kind="report" id={r.inspectionId} />
              </div>
            </div>
          ))}
        </div>
      </div>

      {detail && <InvoiceDetail store={store} row={detail} onClose={() => setDetail(null)} />}
    </div>
  );
}

function InvoiceDetail({ store, row, onClose }: { store: Store; row: InvoiceRow; onClose: () => void }) {
  const call = row.call;
  const effective = row.effective || effectiveInvoiceStatus(row as unknown as Invoice);
  const canPay = store.can("recordPayment");
  const [pay, setPay] = useState({ paidOn: new Date().toISOString().slice(0, 10), method: "Bank transfer", reference: "" });
  const [reversalReason, setReversalReason] = useState("");
  const [reversing, setReversing] = useState(false);
  const [busy, setBusy] = useState(false);

  const recordPayment = async () => {
    setBusy(true);
    try {
      await store.recordPayment(row.id, {
        ...pay,
        reference: pay.reference.trim(),
      });
      store.toast(`Payment recorded for ${row.invoiceNo}`, "success");
      onClose();
    } catch (error) {
      store.toast(error instanceof Error ? error.message : "Could not record the payment", "error");
    } finally {
      setBusy(false);
    }
  };

  const reversePayment = async () => {
    if (!row.payment || reversalReason.trim().length < 3) return;
    setBusy(true);
    try {
      await store.reversePayment(row.payment.id, reversalReason.trim());
      store.toast(`Payment reversed for ${row.invoiceNo}`, "info");
      onClose();
    } catch (error) {
      store.toast(error instanceof Error ? error.message : "Could not reverse the payment", "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Drawer title={row.invoiceNo} sub={`${row.vesselName} · ${row.callRef}`} onClose={onClose}
      footer={<>
        <PdfButton kind="report" id={row.inspectionId} />
        <PdfButton kind="invoice" id={row.id} />
      </>}>
      <div className="flex between items-center" style={{ marginBottom: 20 }}>
        <StatusBadge status={effective} />
        <span className="muted" style={{ fontSize: 13 }}>Issued {fmtDate(row.issued)} · Due {fmtDate(row.due)}</span>
      </div>
      <div className="card-title" style={{ marginBottom: 14 }}>Line-item breakdown</div>
      <div className="fin-row"><div className="fl">Cargo / product type</div><div className="fv">{row.cargoType ? <CargoTag type={row.cargoType} /> : "—"}</div></div>
      <div className="fin-row"><div className="fl">Net tonnage<span className="basis">dues basis</span></div><div className="fv tnum">{call ? fmtNum(call.nrt) : "—"} NT</div></div>
      <div className="fin-row"><div className="fl">Dues rate<span className="basis">{row.cargoType === "Liquid" ? "jetty tariff" : "dry cargo"}</span></div><div className="fv tnum">{fmtUSD(row.rate)} / ton</div></div>
      <div className="fin-row"><div className="fl">NPA harbour dues</div><div className="fv tnum">{fmtUSD(row.dues)}</div></div>
      <div className="fin-row"><div className="fl">Agency commission<span className="basis">{store.settings.commissionRate}% · ₦{fmtNum(store.settings.exchangeRate)}/USD</span></div><div className="fv tnum">{fmtUSD(row.commissionUsd)} · {fmtNGN(row.commissionNgn)}</div></div>
      <div className="fin-total"><div className="fl">Invoice total</div><div className="fv tnum">{fmtUSD(row.dues)}<span className="ngn">{fmtNGN(row.dues * store.settings.exchangeRate)}</span></div></div>

      {/* ---- Payment tracking ---- */}
      <div className="card-title" style={{ margin: "26px 0 14px" }}>Payment</div>
      {effective === "paid" && row.payment ? (
        <>
          <div className="fin-row"><div className="fl">Paid on</div><div className="fv tnum">{fmtDate(row.payment.paidOn)}</div></div>
          <div className="fin-row"><div className="fl">Amount</div><div className="fv tnum">{fmtUSD(row.payment.amount)}</div></div>
          <div className="fin-row"><div className="fl">Method</div><div className="fv">{row.payment.method}</div></div>
          <div className="fin-row"><div className="fl">Reference</div><div className="fv mono-ref" style={{ color: "var(--ink)" }}>{row.payment.reference || "—"}</div></div>
          <div className="fin-row"><div className="fl">Recorded by</div><div className="fv">{row.payment.recordedBy || "—"}</div></div>
          {canPay && (
            <>
              {reversing ? (
                <div style={{ marginTop: 16 }}>
                  <Field label="Reversal reason" required hint="The original payment remains in the immutable audit trail.">
                    <textarea
                      value={reversalReason}
                      onChange={(event) => setReversalReason(event.target.value)}
                      placeholder="Explain why this payment is being reversed"
                    />
                  </Field>
                  <div className="flex gap-3">
                    <button
                      className="btn btn-danger btn-sm"
                      type="button"
                      disabled={busy || reversalReason.trim().length < 3}
                      onClick={reversePayment}
                    >
                      {busy ? "Reversing…" : "Confirm reversal"}
                    </button>
                    <button className="btn btn-secondary btn-sm" type="button" disabled={busy} onClick={() => setReversing(false)}>
                      Keep payment
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  className="btn btn-ghost btn-sm"
                  type="button"
                  style={{ color: "var(--danger)", marginTop: 12 }}
                  disabled={busy}
                  onClick={() => setReversing(true)}
                >
                  Reverse payment
                </button>
              )}
            </>
          )}
        </>
      ) : canPay ? (
        <>
          {effective === "overdue" && (
            <p className="muted" style={{ fontSize: 13, margin: "0 0 12px", color: "var(--danger)" }}>
              This invoice passed its due date ({fmtDate(row.due)}) without a recorded payment.
            </p>
          )}
          <div className="field-row">
            <Field label="Paid on">
              <input type="date" value={pay.paidOn} onChange={(e) => setPay({ ...pay, paidOn: e.target.value })} />
            </Field>
            <Field label="Method">
              <select value={pay.method} onChange={(e) => setPay({ ...pay, method: e.target.value })}>
                <option>Bank transfer</option><option>Cheque</option><option>Cash</option><option>Remita</option>
              </select>
            </Field>
          </div>
          <Field label="Payment reference" hint="Teller / transfer reference for the audit trail.">
            <input type="text" value={pay.reference} placeholder="e.g. NPA-TRF-88214" onChange={(e) => setPay({ ...pay, reference: e.target.value })} />
          </Field>
          <button className="btn btn-primary" disabled={busy || !pay.paidOn || !pay.reference.trim()} onClick={recordPayment}>
            {busy ? <><Icon name="spinner" size={16} className="spin" strokeWidth={2} /> Recording…</> : <><Icon name="check" size={16} strokeWidth={2.2} /> Record payment</>}
          </button>
        </>
      ) : (
        <p className="muted" style={{ fontSize: 13, margin: 0 }}>
          No payment recorded yet. Recording payments requires the Admin or Finance role.
        </p>
      )}
    </Drawer>
  );
}
