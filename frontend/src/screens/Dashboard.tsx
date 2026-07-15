// Dashboard — KPI strip + cargo-throughput chart (real analytics) + recent
// vessel calls. Ported from calabar/screens-ops.jsx (Dashboard) to an ES-module
// TSX screen that reads useStore() and navigates via react-router.
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";

import { useStore } from "../app/store";
import { AreaTrend, MiniSpark } from "../components/charts";
import { Icon } from "../components/Icon";
import {
  DataTable, EmptyState, PdfButton, StatCard, StatusBadge, type Column,
} from "../components/ui";
import { api } from "../lib/api";
import {
  effectiveInvoiceStatus, fmtCompactMT, fmtCompactUSD, fmtDate, fmtNGN, fmtUSD,
} from "../lib/format";
import type { Analytics, VesselCall } from "../types";

type StoreApi = ReturnType<typeof useStore>;

// =========================================================
// Dashboard
// =========================================================
export function Dashboard() {
  const store = useStore();
  const navigate = useNavigate();
  const { calls } = store;

  const now = new Date();
  const ym = now.toISOString().slice(0, 7);
  const monthLabel = now.toLocaleDateString("en-GB", { month: "long", year: "numeric" });

  const [chartsShown, setChartsShown] = useState(false);
  useEffect(() => {
    const id = setTimeout(() => setChartsShown(true), 40);
    return () => clearTimeout(id);
  }, []);

  // Real 12-month analytics from the API (replaces the old hardcoded series).
  const [analytics, setAnalytics] = useState<Analytics | null>(null);
  useEffect(() => {
    let cancelled = false;
    api.analytics(12).then((a) => { if (!cancelled) setAnalytics(a); }).catch(() => {});
    return () => { cancelled = true; };
  }, [store.rev]);

  const kpis = useMemo(() => {
    const active = calls.filter((c) => c.status === "pending" || c.status === "in-progress").length;
    const insThisMonth = store.inspections.filter((i) => i.date && i.date.startsWith(ym)).length;
    let duesCollected = 0, commUsd = 0, commNgn = 0;
    store.invoices.forEach((iv) => {
      const f = store.financialsForCall(store.calls.find((c) => c.id === iv.callId));
      if (!f) return;
      if (iv.status === "paid") duesCollected += f.dues;
      commUsd += f.commissionUsd; commNgn += f.commissionNgn;
    });
    return { active, insThisMonth, duesCollected, commUsd, commNgn };
  }, [calls, store.invoices, store.inspections, store.settings, ym]);

  const recent = useMemo(
    () => [...calls].sort((a, b) => +new Date(b.registered) - +new Date(a.registered)).slice(0, 6),
    [calls],
  );

  const totals = analytics?.totals;
  const series = analytics?.series ?? [];
  const pms = analytics?.products.find((p) => p.key === "PMS");
  const pmsPct = pms && totals && totals.throughput
    ? Math.round((pms.tonnage / totals.throughput) * 100) : 0;
  const pmsMonthly = pms ? series.map((d) => Math.round(d.liquidT * pms.share)) : [];

  const columns: Column<VesselCall>[] = [
    { key: "vesselName", label: "Vessel Name", sortable: true,
      render: (r) => <div className="cell-primary">{r.vesselName}</div> },
    { key: "reference", label: "Rotation Number", render: (r) => <span className="mono-ref">{r.reference}</span> },
    { key: "type", label: "Type", sortable: true, render: (r) => <span className="muted">{r.type}</span> },
    { key: "status", label: "Status", sortable: true, sortVal: (r) => r.status, render: (r) => <StatusBadge status={r.status} /> },
    { key: "berthDate", label: "Berth Date", sortable: true, sortVal: (r) => r.berthDate || "", render: (r) => <span className="tnum muted">{r.berthDate ? fmtDate(r.berthDate) : "—"}</span> },
    { key: "dues", label: "Dues", num: true, sortable: true, sortVal: (r) => store.financialsForCall(r)?.dues || 0,
      render: (r) => { const f = store.financialsForCall(r); return f ? <span className="money tnum"><span className="usd">{fmtUSD(f.dues)}</span></span> : <span className="muted">—</span>; } },
    { key: "actions", label: "", num: true, render: (r) => <RowActions store={store} call={r} /> },
  ];

  return (
    <div className={"content-inner" + (chartsShown ? " charts-in" : "")}>
      <div className="page-head">
        <div>
          <h1 className="hide-sr">Dashboard</h1>
          <p className="desc">What's happening across {store.portLabel} right now.</p>
        </div>
        <button className="btn btn-primary" disabled={!store.can("registerCall")}
          title={store.can("registerCall") ? undefined : "Requires the Admin or Operations role"}
          onClick={() => navigate("/app/vessel-calls")}>
          <Icon name="plus" size={17} strokeWidth={2.2} /> Register Vessel Call
        </button>
      </div>

      {calls.length === 0 ? (
        <EmptyState icon="ship" title="No vessel calls yet"
          body="Register the first incoming vessel to get started."
          action={<button className="btn btn-primary" onClick={() => navigate("/app/vessel-calls")}><Icon name="plus" size={17} strokeWidth={2.2} /> Register Vessel Call</button>} />
      ) : (
        <>
          <div className="kpi-strip">
            <StatCard label="Active Vessel Calls" value={kpis.active} delta={{ dir: "up", text: "+2" }} sub="vs last week" />
            <StatCard label="Inspections This Month" value={kpis.insThisMonth} delta={{ dir: "up", text: "+1" }} sub={monthLabel} />
            <StatCard label="Harbour Dues Collected" value={fmtUSD(kpis.duesCollected, 0).replace("$", "")} cur="$" sub={monthLabel} />
            <StatCard label="Commission Earned" value={fmtUSD(kpis.commUsd, 0).replace("$", "")} cur="$" ngn={fmtNGN(kpis.commNgn)} sub={monthLabel} />
          </div>

          {analytics && totals && (
            <div className="an-grid section-gap">
              <div className="card card-pad">
                <div className="card-head" style={{ padding: 0, border: "none", marginBottom: 4 }}>
                  <div>
                    <div className="card-title">Cargo throughput · last 12 months</div>
                    <div className="muted" style={{ fontSize: 13, marginTop: 2 }}>
                      <span style={{ color: "var(--accent)", fontWeight: 600 }}>{fmtCompactMT(totals.liquidT)} MT liquid</span> · {fmtCompactMT(totals.dryT)} MT dry
                    </div>
                  </div>
                  <button className="link-btn" onClick={() => navigate("/app/analytics")}>Full analytics <Icon name="chevronRight" size={14} strokeWidth={2.2} style={{ verticalAlign: "-2px" }} /></button>
                </div>
                <div className="chart-legend" style={{ marginTop: 8 }}>
                  <span className="cl"><span className="sw" style={{ background: "#1B5FAA" }} /> Liquid (PMS · AGO · DPK)</span>
                  <span className="cl"><span className="sw" style={{ background: "#D9A441" }} /> Dry / bulk</span>
                </div>
                <AreaTrend series={series} />
              </div>

              {pms && (
                <div className="spotlight">
                  <div className="sl-eyebrow"><Icon name="droplet" size={14} strokeWidth={2} /> PMS · Premium Motor Spirit</div>
                  <div className="sl-num tnum">{fmtCompactMT(pms.tonnage)}<span className="sl-unit">MT</span></div>
                  <div className="sl-sub">{pmsPct}% of all cargo across {store.portLabel} · last 12 months</div>
                  <div className="sl-divide" />
                  <div className="sl-row"><span className="l">Revenue from PMS</span><span className="v tnum">{fmtCompactUSD(pms.revenue)}</span></div>
                  <div className="sl-spark"><MiniSpark values={pmsMonthly} color="#FFFFFF" w={260} h={42} /></div>
                </div>
              )}
            </div>
          )}

          <div className="card section-gap">
            <div className="card-head">
              <div className="card-title">Recent Vessel Calls</div>
              <button className="link-btn" onClick={() => navigate("/app/vessel-calls")}>View all <Icon name="chevronRight" size={14} strokeWidth={2.2} style={{ verticalAlign: "-2px" }} /></button>
            </div>
            <DataTable columns={columns} rows={recent} getKey={(r) => r.id}
              onRowClick={(r) => navigate("/app/vessel-calls/" + r.id)} />
          </div>
        </>
      )}
    </div>
  );
}

// Inline row actions: completed -> Invoice + Report PDFs; else -> Open detail.
function RowActions({ store, call }: { store: StoreApi; call: VesselCall }) {
  const navigate = useNavigate();
  if (call.status === "completed") {
    const f = store.financialsForCall(call);
    const rec = pdfRecord(store, call);
    return (
      <div className="cell-actions">
        <PdfButton kind="invoice" record={rec} disabled={!f} />
        <PdfButton kind="report" record={rec} disabled={!f} />
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

// Build the query-param record a PDF page needs. Prefers the invoice's
// issue-time money snapshot over recomputed figures.
export function pdfRecord(store: StoreApi, call: VesselCall): Record<string, string> {
  const f = store.financialsForCall(call);
  const insp = store.inspectionsForCall(call.id).find((i) => i.status === "completed");
  const inv = store.invoiceForCall(call.id);
  const snap = inv && inv.dues != null ? inv : null;
  const jetty = insp?.jetty || null;
  const jettyLabel = jetty
    ? (jetty.type === "International" ? "International Jetty" : `${jetty.category || ""} Jetty (Local)`.trim())
    : "";
  return {
    vessel: call.vesselName, callRef: call.reference, type: call.type,
    nrt: String(call.nrt), berth: call.berth || "", date: insp?.date || call.berthDate || "",
    invoiceNo: inv?.invoiceNo || "—", dueDate: inv?.due || "",
    cargoType: insp?.cargoType || "—", tonnage: insp ? String(insp.reconciledTonnage) : "0",
    dues: String(snap ? snap.dues : (f?.dues || 0)), duesRate: String(snap ? (snap.rate || 0) : (f?.rate || 0)), commRate: String(store.settings.commissionRate),
    commUsd: String(snap ? (snap.commissionUsd || 0) : (f?.commissionUsd || 0)), commNgn: String(snap ? (snap.commissionNgn || 0) : (f?.commissionNgn || 0)),
    fx: String(snap && snap.fx != null ? snap.fx : store.settings.exchangeRate), port: store.org?.primaryPort || store.settings.portName,
    jettyType: jettyLabel, jettyName: jetty?.name || "",
    invStatus: inv ? effectiveInvoiceStatus(inv) : "",
    paidOn: inv?.payment?.paidOn || "", payRef: inv?.payment?.reference || "", payMethod: inv?.payment?.method || "",
  };
}
