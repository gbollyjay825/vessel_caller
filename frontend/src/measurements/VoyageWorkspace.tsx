// The frame every voyage step shares: who and what the voyage is, the four
// steps with their live status, and the breadcrumb trail back to the vessel.
import { useQuery } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";

import { useBreadcrumbs } from "../app/breadcrumbs";
import { useStore } from "../app/store";
import { useAuth } from "../auth/AuthContext";
import { Icon } from "../components/Icon";
import { Link } from "../lib/navigation";
import { measurementApi } from "./api";
import { useCloseoutPreview } from "./closeoutPreview";
import { dateLabel } from "./helpers";
import { ErrorMessage } from "./shared";
import { summarizeVoyage, voyagePath, voyageSteps, type VoyageStep, type VoyageSummary } from "./voyageStatus";
import { vesselPath } from "./voyages";
import "../styles/measurements.css";
import "../styles/voyage-workspace.css";

export function useVoyage(callId: string) {
  const { org } = useAuth();
  const store = useStore();
  const records = useQuery({ queryKey: ["measurement-plans", org?.id, callId], queryFn: () => measurementApi.list(callId), refetchInterval: 30_000 });
  const plans = records.data?.plans.filter(plan => plan.callId === callId) ?? [];
  const preview = useCloseoutPreview(org?.id, callId);
  const call = store.calls?.find(item => item.id === callId);
  const summary = summarizeVoyage(callId, call, plans, preview.record);
  return { records, plans, preview, call, summary };
}
export type VoyageData = ReturnType<typeof useVoyage>;

const STEPS: { id: VoyageStep; label: string }[] = [
  { id: "declaration", label: "Declaration" },
  { id: "agencies", label: "Agency readings" },
  { id: "readings", label: "Readings report" },
  { id: "variation-invoice", label: "Variation invoice" },
];

export function VoyageHeader({ summary, actions }: { summary: VoyageSummary; actions?: ReactNode }) {
  const call = summary.call;
  const [now] = useState(() => Date.now());
  const arrived = call?.eta && Date.parse(call.eta) <= now;
  const facts = [call?.type, call?.flag, call?.eta ? `${arrived ? "Arrived" : "ETA"} ${dateLabel(call.eta)}` : "", call?.berth].filter(Boolean);
  return <div className="voyage-header">
    <span className="voyage-header-icon" aria-hidden="true"><Icon name="ship" size={24} /></span>
    <div className="voyage-header-text">
      <p className="voyage-header-eyebrow">Voyage {summary.reference}</p>
      <h1>{summary.vesselName}</h1>
      {facts.length > 0 && <p className="voyage-header-facts">{facts.join(" · ")}</p>}
    </div>
    <div className="voyage-header-actions">
      {actions}
      <Link className="btn btn-secondary" to={vesselPath(summary.vesselName, call?.flag ?? "")}>Vessel history</Link>
    </div>
  </div>;
}

export function VoyageStepper({ summary, active }: { summary: VoyageSummary; active: VoyageStep }) {
  const steps = voyageSteps(summary);
  return <nav className="voyage-stepper" aria-label="Voyage steps"><ol>{STEPS.map((step, index) => {
    const status = steps[step.id];
    const href = step.id === "declaration" && !summary.plans.length && summary.stage !== "cancelled"
      ? `/app/measurements/new?callId=${encodeURIComponent(summary.callId)}` : voyagePath(summary.callId, step.id);
    const current = active === step.id;
    return <li key={step.id}>
      <Link to={href} className={`voyage-step ${status.state}${current ? " active" : ""}`} aria-current={current ? "step" : undefined}>
        <span className="voyage-step-marker" aria-hidden="true">{status.state === "done" ? <Icon name="check" size={14} strokeWidth={3} /> : index + 1}</span>
        <span className="voyage-step-text"><strong>{step.label}</strong><small>{status.label}</small></span>
        {status.state === "done" && <span className="hide-sr"> (complete)</span>}
      </Link>
    </li>;
  })}</ol></nav>;
}

export function useVoyageBreadcrumbs(summary: VoyageSummary) {
  useBreadcrumbs([
    { label: "Voyages", to: "/app/measurements" },
    { label: summary.vesselName, to: vesselPath(summary.vesselName, summary.call?.flag ?? "") },
    { label: summary.reference },
  ]);
}

export function VoyageFrame({ voyage, step, actions, children }: { voyage: VoyageData; step: VoyageStep; actions?: ReactNode; children: ReactNode }) {
  useVoyageBreadcrumbs(voyage.summary);
  const cancelled = voyage.summary.stage === "cancelled";
  return <div className="content-inner measurement-workspace voyage-workspace">
    <VoyageHeader summary={voyage.summary} actions={actions} />
    <VoyageStepper summary={voyage.summary} active={step} />
    {cancelled && <p role="status" className="measurement-notice warning voyage-no-print">This voyage is cancelled. Its records stay available for reference; new readings, approvals and invoices are disabled.</p>}
    <ErrorMessage error={voyage.records.error} />
    {voyage.records.isPending ? <div className="measurement-loading" role="status">Loading voyage…</div> : voyage.records.error ? null : children}
  </div>;
}
