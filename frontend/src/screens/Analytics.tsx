// Analytics — cargo throughput & revenue across the port (liquid vs dry/bulk).
// Ported from calabar/screen-analytics.jsx. Loads REAL data via api.analytics(12)
// (instead of the old hardcoded AN_SERIES/PRODUCTS/AN_TOTALS) and slices it
// client-side for the 3M / 6M / 12M period toggle, exactly like the prototype.
import { useEffect, useMemo, useState } from "react";

import { api } from "../lib/api";
import { fmtCompactMT, fmtCompactUSD, fmtNum } from "../lib/format";
import { useStore } from "../app/store";
import { Icon } from "../components/Icon";
import { AreaTrend, MiniSpark, MixDonut, RevenueBars } from "../components/charts";
import type { Analytics as AnalyticsData, AnalyticsProduct, AnalyticsSeriesRow } from "../types";

// The API series only carries a combined monthly `revenue`; charts want the
// liquid/dry split, so we enrich each row with derived liquidR/dryR.
type SeriesRow = AnalyticsSeriesRow & { liquidR: number; dryR: number };
// The charts + leaderboard also expect a display label, a swatch colour, and
// the cargo category — none of which the API product carries.
type Product = AnalyticsProduct & { cat: "Liquid" | "Dry"; label: string; color: string };

// Keys the seed data treats as petroleum (liquid); everything else is dry/bulk.
const LIQUID_KEYS = new Set(["PMS", "AGO", "DPK"]);
// Product swatch palette (mirrors the prototype's per-product colours).
const PRODUCT_COLORS: Record<string, string> = {
  PMS: "#1B5FAA", AGO: "#2F84E3", DPK: "#7FB4EC",
  Wheat: "#C2871D", Fertiliser: "#E0A21A", Clinker: "#9AA3B0", Sugar: "#EBCB7C",
};
const FALLBACK_COLORS = ["#1B5FAA", "#2F84E3", "#7FB4EC", "#C2871D", "#E0A21A", "#9AA3B0", "#EBCB7C"];
const colorFor = (key: string, i: number) => PRODUCT_COLORS[key] || FALLBACK_COLORS[i % FALLBACK_COLORS.length];

export function Analytics() {
  const store = useStore();
  const [data, setData] = useState<AnalyticsData | null>(null);
  const [period, setPeriod] = useState(12);
  const [shown, setShown] = useState(false);

  // Load a full 12 months once; the period toggle re-slices client-side.
  useEffect(() => {
    let alive = true;
    api.analytics(12)
      .then((d) => { if (alive) setData(d); })
      .catch((err: any) => store.toast(err.message || "Failed to load analytics", "error"));
    return () => { alive = false; };
  }, []);

  // Trigger the chart entrance animation once data has arrived.
  useEffect(() => {
    if (!data) return;
    const id = setTimeout(() => setShown(true), 40);
    return () => clearTimeout(id);
  }, [data]);

  // Derive the sliced series, period totals, and period-scaled product mix.
  const view = useMemo(() => {
    if (!data) return null;
    const t = data.totals;
    // Per-tonne blended rates from the 12-month totals, used to split each
    // month's combined revenue back into liquid vs dry (rate-weighted).
    const liqRate = t.liquidT ? t.liquidR / t.liquidT : 0;
    const dryRate = t.dryT ? t.dryR / t.dryT : 0;
    const fullSeries: SeriesRow[] = data.series.map((d) => {
      const lr = d.liquidT * liqRate;
      const dr = d.dryT * dryRate;
      const denom = lr + dr;
      const scale = denom > 0 ? d.revenue / denom : 0; // keep liquidR+dryR === monthly revenue
      return { ...d, liquidR: Math.round(lr * scale), dryR: Math.round(dr * scale) };
    });

    const series = fullSeries.slice(-period);
    const liquidT = series.reduce((s, d) => s + d.liquidT, 0);
    const dryT = series.reduce((s, d) => s + d.dryT, 0);
    const liquidR = series.reduce((s, d) => s + d.liquidR, 0);
    const dryR = series.reduce((s, d) => s + d.dryR, 0);
    const calls = series.reduce((s, d) => s + d.calls, 0);
    const totals = {
      liquidT, dryT, liquidR, dryR, calls,
      throughput: liquidT + dryT, revenue: liquidR + dryR,
    };

    // Scale each product to the selected period by its within-category share.
    const products: Product[] = data.products.map((p, i) => {
      const liquid = LIQUID_KEYS.has(p.key);
      const catT = liquid ? totals.liquidT : totals.dryT;
      const catR = liquid ? totals.liquidR : totals.dryR;
      return {
        ...p,
        cat: liquid ? "Liquid" : "Dry",
        label: p.name,
        color: colorFor(p.key, i),
        tonnage: Math.round(catT * p.share),
        revenue: Math.round(catR * p.share),
      };
    });

    return { series, totals, products };
  }, [data, period]);

  const portName = store.portLabel || store.settings.portName;

  // ---- loading ----
  if (!view) {
    return (
      <div className="content-inner">
        <div className="page-head">
          <div>
            <h1 className="hide-sr">Analytics</h1>
            <p className="desc">Cargo throughput and revenue across {portName}.</p>
          </div>
        </div>
        <div style={{ display: "flex", justifyContent: "center", alignItems: "center", padding: "80px 0", color: "var(--muted)" }}>
          <Icon name="spinner" size={22} strokeWidth={2} className="spin" />
        </div>
      </div>
    );
  }

  const { series, totals, products } = view;
  const pms = products.find((p) => p.key === "PMS") || products[0];
  const pmsShare = pms ? pms.share : 0;
  const leaderboard = [...products].sort((a, b) => b.tonnage - a.tonnage);
  const maxT = leaderboard.length ? leaderboard[0].tonnage : 0;
  const callsSeries = series.map((d) => d.calls);
  const liqPct = totals.throughput ? (totals.liquidT / totals.throughput) * 100 : 0;
  const periodLabel = period === 12 ? "Last 12 months" : `Last ${period} months`;

  return (
    <div className={"content-inner" + (shown ? " charts-in" : "")}>
      <div className="page-head">
        <div>
          <h1 className="hide-sr">Analytics</h1>
          <p className="desc">Cargo throughput and revenue across {portName} — petroleum (PMS, AGO, DPK) against dry &amp; bulk cargo.</p>
        </div>
        <div className="seg" role="tablist" aria-label="Period">
          {([[3, "3M"], [6, "6M"], [12, "12M"]] as [number, string][]).map(([k, l]) => (
            <button key={k} className={period === k ? "on" : ""} onClick={() => setPeriod(k)}>{l}</button>
          ))}
        </div>
      </div>

      {/* KPI strip */}
      <div className="kpi-strip">
        <div className="stat-card an-kpi">
          <div className="stat-label">Cargo throughput</div>
          <div className="stat-num tnum">{fmtCompactMT(totals.throughput)}<span className="cur" style={{ marginLeft: 6, marginRight: 0 }}>MT</span></div>
          <div className="split-bar"><div className="seg-l" style={{ width: liqPct + "%" }} /><div className="seg-d" style={{ width: (100 - liqPct) + "%" }} /></div>
          <div className="split-leg">
            <span className="sl-i"><span className="sw" style={{ background: "var(--accent)" }} /> Liquid {fmtCompactMT(totals.liquidT)}</span>
            <span className="sl-i"><span className="sw" style={{ background: "#D9A441" }} /> Dry {fmtCompactMT(totals.dryT)}</span>
          </div>
        </div>

        <div className="stat-card an-kpi">
          <div className="stat-label">Total revenue</div>
          <div className="stat-num tnum">{fmtCompactUSD(totals.revenue)}</div>
          <div className="split-bar"><div className="seg-l" style={{ width: (totals.revenue ? totals.liquidR / totals.revenue * 100 : 0) + "%" }} /><div className="seg-d" style={{ width: (totals.revenue ? totals.dryR / totals.revenue * 100 : 0) + "%" }} /></div>
          <div className="split-leg">
            <span className="sl-i"><span className="sw" style={{ background: "var(--accent)" }} /> Liquid {fmtCompactUSD(totals.liquidR)}</span>
            <span className="sl-i"><span className="sw" style={{ background: "#D9A441" }} /> Dry {fmtCompactUSD(totals.dryR)}</span>
          </div>
        </div>

        <div className="stat-card an-kpi">
          <div className="stat-label">Vessel calls</div>
          <div className="stat-num tnum">{fmtNum(totals.calls)}</div>
          <div style={{ marginTop: 6 }}><MiniSpark values={callsSeries} color="#1B5FAA" w={150} h={34} /></div>
          <div className="stat-sub">{periodLabel}</div>
        </div>

        <div className="stat-card an-kpi">
          <div className="stat-label">Liquid share</div>
          <div className="stat-num tnum">{liqPct.toFixed(0)}<span className="cur" style={{ marginLeft: 2, marginRight: 0 }}>%</span></div>
          <div className="stat-sub" style={{ marginTop: 8 }}><span className="delta up"><Icon name="arrowRight" size={13} strokeWidth={2.2} style={{ transform: "rotate(-45deg)" }} />4.2 pts</span> of total tonnage</div>
        </div>
      </div>

      {/* throughput + donut */}
      <div className="an-grid section-gap">
        <div className="card card-pad">
          <div className="card-head" style={{ padding: 0, border: "none", marginBottom: 4 }}>
            <div className="card-title">Cargo throughput over time</div>
            <div className="chart-legend">
              <span className="cl"><span className="sw" style={{ background: "#1B5FAA" }} /> Liquid</span>
              <span className="cl"><span className="sw" style={{ background: "#D9A441" }} /> Dry / bulk</span>
            </div>
          </div>
          <AreaTrend series={series} />
        </div>
        <div className="card card-pad">
          <div className="card-title">Product mix by volume</div>
          <MixDonut products={products} total={totals.throughput} />
        </div>
      </div>

      {/* revenue + PMS spotlight */}
      <div className="an-grid section-gap">
        <div className="card card-pad">
          <div className="card-head" style={{ padding: 0, border: "none", marginBottom: 4 }}>
            <div className="card-title">Revenue · liquid vs dry</div>
            <div className="chart-legend">
              <span className="cl"><span className="sw" style={{ background: "#1B5FAA" }} /> Liquid</span>
              <span className="cl"><span className="sw" style={{ background: "#D9A441" }} /> Dry / bulk</span>
            </div>
          </div>
          <RevenueBars series={series} />
        </div>
        <div className="spotlight">
          <div className="sl-eyebrow"><Icon name="droplet" size={14} strokeWidth={2} /> PMS · Premium Motor Spirit</div>
          <div className="sl-num tnum">{fmtCompactMT(pms ? pms.tonnage : 0)}<span className="sl-unit">MT discharged</span></div>
          <div className="sl-sub">{(pms && totals.throughput ? pms.tonnage / totals.throughput * 100 : 0).toFixed(0)}% of all cargo across {portName} · {periodLabel.toLowerCase()}</div>
          <div className="sl-divide" />
          <div className="sl-row"><span className="l">Revenue from PMS</span><span className="v tnum">{fmtCompactUSD(pms ? pms.revenue : 0)}</span></div>
          <div className="sl-spark"><MiniSpark values={series.map((d) => Math.round(d.liquidT * pmsShare))} color="#FFFFFF" w={260} h={40} /></div>
        </div>
      </div>

      {/* leaderboard */}
      <div className="card section-gap">
        <div className="card-head">
          <div className="card-title">Cargo by product</div>
          <span className="muted" style={{ fontSize: 13 }}>{periodLabel} · ranked by volume</span>
        </div>
        <div className="table-wrap">
          <table className="lead-table">
            <tbody>
              {leaderboard.map((p, i) => (
                <tr key={p.key}>
                  <td className="lead-rank">{i + 1}</td>
                  <td><div className="lead-name"><span className="sw" style={{ background: p.color, width: 12, height: 12 }} /> {p.label} <span className={"tag " + (p.cat === "Liquid" ? "liquid" : "dry")} style={{ marginLeft: 4 }}>{p.cat}</span></div></td>
                  <td className="lead-bar-wrap"><div className="lead-bar"><i style={{ width: (maxT ? p.tonnage / maxT * 100 : 0) + "%", background: p.color }} /></div></td>
                  <td className="lead-num">{fmtNum(p.tonnage)} MT</td>
                  <td className="lead-sub">{fmtCompactUSD(p.revenue)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
