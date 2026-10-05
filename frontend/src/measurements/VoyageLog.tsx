import { useState } from "react";
import { Icon } from "../components/Icon";
import { Link } from "../lib/navigation";
import type { VesselCall } from "../types";
import { dateLabel, latestReconciliation, latestReturns } from "./helpers";
import type { MeasurementPlan } from "./types";
import { groupVesselCalls } from "./voyages";
import "../styles/voyage-log.css";

type VoyageRow = { id: string; vesselName: string; reference: string; arrival: string; vesselKey: string; vesselLabel: string; call?: VesselCall; plans: MeasurementPlan[] };
export type VoyageReadingFilter = "all" | "awaiting" | "complete" | "cancelled" | "active" | "reconciled";

export function VoyageLog({ calls, plans, canManage, search = "", status = "all" }: {
  calls: VesselCall[];
  plans: MeasurementPlan[];
  canManage: boolean;
  search?: string;
  status?: string;
}) {
  const [vesselKey, setVesselKey] = useState("");
  const byCall = new Map<string, VoyageRow>();
  for (const vessel of groupVesselCalls(calls)) for (const call of vessel.calls) {
    byCall.set(call.id, { id: call.id, vesselName: call.vesselName, reference: call.reference, arrival: call.eta, vesselKey: vessel.key, vesselLabel: `${vessel.name}${vessel.flag ? ` · ${vessel.flag}` : ""}`, call, plans: [] });
  }
  for (const plan of plans) {
    let row = byCall.get(plan.callId);
    if (!row) {
      row = { id: plan.callId, vesselName: plan.vesselName, reference: plan.callReference, arrival: "", vesselKey: `recorded:${plan.vesselName.trim().toLocaleLowerCase()}`, vesselLabel: `${plan.vesselName} · recorded voyage`, plans: [] };
      byCall.set(plan.callId, row);
    }
    row.plans.push(plan);
  }
  const rows = [...byCall.values()].map(row => {
    const cancelled = row.call?.status === "cancelled";
    const currentPlans = cancelled ? row.plans : row.plans.filter(plan => plan.status !== "cancelled");
    const expected = currentPlans.reduce((count, plan) => count + plan.participants.length, 0);
    const received = currentPlans.reduce((count, plan) => {
      const returns = latestReturns(plan);
      return count + plan.participants.filter(party => returns.has(party.id)).length;
    }, 0);
    const lines = currentPlans.flatMap(plan => plan.lines);
    const known = lines.filter(line => line.manifestQuantity !== null && line.manifestQuantity.trim() !== "").length;
    const hasCurrentDeclaration = currentPlans.length > 0;
    const declaration = !hasCurrentDeclaration ? "Not started" : known === 0 ? "Not provided" : known < lines.length ? "Partial" : "Recorded";
    const complete = expected > 0 && received === expected;
    return { ...row, expected, received, declaration, hasCurrentDeclaration, cancelled, complete };
  }).sort((left, right) => (Date.parse(right.arrival) || 0) - (Date.parse(left.arrival) || 0) || left.vesselName.localeCompare(right.vesselName) || left.reference.localeCompare(right.reference) || left.id.localeCompare(right.id));
  const vessels = [...new Map(rows.map(row => [row.vesselKey, row.vesselLabel])).entries()].sort((left, right) => left[1].localeCompare(right[1]));
  const filter = status === "active" ? "awaiting" : status === "reconciled" ? "complete" : status;
  const query = search.trim().toLocaleLowerCase();
  const visible = rows.filter(row => (!vesselKey || row.vesselKey === vesselKey)
    && (!query || [row.vesselName, row.reference, ...row.plans.map(plan => plan.title)].join(" ").toLocaleLowerCase().includes(query))
    && (filter === "all" || (filter === "cancelled" ? row.cancelled : !row.cancelled && (filter === "complete" ? row.complete : !row.complete))));

  return <div className="voyage-log">
    <div className="voyage-log-head"><p>One row per voyage. Open Readings to compare the owner declaration and agency figures.</p><label className="measurement-filter">Vessel <select aria-label="Filter voyage log by vessel" value={vesselKey} onChange={event => setVesselKey(event.target.value)}><option value="">All vessels</option>{vessels.map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label></div>
    {visible.length ? <><div className="voyage-list-scroll" role="region" aria-label="Voyages table" tabIndex={0}><table className="voyage-list-table"><caption className="voyage-sr-only">Voyages and agency readings</caption><thead><tr><th scope="col">Vessel</th><th scope="col">Voyage</th><th scope="col">Owner declaration</th><th scope="col">Agency readings</th><th scope="col">Actions</th></tr></thead><tbody>{visible.map(row => {
      const reportPath = `/app/measurements/voyages/${encodeURIComponent(row.id)}/readings`;
      const active = row.plans.filter(plan => plan.status !== "cancelled" && !(latestReconciliation(plan, "final") && !latestReconciliation(plan, "draft")));
      const hasDeclaration = row.plans.some(plan => plan.status !== "cancelled");
      return <tr key={row.id} aria-label={`${row.vesselName} · ${row.reference}`}>
        <th scope="row">{row.vesselName}{row.call?.flag && <small>{row.call.flag}</small>}</th>
        <td><strong>{row.reference}</strong>{row.arrival && <small>Arrival {dateLabel(row.arrival)}</small>}{row.cancelled && <small className="voyage-state cancelled">Cancelled</small>}</td>
        <td>{row.declaration}</td>
        <td><strong>{row.expected ? `${row.received} of ${row.expected} received` : "—"}</strong>{!row.cancelled && row.complete && <small className="voyage-state complete">Complete</small>}{row.expected === 0 && <small>{row.hasCurrentDeclaration ? "No readings yet" : "Awaiting declaration"}</small>}</td>
        <td><div className="voyage-row-actions"><Link className="btn btn-primary" to={reportPath}>Readings <Icon name="chevronRight" size={14} /></Link>{canManage && !row.cancelled && (active.length === 1 ? <Link className="link-btn" to={`/app/measurements/${encodeURIComponent(active[0].id)}`}>Record readings</Link> : active.length > 1 ? null : !hasDeclaration ? <Link className="link-btn" to={`/app/measurements/new?callId=${encodeURIComponent(row.id)}`}>Start declaration</Link> : null)}</div></td>
      </tr>;
    })}</tbody></table></div><p className="voyage-log-note">Received means an agency has submitted a reading.</p></> : <div className="voyage-empty"><h2>No voyages found</h2><p>Change the filters or register a voyage to begin.</p><Link className="link-btn" to="/app/vessel-calls">View vessel calls</Link></div>}
  </div>;
}
