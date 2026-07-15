// Quayside data-capture app (mobile) — ported from mobile/mobile-app.jsx +
// mobile/ios-frame.jsx to TSX ES modules. Data + mutations come from useStore();
// identity from useAuth(). A minimal iOS device frame is inlined below.
import {
  createElement, useEffect, useMemo, useRef, useState,
  type ReactNode,
} from "react";

import { useStore } from "../app/store";
import { useAuth } from "../auth/AuthContext";
import { Icon } from "../components/Icon";
import { calcPreview, rateForInspection } from "../lib/calc";
import {
  fmtDate, fmtNGN, fmtNum, fmtTons, fmtUSD, orgPortsLabel, userInitials,
} from "../lib/format";
import type { CargoType, Inspection, Settings, VesselCall } from "../types";

import "../styles/mobile.css";

// reconciled-tonnage maths (mirrors the desktop / server)
function reconcile(cargo: string, m: any): number {
  if (cargo === "Liquid") {
    // Reconciled by the surveyor and entered directly.
    return Math.round((Number(m.surveyorTonnage) || 0) * 100) / 100;
  }
  return Math.round(
    ((Number(m.displBefore) || 0) - (Number(m.displAfter) || 0) - (Number(m.deductibles) || 0) + (Number(m.constant) || 0)) * 100,
  ) / 100;
}

function MBadge({ status }: { status: string }) {
  const L: Record<string, string> = { pending: "Pending", "in-progress": "In progress", completed: "Completed", synced: "Synced", draft: "Draft" };
  return <span className={"m-badge " + status}><span className="dot" />{L[status] || status}</span>;
}
function MTag({ type }: { type: string }) {
  const liquid = type === "Liquid";
  return <span className={"m-tag " + (liquid ? "liquid" : "dry")}><Icon name={liquid ? "droplet" : "package"} size={12} strokeWidth={2} />{type}</span>;
}

// =========================================================
// Root — wired to the shared store (polling + mutations live there)
// =========================================================
export function MobileApp() {
  const store = useStore();
  const [tab, setTab] = useState<"tasks" | "captured" | "account">("tasks");
  const [capture, setCapture] = useState<{ callId: string } | null>(null);
  const [syncingIds, setSyncingIds] = useState<string[]>([]); // captures still "uploading"

  const calls = store.calls;
  const captured = store.inspections
    .filter((i) => i.status === "completed")
    .map((i) => ({ ...i, synced: !syncingIds.includes(i.id) }));

  const awaiting = calls.filter((c) => c.status !== "completed");
  const pendingSync = syncingIds.length;
  const portLabel = orgPortsLabel(store.org, "Port of Calabar");

  // If the call being captured vanishes from the store (cancelled on the
  // desktop, or a data reset), close the capture flow instead of stranding
  // the surveyor on a dead screen.
  useEffect(() => {
    if (capture && !store.calls.some((c) => c.id === capture.callId)) setCapture(null);
  }, [store.calls, capture]);

  // brief "uploading" chip while the platform ingests a fresh capture
  const markSyncing = (id: string) => {
    setSyncingIds((ids) => [id, ...ids]);
    setTimeout(() => setSyncingIds((ids) => ids.filter((x) => x !== id)), 2600);
  };

  return (
    <div className="stage">
      <IOSFrame>
        <div className="mob">
          {capture ? (
            <CaptureFlow
              call={calls.find((c) => c.id === capture.callId)}
              settings={store.settings}
              onClose={() => setCapture(null)}
              onSubmitted={markSyncing}
            />
          ) : (
            <div className="mob-app">
              <div className="mob-body">
                {tab === "tasks" && <TasksTab awaiting={awaiting} pendingSync={pendingSync} port={portLabel} onStart={(id) => setCapture({ callId: id })} />}
                {tab === "captured" && <CapturedTab captured={captured} calls={calls} />}
                {tab === "account" && <AccountTab pendingSync={pendingSync} port={portLabel} />}
              </div>
              <TabBar tab={tab} setTab={setTab} />
            </div>
          )}
        </div>
      </IOSFrame>
    </div>
  );
}

// =========================================================
// Tasks
// =========================================================
function TasksTab({ awaiting, pendingSync, port, onStart }:
  { awaiting: VesselCall[]; pendingSync: number; port: string; onStart: (id: string) => void }) {
  const ready = awaiting.filter((c) => c.status === "in-progress");
  const upcoming = awaiting.filter((c) => c.status === "pending");
  return (
    <>
      <div className="mob-head">
        <div className="row">
          <div>
            <div className="eyebrow">{port}</div>
            <h1>Inspections</h1>
          </div>
          <span className={"sync-chip " + (pendingSync ? "pending" : "")}>
            <span className="cdot" />{pendingSync ? `${pendingSync} to sync` : "All synced"}
          </span>
        </div>
      </div>

      {pendingSync > 0 && (
        <div className="offline-banner"><Icon name="info" size={16} strokeWidth={2} /> {pendingSync} capture{pendingSync > 1 ? "s" : ""} waiting to upload — will sync automatically.</div>
      )}

      <div className="mob-section">
        {ready.length > 0 && <div className="mob-section-label">Berthed · ready to inspect</div>}
        {ready.map((c) => <TaskCard key={c.id} call={c} onStart={onStart} />)}
        {upcoming.length > 0 && <div className="mob-section-label">Awaiting berth</div>}
        {upcoming.map((c) => <TaskCard key={c.id} call={c} onStart={onStart} />)}
        {awaiting.length === 0 && (
          <div className="empty-tab"><div className="ei"><Icon name="check" size={26} /></div><h3>All caught up</h3><p>No vessels are awaiting inspection right now.</p></div>
        )}
      </div>
    </>
  );
}

function TaskCard({ call, onStart }: { call: VesselCall; onStart: (id: string) => void }) {
  const berthed = call.status === "in-progress";
  return (
    <div className="task-card" onClick={() => onStart(call.id)}>
      <div className="tc-top">
        <div>
          <div className="tc-name">{call.vesselName}</div>
          <div className="tc-ref">{call.reference} · {call.type}</div>
        </div>
        <MBadge status={call.status} />
      </div>
      <div className="tc-meta">
        <span className="mi"><Icon name="anchor" size={15} strokeWidth={2} /> {call.berth ? call.berth.split("—")[0].trim() : "TBA"}</span>
        <span className="mi"><Icon name="calendar" size={15} strokeWidth={2} /> {fmtDate(call.eta)}</span>
        <span className="tc-cta">{berthed ? "Capture" : "Open"} <Icon name="chevronRight" size={15} strokeWidth={2.4} /></span>
      </div>
    </div>
  );
}

// =========================================================
// Capture flow
// =========================================================
function CaptureFlow({ call, settings, onClose, onSubmitted }:
  { call: VesselCall | undefined; settings: Settings; onClose: () => void; onSubmitted: (id: string) => void }) {
  const store = useStore();
  const [step, setStep] = useState(0);
  const [cargo, setCargo] = useState<CargoType | "">("");
  const [liquid, setLiquid] = useState({ ullage: "", observedVol: "", temp: "", blQty: "", surveyorTonnage: "", jettyType: "", jettyCategory: "", jettyName: "" });
  const [dry, setDry] = useState({ displBefore: "", displAfter: "", deductibles: "", constant: "0" });
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const [doneInspId, setDoneInspId] = useState<string | null>(null);
  const numRef = useRef<HTMLDivElement>(null);

  const m = cargo === "Liquid" ? liquid : dry;
  const tonnage = useMemo(() => reconcile(cargo, m), [cargo, liquid, dry]);
  const previewRate = rateForInspection(
    { cargoType: cargo as CargoType, jetty: { type: liquid.jettyType, category: liquid.jettyType === "Local" ? liquid.jettyCategory : null } },
    settings,
  );
  const jettyOk = cargo !== "Liquid" || liquid.jettyType === "International" || (liquid.jettyType === "Local" && !!liquid.jettyCategory);

  useEffect(() => {
    const el = numRef.current;
    if (!el) return;
    el.classList.remove("rb-flash");
    void el.offsetWidth;
    el.classList.add("rb-flash");
  }, [tonnage]);

  if (!call) {
    // The call disappeared mid-capture (cancelled / data reset) — give the
    // surveyor a way out instead of a blank frame.
    return (
      <div className="mob-app">
        <div className="mob-body">
          <div className="empty-tab" style={{ paddingTop: 80 }}>
            <div className="ei"><Icon name="info" size={26} /></div>
            <h3>Vessel call unavailable</h3>
            <p>This vessel call is no longer on the platform. Any unsent measurements were discarded.</p>
          </div>
        </div>
        <div className="mob-cta"><button className="mbtn mbtn-primary" onClick={onClose}>Back to tasks</button></div>
      </div>
    );
  }

  const preview = calcPreview(call.nrt, previewRate, settings);

  const submit = async () => {
    setSubmitting(true);
    try {
      const { invoice } = await store.addInspection({
        callId: call.id,
        cargoType: cargo,
        reconciledTonnage: tonnage,
        status: "completed",
        liquid: cargo === "Liquid" ? liquid : undefined,
        dry: cargo === "Dry" ? dry : undefined,
        jetty: cargo === "Liquid"
          ? { type: liquid.jettyType, category: liquid.jettyType === "Local" ? liquid.jettyCategory : null, name: (liquid.jettyName || "").trim() }
          : null,
      });
      const inspId = invoice?.inspectionId || null;
      if (inspId) onSubmitted(inspId);
      setDoneInspId(inspId);
      setDone(true);
    } catch (e: any) {
      store.toast(e?.message || "Could not submit the inspection", "error");
    } finally {
      setSubmitting(false);
    }
  };

  if (done) {
    // The store has re-rendered with the freshly-created inspection; find it
    // by id (from its invoice) or fall back to the newest completed capture.
    const insp: Inspection | undefined =
      store.inspections.find((i) => i.id === doneInspId) ||
      store.inspectionsForCall(call.id).find((i) => i.status === "completed");
    return (
      <div className="mob-app"><div className="mob-body"><div className="cap-success">
        <div className="sc"><Icon name="check" size={42} strokeWidth={2.4} /></div>
        <h2>Inspection captured</h2>
        <p>{insp?.reference} saved for {call.vesselName}. Uploading to the platform…</p>
        <div className="sc-result">
          <div className="rev-row"><span className="rk">Reconciled tonnage</span><span className="rv">{fmtTons(insp ? insp.reconciledTonnage : tonnage)}</span></div>
          <div className="rev-row"><span className="rk">NPA harbour dues</span><span className="rv">{fmtUSD(preview.dues)}</span></div>
          <div className="rev-row"><span className="rk">Commission · {settings.commissionRate}%</span><span className="rv">{fmtUSD(preview.commissionUsd)}</span></div>
          <div className="rev-row"><span className="rk">Sync status</span><span className="rv"><span className="sync-chip pending"><span className="cdot" />Uploading</span></span></div>
        </div>
      </div></div>
        <div className="mob-cta"><button className="mbtn mbtn-primary" onClick={onClose}>Done</button></div>
      </div>
    );
  }

  const StepWrap = (children: ReactNode, footer: ReactNode) => (
    <div className="mob-app">
      <div className="cap-head">
        <button className="cap-back" onClick={() => (step === 0 ? onClose() : setStep(step - 1))}><Icon name={step === 0 ? "x" : "chevronLeft"} size={20} /></button>
        <div className="cap-title">New inspection<span className="cs">{["Vessel & cargo", "Measurement", "Review & submit"][step]}</span></div>
      </div>
      <div className="cap-progress">{[0, 1, 2].map((i) => <div key={i} className={"seg " + (i <= step ? "on" : "")} />)}</div>
      <div className="mob-body">{children}</div>
      {footer}
    </div>
  );

  // Step 0 — vessel + cargo
  if (step === 0) {
    return StepWrap(
      <>
        <div className="cap-vessel">
          <div className="cv-ic"><Icon name="ship" size={22} /></div>
          <div><div className="cv-name">{call.vesselName}</div><div className="cv-ref">{call.reference} · {call.type}</div></div>
        </div>
        <div className="cap-label">Cargo category</div>
        <div className="cargo-pick">
          <button className={"cargo-opt " + (cargo === "Liquid" ? "on" : "")} onClick={() => setCargo("Liquid")}>
            <div className="co-ic"><Icon name="droplet" size={24} strokeWidth={1.8} /></div>
            <div><div className="co-t">Liquid cargo</div><div className="co-d">PMS, AGO, DPK — ullage survey</div></div>
            <div className="co-check">{cargo === "Liquid" && <Icon name="check" size={15} strokeWidth={3} />}</div>
          </button>
          <button className={"cargo-opt " + (cargo === "Dry" ? "on" : "")} onClick={() => setCargo("Dry")}>
            <div className="co-ic"><Icon name="package" size={24} strokeWidth={1.8} /></div>
            <div><div className="co-t">Dry / bulk cargo</div><div className="co-d">Grain, fertiliser — draft survey</div></div>
            <div className="co-check">{cargo === "Dry" && <Icon name="check" size={15} strokeWidth={3} />}</div>
          </button>
        </div>
      </>,
      <div className="mob-cta"><button className="mbtn mbtn-primary" disabled={!cargo} onClick={() => setStep(1)}>Continue</button></div>,
    );
  }

  // Step 1 — measurement + running tonnage
  if (step === 1) {
    return StepWrap(
      <div className="mfields">
        {cargo === "Liquid" ? (
          <>
            <div className="mfield-row">
              <div className="mfield"><label>Ullage <span className="opt">(m)</span></label><input type="number" inputMode="decimal" value={liquid.ullage} placeholder="0.00" onChange={(e) => setLiquid({ ...liquid, ullage: e.target.value })} /></div>
              <div className="mfield"><label>Temp <span className="opt">(°C)</span></label><input type="number" inputMode="decimal" value={liquid.temp} placeholder="15.0" onChange={(e) => setLiquid({ ...liquid, temp: e.target.value })} /></div>
            </div>
            <div className="mfield"><label>Observed volume <span className="opt">(m³)</span></label><input type="number" inputMode="decimal" value={liquid.observedVol} placeholder="0.0" onChange={(e) => setLiquid({ ...liquid, observedVol: e.target.value })} /></div>
            <div className="mfield"><label>Reconciled surveyor's tonnage <span className="opt">(MT)</span></label><input type="number" inputMode="decimal" value={liquid.surveyorTonnage} placeholder="0.00" onChange={(e) => setLiquid({ ...liquid, surveyorTonnage: e.target.value })} /></div>
            <div className="mfield"><label>Jetty type</label><select value={liquid.jettyType} onChange={(e) => setLiquid({ ...liquid, jettyType: e.target.value, jettyCategory: e.target.value === "Local" ? liquid.jettyCategory : "" })}><option value="">Select…</option><option value="Local">Local Jetty</option><option value="International">International Jetty</option></select></div>
            {liquid.jettyType === "Local" && (
              <div className="mfield"><label>Jetty category</label><select value={liquid.jettyCategory} onChange={(e) => setLiquid({ ...liquid, jettyCategory: e.target.value })}><option value="">Select…</option><option value="Government">Government Jetty</option><option value="Private">Private Jetty</option></select></div>
            )}
            <div className="mfield"><label>Jetty name</label><input type="text" value={liquid.jettyName} placeholder="e.g. UNICEM Jetty" onChange={(e) => setLiquid({ ...liquid, jettyName: e.target.value })} /></div>
            <div className="mfield"><label>Bill of Lading qty <span className="opt">(MT)</span></label><input type="number" inputMode="decimal" value={liquid.blQty} placeholder="0.00" onChange={(e) => setLiquid({ ...liquid, blQty: e.target.value })} /></div>
          </>
        ) : (
          <>
            <div className="mfield"><label>Displacement before <span className="opt">(MT)</span></label><input type="number" inputMode="decimal" value={dry.displBefore} placeholder="0" onChange={(e) => setDry({ ...dry, displBefore: e.target.value })} /></div>
            <div className="mfield"><label>Displacement after <span className="opt">(MT)</span></label><input type="number" inputMode="decimal" value={dry.displAfter} placeholder="0" onChange={(e) => setDry({ ...dry, displAfter: e.target.value })} /></div>
            <div className="mfield-row">
              <div className="mfield"><label>Deductibles <span className="opt">(MT)</span></label><input type="number" inputMode="decimal" value={dry.deductibles} placeholder="0" onChange={(e) => setDry({ ...dry, deductibles: e.target.value })} /></div>
              <div className="mfield"><label>Constant <span className="opt">(MT)</span></label><input type="number" inputMode="decimal" value={dry.constant} onChange={(e) => setDry({ ...dry, constant: e.target.value })} /></div>
            </div>
          </>
        )}
      </div>,
      <>
        <div className="running-bar">
          <div className="rb-top">
            <span className="rb-l"><Icon name="gauge" size={14} strokeWidth={2} /> Reconciled tonnage</span>
          </div>
          <div className="rb-n tnum" ref={numRef}>{fmtNum(tonnage, 2)}<span className="u">MTS</span></div>
          <div className="rb-foot">{cargo === "Liquid" ? (liquid.blQty ? `Variance vs B/L: ${(tonnage - Number(liquid.blQty)).toFixed(2)} MT` : "Enter the surveyor's reconciled tonnage") : "Before − after − deductibles + constant"}</div>
        </div>
        <div className="mob-cta"><button className="mbtn mbtn-primary" disabled={tonnage <= 0 || !jettyOk} onClick={() => setStep(2)}>Review</button></div>
      </>,
    );
  }

  // Step 2 — review + photos + submit
  return StepWrap(
    <>
      <div className="rev-card">
        <div className="rev-row"><span className="rk">Vessel</span><span className="rv">{call.vesselName}</span></div>
        <div className="rev-row"><span className="rk">Rotation</span><span className="rv">{call.reference}</span></div>
        <div className="rev-row"><span className="rk">Cargo</span><span className="rv"><MTag type={cargo} /></span></div>
        {cargo === "Liquid" && <div className="rev-row"><span className="rk">Jetty</span><span className="rv">{liquid.jettyType === "International" ? "International" : `${liquid.jettyCategory} · Local`}</span></div>}
        <div className="rev-row"><span className="rk">Reconciled tonnage</span><span className="rv">{fmtTons(tonnage)}</span></div>
      </div>

      <div className="charge-preview">
        <div className="cp-label"><Icon name="gauge" size={14} strokeWidth={2} /> Charges preview</div>
        <div className="cp-row"><span className="l">NPA harbour dues</span><span className="v">{fmtUSD(preview.dues)}</span></div>
        <div className="cp-row"><span className="l">Commission · {settings.commissionRate}%</span><span className="v">{fmtUSD(preview.commissionUsd)}</span></div>
        <div className="cp-row"><span className="l">&nbsp;</span><span className="v" style={{ color: "var(--slate)", fontWeight: 500 }}>{fmtNGN(preview.commissionNgn)}</span></div>
      </div>

      <div className="photo-label"><span className="pl">Evidence photos</span><span style={{ fontSize: 12, color: "var(--soft)" }}>optional</span></div>
      <div className="photo-grid">
        {createElement("image-slot", { id: "cap-photo-1", shape: "rounded", radius: "12", placeholder: "Ullage / draft" })}
        {createElement("image-slot", { id: "cap-photo-2", shape: "rounded", radius: "12", placeholder: "Cargo / seal" })}
      </div>
      <div style={{ height: 12 }} />
    </>,
    <div className="mob-cta">
      <button className="mbtn mbtn-primary" disabled={submitting} onClick={submit}>
        {submitting ? <><Icon name="spinner" size={18} className="spin" strokeWidth={2} /> Submitting…</> : "Submit inspection"}
      </button>
      <button className="mbtn mbtn-ghost" disabled={submitting} onClick={onClose}>Save as draft</button>
    </div>,
  );
}

// =========================================================
// Captured
// =========================================================
function CapturedTab({ captured, calls }:
  { captured: (Inspection & { synced: boolean })[]; calls: VesselCall[] }) {
  return (
    <>
      <div className="mob-head"><div className="eyebrow">Recent</div><h1>Captured</h1></div>
      <div className="mob-section">
        {captured.map((i) => {
          return (
            <div className="task-card" key={i.id} style={{ cursor: "default" }}>
              <div className="tc-top">
                <div><div className="tc-name">{i.vesselName}</div><div className="tc-ref">{i.reference}</div></div>
                <MBadge status={i.synced ? "synced" : "draft"} />
              </div>
              <div className="tc-meta">
                <MTag type={i.cargoType} />
                <span className="mi tnum">{fmtTons(i.reconciledTonnage)}</span>
                <span className="mi tnum" style={{ marginLeft: "auto" }}>{fmtDate(i.date)}</span>
              </div>
            </div>
          );
        })}
        {captured.length === 0 && <div className="empty-tab"><div className="ei"><Icon name="clipboard" size={26} /></div><h3>Nothing captured yet</h3><p>Submitted inspections appear here.</p></div>}
      </div>
    </>
  );
}

// =========================================================
// Account
// =========================================================
function AccountTab({ pendingSync, port }: { pendingSync: number; port: string }) {
  const { user, logout } = useAuth();
  return (
    <>
      <div className="mob-head"><h1>Account</h1></div>
      <div className="acct-profile">
        <div className="ap-av">{userInitials(user?.name || "")}</div>
        <div><div className="ap-name">{user?.name}</div><div className="ap-role">{user?.role} · {port}</div></div>
      </div>
      <div className="acct-list">
        <div className="acct-row"><div className="ar-ic"><Icon name="anchor" size={17} strokeWidth={2} /></div> Port<span className="ar-detail">{port}</span></div>
        <div className="acct-row"><div className="ar-ic"><Icon name="download" size={17} strokeWidth={2} /></div> Pending sync<span className="ar-detail">{pendingSync} item{pendingSync === 1 ? "" : "s"}</span></div>
        <div className="acct-row"><div className="ar-ic"><Icon name="gauge" size={17} strokeWidth={2} /></div> Units<span className="ar-detail">Metric (MT)</span></div>
      </div>
      <div className="acct-list">
        <div className="acct-row"><div className="ar-ic"><Icon name="settings" size={17} strokeWidth={2} /></div> Capture settings<Icon name="chevronRight" size={16} style={{ marginLeft: "auto", color: "var(--soft)" }} /></div>
        <div className="acct-row"><div className="ar-ic"><Icon name="info" size={17} strokeWidth={2} /></div> Help &amp; offline guide<Icon name="chevronRight" size={16} style={{ marginLeft: "auto", color: "var(--soft)" }} /></div>
      </div>
      <div className="mob-cta"><button className="mbtn mbtn-secondary" style={{ color: "var(--danger)" }} onClick={logout}><Icon name="logout" size={18} /> Sign out</button></div>
    </>
  );
}

// =========================================================
// Tab bar
// =========================================================
function TabBar({ tab, setTab }: { tab: string; setTab: (t: "tasks" | "captured" | "account") => void }) {
  const tabs: [("tasks" | "captured" | "account"), string, string][] = [["tasks", "Tasks", "clipboard"], ["captured", "Captured", "check"], ["account", "Account", "settings"]];
  return (
    <div className="tabbar">
      {tabs.map(([k, l, ic]) => (
        <button key={k} className={tab === k ? "on" : ""} onClick={() => setTab(k)}>
          <Icon name={ic} size={23} strokeWidth={tab === k ? 2.1 : 1.8} />{l}
        </button>
      ))}
    </div>
  );
}

// =========================================================
// Minimal inlined iOS device frame (ported from mobile/ios-frame.jsx)
// =========================================================
function IOSStatusBar({ time = "9:41" }: { time?: string }) {
  const c = "#000";
  return (
    <div style={{ display: "flex", gap: 154, alignItems: "center", justifyContent: "center", padding: "21px 24px 19px", boxSizing: "border-box", position: "relative", zIndex: 20, width: "100%" }}>
      <div style={{ flex: 1, height: 22, display: "flex", alignItems: "center", justifyContent: "center", paddingTop: 1.5 }}>
        <span style={{ fontFamily: '-apple-system, "SF Pro", system-ui', fontWeight: 590, fontSize: 17, lineHeight: "22px", color: c }}>{time}</span>
      </div>
      <div style={{ flex: 1, height: 22, display: "flex", alignItems: "center", justifyContent: "center", gap: 7, paddingTop: 1, paddingRight: 1 }}>
        <svg width="19" height="12" viewBox="0 0 19 12">
          <rect x="0" y="7.5" width="3.2" height="4.5" rx="0.7" fill={c} />
          <rect x="4.8" y="5" width="3.2" height="7" rx="0.7" fill={c} />
          <rect x="9.6" y="2.5" width="3.2" height="9.5" rx="0.7" fill={c} />
          <rect x="14.4" y="0" width="3.2" height="12" rx="0.7" fill={c} />
        </svg>
        <svg width="17" height="12" viewBox="0 0 17 12">
          <path d="M8.5 3.2C10.8 3.2 12.9 4.1 14.4 5.6L15.5 4.5C13.7 2.7 11.2 1.5 8.5 1.5C5.8 1.5 3.3 2.7 1.5 4.5L2.6 5.6C4.1 4.1 6.2 3.2 8.5 3.2Z" fill={c} />
          <path d="M8.5 6.8C9.9 6.8 11.1 7.3 12 8.2L13.1 7.1C11.8 5.9 10.2 5.1 8.5 5.1C6.8 5.1 5.2 5.9 3.9 7.1L5 8.2C5.9 7.3 7.1 6.8 8.5 6.8Z" fill={c} />
          <circle cx="8.5" cy="10.5" r="1.5" fill={c} />
        </svg>
        <svg width="27" height="13" viewBox="0 0 27 13">
          <rect x="0.5" y="0.5" width="23" height="12" rx="3.5" stroke={c} strokeOpacity="0.35" fill="none" />
          <rect x="2" y="2" width="20" height="9" rx="2" fill={c} />
          <path d="M25 4.5V8.5C25.8 8.2 26.5 7.2 26.5 6.5C26.5 5.8 25.8 4.8 25 4.5Z" fill={c} fillOpacity="0.4" />
        </svg>
      </div>
    </div>
  );
}

function IOSFrame({ children, width = 402, height = 874 }: { children: ReactNode; width?: number; height?: number }) {
  return (
    <div style={{
      width, height, borderRadius: 48, overflow: "hidden", position: "relative", background: "#F2F2F7",
      boxShadow: "0 40px 80px rgba(0,0,0,0.18), 0 0 0 1px rgba(0,0,0,0.12)",
      fontFamily: "-apple-system, system-ui, sans-serif", WebkitFontSmoothing: "antialiased",
    }}>
      {/* dynamic island */}
      <div style={{ position: "absolute", top: 11, left: "50%", transform: "translateX(-50%)", width: 126, height: 37, borderRadius: 24, background: "#000", zIndex: 50 }} />
      {/* status bar (absolute) */}
      <div style={{ position: "absolute", top: 0, left: 0, right: 0, zIndex: 10 }}>
        <IOSStatusBar />
      </div>
      {/* content */}
      <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
        <div style={{ flex: 1, overflow: "auto" }}>{children}</div>
      </div>
      {/* home indicator — always on top */}
      <div style={{ position: "absolute", bottom: 0, left: 0, right: 0, zIndex: 60, height: 34, display: "flex", justifyContent: "center", alignItems: "flex-end", paddingBottom: 8, pointerEvents: "none" }}>
        <div style={{ width: 139, height: 5, borderRadius: 100, background: "rgba(0,0,0,0.25)" }} />
      </div>
    </div>
  );
}

export default MobileApp;
