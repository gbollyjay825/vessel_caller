// Authenticated shell. NOTE: this is the working baseline that proves the full
// stack (auth → org-scoped state → analytics). The full-fidelity screens
// (vessel calls, inspections, invoices, settings) are ported on top of it.
import { useEffect, useState } from "react";

import { useAuth } from "../auth/AuthContext";
import { api } from "../lib/api";
import { fmtCompactMT, fmtCompactUSD, fmtDate, fmtUSD, userInitials } from "../lib/format";
import type { Analytics } from "../types";
import { useStore } from "./store";

export function AppShell() {
  const { user, logout } = useAuth();
  const store = useStore();
  const [analytics, setAnalytics] = useState<Analytics | null>(null);

  useEffect(() => { api.analytics(12).then(setAnalytics).catch(() => setAnalytics(null)); }, [store.rev]);

  const active = store.calls.filter((c) => c.status !== "completed").length;
  const outstanding = store.invoices
    .filter((v) => v.status !== "paid")
    .reduce((sum, v) => sum + (v.dues || 0), 0);
  const collected = store.invoices
    .filter((v) => v.status === "paid")
    .reduce((sum, v) => sum + (v.dues || 0), 0);
  const recent = [...store.calls]
    .sort((a, b) => +new Date(b.registered) - +new Date(a.registered))
    .slice(0, 8);

  return (
    <div style={{ minHeight: "100vh", background: "#f6f8fa" }}>
      <header style={S.top}>
        <div style={{ display: "flex", alignItems: "center", gap: 11 }}>
          <span style={S.mark}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}
              strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 22V8" /><path d="M5 12H2a10 10 0 0 0 20 0h-3" /><circle cx="12" cy="5" r="3" />
            </svg>
          </span>
          <div>
            <div style={{ fontWeight: 700, fontSize: 15 }}>{store.org.name || "Vessel Caller"}</div>
            <div style={{ fontSize: 11.5, color: "#8a95a3" }}>{store.portLabel} · Inspection</div>
          </div>
        </div>
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ textAlign: "right" }}>
            <div style={{ fontWeight: 600, fontSize: 13 }}>{user?.name}</div>
            <div style={{ fontSize: 12, color: "#8a95a3" }}>{user?.role}</div>
          </div>
          <span style={S.avatar}>{userInitials(user?.name || "?")}</span>
          <button style={S.signout} onClick={logout}>Sign out</button>
        </div>
      </header>

      <main style={{ maxWidth: 1120, margin: "0 auto", padding: "28px 24px" }}>
        <h1 style={{ fontSize: 22, fontWeight: 800, letterSpacing: "-0.02em", margin: "0 0 4px" }}>Dashboard</h1>
        <p style={{ color: "#5f6b7a", margin: "0 0 22px", fontSize: 14 }}>
          What's happening across {store.portLabel} right now.
        </p>

        <div style={S.kpis}>
          <Kpi label="Active vessel calls" value={String(active)} />
          <Kpi label="Inspections" value={String(store.inspections.length)} />
          <Kpi label="Collected" value={fmtUSD(collected, 0)} />
          <Kpi label="Outstanding" value={fmtUSD(outstanding, 0)} accent />
        </div>

        {analytics && (
          <div style={S.card}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 12 }}>
              <b style={{ fontSize: 14 }}>Cargo throughput · 12 months (from the database)</b>
              <span style={{ fontSize: 12, color: "#8a95a3" }}>
                {fmtCompactMT(analytics.totals.liquidT)} MT liquid · {fmtCompactMT(analytics.totals.dryT)} MT dry
              </span>
            </div>
            <div style={{ display: "flex", gap: 24, flexWrap: "wrap", fontSize: 13, color: "#5f6b7a" }}>
              <span>Invoiced <b style={{ color: "#16191d" }}>{fmtCompactUSD(analytics.totals.invoiced)}</b></span>
              <span>Collected <b style={{ color: "#1f9254" }}>{fmtCompactUSD(analytics.totals.collected)}</b></span>
              <span>Outstanding <b style={{ color: "#b6781e" }}>{fmtCompactUSD(analytics.totals.outstanding)}</b></span>
              <span>Calls <b style={{ color: "#16191d" }}>{analytics.totals.calls}</b></span>
            </div>
            <MiniBars analytics={analytics} />
          </div>
        )}

        <div style={S.card}>
          <b style={{ fontSize: 14 }}>Recent vessel calls</b>
          <table style={{ width: "100%", borderCollapse: "collapse", marginTop: 12, fontSize: 13.5 }}>
            <thead>
              <tr style={{ textAlign: "left", color: "#8a95a3", fontSize: 11.5, textTransform: "uppercase" }}>
                <th style={S.th}>Vessel</th><th style={S.th}>Rotation</th><th style={S.th}>Status</th>
                <th style={{ ...S.th, textAlign: "right" }}>Dues</th>
              </tr>
            </thead>
            <tbody>
              {recent.map((c) => {
                const f = store.financialsForCall(c);
                return (
                  <tr key={c.id} style={{ borderTop: "1px solid #eef1f4" }}>
                    <td style={S.td}><b>{c.vesselName}</b><div style={{ color: "#8a95a3", fontSize: 11.5 }}>{fmtDate(c.berthDate)}</div></td>
                    <td style={S.td}>{c.reference}</td>
                    <td style={S.td}><span style={statusPill(c.status)}>{c.status}</span></td>
                    <td style={{ ...S.td, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{f ? fmtUSD(f.dues) : "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <p style={{ color: "#8a95a3", fontSize: 12.5, marginTop: 18 }}>
          Signed in as {user?.email} · role-gated by the server ({store.role}).
        </p>
      </main>

      <ToastHost />
    </div>
  );
}

function Kpi({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div style={{ ...S.kpi, borderColor: accent ? "#f1d6ac" : "#e8eaed" }}>
      <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.05em", textTransform: "uppercase", color: "#8a95a3" }}>{label}</div>
      <div style={{ fontSize: 24, fontWeight: 800, letterSpacing: "-0.02em", marginTop: 4 }}>{value}</div>
    </div>
  );
}

function MiniBars({ analytics }: { analytics: Analytics }) {
  const max = Math.max(1, ...analytics.series.map((r) => r.liquidT + r.dryT));
  return (
    <div style={{ display: "flex", alignItems: "flex-end", gap: 6, height: 90, marginTop: 16 }}>
      {analytics.series.map((r) => {
        const total = r.liquidT + r.dryT;
        return (
          <div key={r.key} title={`${r.month} ${r.year}: ${Math.round(total).toLocaleString()} MT`}
            style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "flex-end", height: "100%", gap: 2 }}>
            <div style={{ height: `${(r.liquidT / max) * 100}%`, background: "#1b5faa", borderRadius: "3px 3px 0 0", minHeight: 1 }} />
            <div style={{ height: `${(r.dryT / max) * 100}%`, background: "#d9a441", minHeight: 1 }} />
            <div style={{ fontSize: 9, color: "#b6bcc4", textAlign: "center" }}>{r.month[0]}</div>
          </div>
        );
      })}
    </div>
  );
}

function ToastHost() {
  const { toasts, dismissToast } = useStore();
  return (
    <div style={{ position: "fixed", bottom: 20, right: 20, display: "flex", flexDirection: "column", gap: 8, zIndex: 100 }}>
      {toasts.map((t) => (
        <div key={t.id} onClick={() => dismissToast(t.id)}
          style={{ background: t.type === "error" ? "#c0392b" : "#16191d", color: "#fff", padding: "11px 16px",
            borderRadius: 9, fontSize: 13.5, boxShadow: "0 10px 30px rgba(16,19,29,.2)", cursor: "pointer", maxWidth: 340 }}>
          {t.message}
        </div>
      ))}
    </div>
  );
}

function statusPill(status: string): React.CSSProperties {
  const map: Record<string, [string, string]> = {
    completed: ["#1f9254", "#e7f4ec"], "in-progress": ["#1b5faa", "#e6eff8"], pending: ["#b6781e", "#fbf1df"],
  };
  const [color, bg] = map[status] || ["#5f6b7a", "#eef1f4"];
  return { color, background: bg, padding: "3px 9px", borderRadius: 999, fontSize: 11, fontWeight: 700, textTransform: "capitalize" };
}

const S: Record<string, React.CSSProperties> = {
  top: { display: "flex", alignItems: "center", gap: 12, padding: "0 24px", height: 62, background: "#fff", borderBottom: "1px solid #e8eaed", position: "sticky", top: 0, zIndex: 10 },
  mark: { display: "grid", placeItems: "center", width: 34, height: 34, borderRadius: 9, background: "#1b5faa", color: "#fff" },
  avatar: { display: "grid", placeItems: "center", width: 34, height: 34, borderRadius: "50%", background: "#0e2a47", color: "#fff", fontWeight: 700, fontSize: 12.5 },
  signout: { border: "1px solid #e8eaed", background: "#fff", borderRadius: 999, padding: "8px 14px", fontWeight: 600, fontSize: 13, cursor: "pointer" },
  kpis: { display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 14, marginBottom: 18 },
  kpi: { background: "#fff", border: "1px solid #e8eaed", borderRadius: 14, padding: "16px 18px" },
  card: { background: "#fff", border: "1px solid #e8eaed", borderRadius: 16, padding: 22, marginBottom: 18 },
  th: { padding: "6px 8px", fontWeight: 600 },
  td: { padding: "10px 8px", verticalAlign: "top" },
};
