// Invoices screen — harbour dues and disparity invoices, payment tracking, and a
// per-invoice detail drawer for recording payments. Ported from calabar/screens-ops.jsx.
import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "../lib/navigation";

import { useStore } from "../app/store";
import { Icon } from "../components/Icon";
import {
  CargoTag, DataTable, Drawer, EmptyState, Field, PdfButton, StatCard, StatusBadge,
  type Column,
} from "../components/ui";
import { effectiveInvoiceStatus, fmtDate, fmtNGN, fmtNum, fmtUSD } from "../lib/format";
import { api } from "../lib/api";
import type { EffectiveInvoiceStatus, Invoice, InvoiceAttachment, VesselCall } from "../types";

type Store = ReturnType<typeof useStore>;

const unitRateFormatter = new Intl.NumberFormat("en-US", {
  style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 4,
});

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
  const [searchParams] = useSearchParams();
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [detailId, setDetailId] = useState<string | null>(searchParams.get("focus"));

  const allRows = useMemo<InvoiceRow[]>(() => {
    return store.invoices.map((iv) => {
      const call = store.calls.find((c) => c.id === iv.callId);
      const insp = store.inspections.find((i) => i.id === iv.inspectionId);
      // prefer the amounts snapshotted on the invoice at issue time; recompute
      // from current settings only for legacy invoices without a snapshot
      const f = iv.dues != null ? null : store.financialsForCall(call);
      return {
        ...iv, call, effective: effectiveInvoiceStatus(iv), cargoType: iv.purpose === "disparity" ? null : (iv.cargoType || insp?.cargoType || null),
        vesselName: call?.vesselName || (iv as any).vesselName || "—",
        callRef: call?.reference || (iv as any).callRef || "—",
        dues: iv.dues != null ? iv.dues : (f?.dues || 0),
        rate: iv.dues != null ? (iv.rate || 0) : (f?.rate || 0),
        commissionUsd: iv.dues != null ? (iv.commissionUsd || 0) : (f?.commissionUsd || 0),
        commissionNgn: iv.dues != null ? (iv.commissionNgn || 0) : (f?.commissionNgn || 0),
      };
    }).sort((a, b) => +new Date(b.issued) - +new Date(a.issued));
  }, [store.invoices, store.calls, store.inspections, store.settings]);

  const detail = allRows.find((row) => row.id === detailId);

  // Payment tracking summary across ALL invoices (unfiltered)
  const tracking = useMemo(() => {
    const t = { invoiced: 0, collected: 0, outstanding: 0, overdue: 0, overdueCount: 0 };
    allRows.forEach((r) => {
      if (r.effective === "void") return;
      t.invoiced += r.dues;
      const paid = r.paidAmount ?? (r.effective === "paid" ? r.dues : 0);
      const outstanding = r.outstandingAmount ?? Math.max(0, r.dues - paid);
      t.collected += paid;
      t.outstanding += outstanding;
      if (r.effective === "overdue") { t.overdue += outstanding; t.overdueCount += 1; }
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
    { key: "purpose", label: "Purpose", render: (r) => r.purpose === "disparity" ? "Measurement disparity" : "Harbour dues" },
    { key: "cargoType", label: "Cargo", render: (r) => r.cargoType ? <CargoTag type={r.cargoType} /> : <span className="muted">—</span> },
    { key: "dues", label: "Amount (USD)", num: true, sortable: true, render: (r) => <span className="money tnum"><span className="usd">{fmtUSD(r.dues)}</span></span> },
    { key: "commissionUsd", label: "Commission", num: true, render: (r) => <span className="money tnum"><span className="usd">{fmtUSD(r.commissionUsd)}</span><span className="ngn">{fmtNGN(r.commissionNgn)}</span></span> },
    { key: "status", label: "Status", sortable: true, sortVal: (r) => r.effective, render: (r) => <><StatusBadge status={r.effective} /><div className="muted" style={{ fontSize: 11, marginTop: 3 }}>{r.workflowStatus?.label || r.status}</div></> },
    { key: "due", label: "Due", sortable: true, sortVal: (r) => r.due, render: (r) => <span className="tnum muted">{fmtDate(r.due)}</span> },
    { key: "actions", label: "", num: true, render: (r) => (
      <div className="cell-actions">
        <PdfButton kind="invoice" id={r.id} />
        {r.inspectionId && <PdfButton kind="report" id={r.inspectionId} />}
      </div>) },
  ];

  const STATUSES: [string, string][] = [["all", "All"], ["paid", "Paid"], ["unpaid", "Unpaid"], ["overdue", "Overdue"], ["void", "Void"]];

  return (
    <div className="content-inner">
      <div className="page-head">
        <div>
          <h1 className="hide-sr">Invoices</h1>
          <p className="desc">Harbour dues and measurement disparity invoices, payment tracking and receivables.</p>
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
        <DataTable columns={columns} rows={rows} getKey={(r) => r.id} onRowClick={(r) => setDetailId(r.id)} mobileCards={false}
          emptyState={<EmptyState icon="invoice" title="No invoices found" body="Invoices appear here when an inspection is completed or Finance issues a disparity charge." />} />
        {/* mobile cards */}
        <div className="m-cards" style={{ padding: 16 }}>
          {rows.map((r) => (
            <div className="m-card" key={r.id} onClick={() => setDetailId(r.id)}>
              <div className="mc-top">
                <div><div className="mc-title">{r.vesselName}</div><div className="mc-sub mono-ref">{r.invoiceNo} · {r.purpose === "disparity" ? "Measurement disparity" : r.cargoType || "Harbour dues"}</div></div>
                <StatusBadge status={r.effective} />
              </div>
              <div className="mc-amt tnum">{fmtUSD(r.dues)}{r.purpose !== "disparity" && <span className="ngn">Commission {fmtUSD(r.commissionUsd)} · {fmtNGN(r.commissionNgn)}</span>}</div>
              <div className="mc-actions" onClick={(e) => e.stopPropagation()}>
                <PdfButton kind="invoice" id={r.id} />
                {r.inspectionId && <PdfButton kind="report" id={r.inspectionId} />}
              </div>
            </div>
          ))}
        </div>
      </div>

      {detail && <InvoiceDetail store={store} row={detail} onClose={() => setDetailId(null)} />}
    </div>
  );
}

function InvoiceDetail({ store, row, onClose }: { store: Store; row: InvoiceRow; onClose: () => void }) {
  const call = row.call;
  const currentInvoice: Invoice = store.invoices.find((invoice) => invoice.id === row.id)
    || (row as unknown as Invoice);
  const effective = effectiveInvoiceStatus(currentInvoice);
  const canPay = store.can("recordPayment") && effective !== "void";
  const disparity = row.purpose === "disparity";
  const paidAmount = row.paidAmount ?? (effective === "paid" ? row.dues : 0);
  const outstanding = row.outstandingAmount ?? Math.max(0, row.dues - paidAmount);
  const [pay, setPay] = useState({ paidOn: new Date().toISOString().slice(0, 10), method: "Bank transfer", reference: "" });
  const [reversalReason, setReversalReason] = useState("");
  const [reversing, setReversing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [nextStatusId, setNextStatusId] = useState("");
  const [statusFeedback, setStatusFeedback] = useState("");
  const [attachments, setAttachments] = useState<InvoiceAttachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [attachmentError, setAttachmentError] = useState("");
  const workflow = currentInvoice.workflowStatus;
  useEffect(() => {
    api.invoiceAttachments(row.id).then(({ results }) => setAttachments(results)).catch(() => setAttachmentError("Could not load uploaded invoice files."));
  }, [row.id]);
  const moveInvoice = async () => {
    if (!nextStatusId) return;
    setBusy(true);
    setStatusFeedback("");
    try {
      const label = store.invoiceStatusSteps?.find((step) => step.id === nextStatusId)?.label ?? "selected";
      await store.transitionInvoice(row.id, nextStatusId);
      setStatusFeedback(`Status saved: ${label}. The audit history has been updated.`);
      setNextStatusId("");
      store.toast(`Invoice moved to ${label}`, "success");
    } catch (error) { setStatusFeedback(error instanceof Error ? error.message : "Could not update invoice status"); store.toast(error instanceof Error ? error.message : "Could not update invoice status", "error"); }
    finally { setBusy(false); }
  };

  const uploadAttachment = async (file: File | undefined) => {
    if (!file) return;
    setUploading(true); setAttachmentError("");
    try {
      await api.uploadInvoiceAttachment(row.id, file);
      const { results } = await api.invoiceAttachments(row.id);
      setAttachments(results);
      store.toast("Invoice file uploaded securely", "success");
    } catch (error) { setAttachmentError(error instanceof Error ? error.message : "Could not upload invoice file"); }
    finally { setUploading(false); }
  };

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
        {row.inspectionId && <PdfButton kind="report" id={row.inspectionId} />}
        <PdfButton kind="invoice" id={row.id} />
      </>}>
      <div className="flex between items-center" style={{ marginBottom: 20 }}>
        <div><StatusBadge status={effective} /><div className="muted" style={{ fontSize: 12, marginTop: 4 }}>{workflow?.label || currentInvoice.status}</div></div>
        <span className="muted" style={{ fontSize: 13 }}>Issued {fmtDate(row.issued)} · Due {fmtDate(row.due)}</span>
      </div>
      <div className="card-title" style={{ marginBottom: 14 }}>Line-item breakdown</div>
      {disparity ? <>
        <div className="fin-row"><div className="fl">Purpose</div><div className="fv">Measurement disparity</div></div>
        <div className="fin-row"><div className="fl">Payer</div><div className="fv">{row.payer || "—"}</div></div>
        <div className="fin-row"><div className="fl">Final reconciliation</div><div className="fv mono-ref">{row.reconciliationId || "—"}</div></div>
        <a className="link-btn" href={`/app/measurements?callId=${encodeURIComponent(row.callId)}`}>View measurement reconciliation</a>
        {(row.lineItems || []).map((item) => <div key={item.lineId} className="card card-pad" style={{ marginTop: 16 }}>
          <div className="card-title">{item.description}</div>
          {(item.direction || item.category || item.containerSize || item.loadStatus) && <p className="muted" style={{ marginTop: 6 }}>{[item.direction, item.category, item.containerSize ? `${item.containerSize} ft` : null, item.loadStatus].filter(Boolean).join(" · ")}</p>}
          {item.basis && <div className="fin-row"><div className="fl">Quantity basis</div><div className="fv">{item.basis}</div></div>}
          <div className="fin-row"><div className="fl">Baseline / final ({item.unit})</div><div className="fv tnum">{item.baselineQuantity} / {item.finalQuantity}</div></div>
          <div className="fin-row"><div className="fl">Variance ({item.unit})</div><div className="fv tnum">{item.variance}</div></div>
          <div className="fin-row"><div className="fl">Tolerance<span className="basis">{item.toleranceMode}</span></div><div className="fv tnum">{item.tolerance} {item.unit}</div></div>
          <div className="fin-row"><div className="fl">Chargeable quantity / rate</div><div className="fv tnum">{item.chargeableQuantity} {item.unit} × {unitRateFormatter.format(Number(item.rate))}</div></div>
          <div className="fin-row"><div className="fl">Cumulative entitlement</div><div className="fv tnum">{fmtUSD(Number(item.entitlement))}</div></div>
          <div className="fin-row"><div className="fl">Opening charges / prior invoices</div><div className="fv tnum">{fmtUSD(Number(item.openingBilledAmount))} / {fmtUSD(Number(item.priorInvoicedAmount))}</div></div>
          <div className="fin-total"><div className="fl">Additional charge</div><div className="fv tnum">{fmtUSD(Number(item.amount))}</div></div>
        </div>)}
      </> : <>
        <div className="fin-row"><div className="fl">Cargo / product type</div><div className="fv">{row.cargoType ? <CargoTag type={row.cargoType} /> : "—"}</div></div>
        <div className="fin-row"><div className="fl">Net tonnage<span className="basis">dues basis</span></div><div className="fv tnum">{call ? fmtNum(call.nrt) : "—"} NT</div></div>
        <div className="fin-row"><div className="fl">Dues rate<span className="basis">{row.cargoType === "Liquid" ? "jetty tariff" : "dry cargo"}</span></div><div className="fv tnum">{fmtUSD(row.rate)} / ton</div></div>
        <div className="fin-row"><div className="fl">NPA harbour dues</div><div className="fv tnum">{fmtUSD(row.dues)}</div></div>
        <div className="fin-row"><div className="fl">Agency commission</div><div className="fv tnum">{fmtUSD(row.commissionUsd)} · {fmtNGN(row.commissionNgn)}</div></div>
      </>}
      <div className="fin-total"><div className="fl">Invoice total (USD)</div><div className="fv tnum">{fmtUSD(row.dues)}{!disparity && <span className="ngn">{fmtNGN(row.dues * row.fx)}</span>}</div></div>
      <div className="fin-row"><div className="fl">Collected / outstanding</div><div className="fv tnum">{fmtUSD(paidAmount)} / {fmtUSD(outstanding)}</div></div>

      <div className="card-title" style={{ margin: "26px 0 14px" }}>Status progression</div>
      <div className="muted" style={{ fontSize: 13, marginBottom: 10 }}>{(currentInvoice.statusHistory || []).map((event) => event.toLabel).join(" → ") || workflow?.label || currentInvoice.status}</div>
      {store.can("recordPayment") && effective !== "void" && (
        <div className="card" style={{ padding: 14, marginBottom: 10 }}>
          <Field label="Change invoice status" hint="Choose a status, then use Apply status change to save it and add a history entry."><select value={nextStatusId} onChange={(event) => { setNextStatusId(event.target.value); setStatusFeedback(""); }}><option value="">Choose status</option>{(store.invoiceStatusSteps || []).filter((step) => step.active && !step.isPaid).map((step) => <option value={step.id || ""} key={step.id}>{step.label}</option>)}</select></Field>
          <button type="button" className="btn btn-primary" disabled={busy || !nextStatusId} onClick={moveInvoice}>{busy ? "Saving status…" : "Apply status change"}</button>
          {statusFeedback && <p role="status" className="muted" style={{ margin: "10px 0 0", color: statusFeedback.startsWith("Status saved") ? "var(--success)" : "var(--danger)" }}>{statusFeedback}</p>}
        </div>
      )}
      {(currentInvoice.statusHistory || []).length > 0 && <div className="card" style={{ padding: 12, marginBottom: 10 }}>{currentInvoice.statusHistory!.map((event) => <div key={event.id} className="fin-row"><div className="fl">{event.toLabel}<span className="basis">{event.source}{event.actorName ? ` · ${event.actorName}` : ""}</span></div><div className="fv muted">{fmtDate(event.createdAt)}</div></div>)}</div>}

      <div className="card-title" style={{ margin: "26px 0 14px" }}>Uploaded invoice files</div>
      {store.can("recordPayment") && <label className="btn btn-secondary" style={{ display: "inline-flex", cursor: uploading ? "wait" : "pointer" }}><input aria-label="Upload invoice file" type="file" accept="application/pdf,image/png,image/jpeg,image/webp" disabled={uploading} style={{ position: "absolute", width: 1, height: 1, opacity: 0 }} onChange={(event) => { void uploadAttachment(event.target.files?.[0]); event.currentTarget.value = ""; }} />{uploading ? "Uploading file…" : "Upload invoice file"}</label>}
      <p className="muted" style={{ fontSize: 12 }}>PDF, PNG, JPEG, or WebP up to 15 MB. Files are private to this organization.</p>
      {attachmentError && <p role="alert" style={{ color: "var(--danger)", fontSize: 13 }}>{attachmentError}</p>}
      {attachments.length ? <div className="card" style={{ padding: 12, marginBottom: 10 }}>{attachments.map((attachment) => <div className="fin-row" key={attachment.id}><div className="fl">{attachment.fileName}<span className="basis">{Math.ceil(attachment.size / 1024)} KB</span></div><button type="button" className="btn btn-ghost btn-sm" onClick={async () => { const { downloadUrl } = await api.invoiceAttachment(attachment.id); window.open(downloadUrl, "_blank", "noopener"); }}>Open file</button></div>)}</div> : <p className="muted" style={{ fontSize: 13 }}>No supporting invoice files uploaded yet.</p>}

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
      ) : effective === "void" ? (
        <p className="muted">This invoice is void. No payment can be recorded.</p>
      ) : canPay ? (
        <>
          {effective === "overdue" && (
            <p className="muted" style={{ fontSize: 13, margin: "0 0 12px", color: "var(--danger)" }}>
              This invoice passed its due date ({fmtDate(row.due)}) with {fmtUSD(outstanding)} outstanding.
            </p>
          )}
          <p className="muted">Record payment for the remaining balance of {fmtUSD(outstanding)}.</p>
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
