// Voyages list: one row per voyage, its current step and the one action that moves it on.
import { useState } from "react";
import { Link } from "../lib/navigation";
import type { VesselCall } from "../types";
import { dateLabel } from "./helpers";
import type { MeasurementPlan } from "./types";
import type { CloseoutRecord } from "./closeoutPreview";
import { STAGE_LABELS, STAGE_TONES, declarationTotals, nextStepPath, summarizeVoyages, type VoyageStage, type VoyageSummary } from "./voyageStatus";
import { vesselPath, vesselSlug } from "./voyages";
import "../styles/voyage-workspace.css";
import "../styles/voyage-log.css";

const FILTER_STAGES: Record<string, VoyageStage[]> = {
  declaration: ["declaration"], collecting: ["collecting"], reconcile: ["ready", "returned"], approval: ["approval"],
  invoice: ["invoice", "draft", "held"], review: ["review"], cancelled: ["cancelled"],
};
const CLOSED: VoyageStage[] = ["no-charge", "cancelled"];

function actionFor(voyage: VoyageSummary, canManage: boolean): string {
  switch (voyage.stage) {
    case "declaration": return voyage.plans.length ? "Review declaration" : canManage ? "Record declaration" : "Open";
    case "collecting": return "Agency readings";
    case "ready": case "returned": return "Reconcile";
    case "approval": return "Review approval";
    case "invoice": case "draft": case "held": case "review": return "Invoice";
    default: return "Open";
  }
}

export function VoyageLog({ calls, plans, canManage, closeoutRecords = [], search = "", status = "all" }: {
  calls: VesselCall[];
  plans: MeasurementPlan[];
  canManage: boolean;
  closeoutRecords?: CloseoutRecord[];
  search?: string;
  status?: string;
}) {
  const [vesselKey, setVesselKey] = useState("");
  const voyages = summarizeVoyages(calls, plans, closeoutRecords)
    .sort((left, right) => (Date.parse(right.arrival) || 0) - (Date.parse(left.arrival) || 0) || left.vesselName.localeCompare(right.vesselName) || left.reference.localeCompare(right.reference));
  const slugOf = (voyage: VoyageSummary) => vesselSlug(voyage.vesselName, voyage.call?.flag ?? "");
  const vessels = [...new Map(voyages.map(voyage => [slugOf(voyage), `${voyage.vesselName}${voyage.call?.flag ? ` · ${voyage.call.flag}` : ""}`])).entries()].sort((left, right) => left[1].localeCompare(right[1]));
  const query = search.trim().toLocaleLowerCase();
  const visible = voyages.filter(voyage => (!vesselKey || slugOf(voyage) === vesselKey)
    && (status === "all" || (status === "open" ? !CLOSED.includes(voyage.stage) : (FILTER_STAGES[status] ?? []).includes(voyage.stage)))
    && (!query || [voyage.vesselName, voyage.reference, ...voyage.allPlans.flatMap(plan => [plan.title, ...plan.participants.map(party => party.name)])].join(" ").toLocaleLowerCase().includes(query)));

  return <div className="voyage-log">
    <div className="voyage-log-head"><p>{visible.length} {visible.length === 1 ? "voyage" : "voyages"}</p><label className="measurement-filter">Vessel <select aria-label="Filter voyages by vessel" value={vesselKey} onChange={event => setVesselKey(event.target.value)}><option value="">All vessels</option>{vessels.map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label></div>
    {visible.length ? <div className="voyage-card voyage-list-scroll" role="region" aria-label="Voyages table" tabIndex={0}><table className="voyage-list-table">
      <caption className="hide-sr">Voyages, their declaration, agency readings and current step</caption>
      <thead><tr><th scope="col">Vessel</th><th scope="col">Voyage</th><th scope="col">Declared</th><th scope="col">Agency readings</th><th scope="col">Step</th><th scope="col"><span className="hide-sr">Next action</span></th></tr></thead>
      <tbody>{visible.map(voyage => {
        const declared = declarationTotals(voyage.plans.flatMap(plan => plan.lines));
        return <tr key={voyage.callId} aria-label={`${voyage.vesselName} · ${voyage.reference}`}>
          <th scope="row"><Link to={vesselPath(voyage.vesselName, voyage.call?.flag ?? "")}>{voyage.vesselName}</Link>{voyage.call?.flag && <small>{voyage.call.flag}</small>}</th>
          <td><strong>{voyage.reference}</strong>{voyage.arrival && <small>Arrival {dateLabel(voyage.arrival)}</small>}</td>
          <td>{declared || <span className="voyage-log-muted">{voyage.plans.length ? "Quantities missing" : "Not recorded"}</span>}{voyage.declaration?.paymentStatus === "paid" && <small>Paid</small>}</td>
          <td>{voyage.expected ? `${voyage.received} of ${voyage.expected}` : <span className="voyage-log-muted">—</span>}</td>
          <td><span className={`stage-chip ${STAGE_TONES[voyage.stage]}`}>{STAGE_LABELS[voyage.stage]}</span></td>
          <td><Link className="btn btn-secondary btn-sm" to={nextStepPath(voyage, canManage)} aria-label={`${actionFor(voyage, canManage)} · ${voyage.vesselName} ${voyage.reference}`}>{actionFor(voyage, canManage)}</Link></td>
        </tr>;
      })}</tbody>
    </table></div> : <div className="voyage-card voyage-card-pad voyage-empty"><h2>No voyages found</h2><p>Change the filters, or register a voyage to begin.</p></div>}
  </div>;
}
