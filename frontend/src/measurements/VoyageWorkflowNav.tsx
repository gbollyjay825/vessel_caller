import { Link } from "../lib/navigation";
import "../styles/voyage-workflow.css";

export function VoyageWorkflowNav({ callId, active }: { callId: string; active: "readings" | "reconciliation" | "variation-invoice" }) {
  const steps = [{ id: "readings", label: "Readings" }, { id: "reconciliation", label: "Reconciliation" }, { id: "variation-invoice", label: "Invoice" }] as const;
  return <nav className="voyage-workflow-nav" aria-label="Voyage workflow">{steps.map((step, index) => <Link key={step.id} className={active === step.id ? "active" : ""} aria-current={active === step.id ? "step" : undefined} to={`/app/measurements/voyages/${encodeURIComponent(callId)}/${step.id}`}><span>{index + 1}</span>{step.label}</Link>)}</nav>;
}
