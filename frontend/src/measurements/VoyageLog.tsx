import { useState } from "react";
import { Icon } from "../components/Icon";
import { Link } from "../lib/navigation";
import type { VesselCall } from "../types";
import { readingQuantity, tallyResult } from "./comparison";
import { UNIT_LABELS } from "./cargoTemplates";
import { dateLabel, latestReconciliation, latestReturns } from "./helpers";
import { MeasurementBadge } from "./shared";
import type { MeasurementPlan } from "./types";
import { groupVesselCalls } from "./voyages";
import "../styles/voyage-log.css";

export function VoyageLog({ calls, plans, canManage, search = "", status = "all" }: {
  calls: VesselCall[];
  plans: MeasurementPlan[];
  canManage: boolean;
  search?: string;
  status?: string;
}) {
  const [vesselKey, setVesselKey] = useState("");
  const groups = groupVesselCalls(calls);
  const matchesPlan = (plan: MeasurementPlan) => status === "all" || (status === "active" ? ["scheduled", "in-progress"].includes(plan.status) : plan.status === status);
  const matchesSearch = (values: string[]) => values.join(" ").toLocaleLowerCase().includes(search.toLocaleLowerCase());
  const matchesCall = (call: VesselCall) => {
    const records = plans.filter(plan => plan.callId === call.id);
    return (status === "all" || records.some(matchesPlan)) && matchesSearch([call.vesselName, call.reference, ...records.map(plan => plan.title)]);
  };
  const visible = groups.filter(group => !vesselKey || group.key === vesselKey).map(group => ({ ...group, calls: group.calls.filter(matchesCall) })).filter(group => group.calls.length);
  const callIds = new Set(calls.map(call => call.id));
  const unmatched = plans.filter(plan => !callIds.has(plan.callId) && !vesselKey && matchesPlan(plan) && matchesSearch([plan.vesselName, plan.callReference, plan.title]));
  return <div className="voyage-log">
    <div className="voyage-log-head"><div><h2>Voyage log</h2><p>One vessel, separate voyages. Each voyage keeps its own declaration, agency readings and final tally.</p></div><label className="measurement-filter">Vessel <select aria-label="Filter voyage log by vessel" value={vesselKey} onChange={event => setVesselKey(event.target.value)}><option value="">All vessels</option>{groups.map(group => <option key={group.key} value={group.key}>{group.name}{group.flag ? ` · ${group.flag}` : ""}</option>)}</select></label></div>
    {visible.map(group => <section className="card voyage-vessel" key={group.key} aria-label={`Voyages for ${group.name}${group.flag ? ` · ${group.flag}` : ""}`}>
      <div className="voyage-vessel-head"><div className="voyage-vessel-icon"><Icon name="ship" size={22} /></div><div><h3>{group.name}</h3><p>{[group.type, group.flag].filter(Boolean).join(" · ") || "Vessel"}</p></div><span>{group.calls.length} recorded {group.calls.length === 1 ? "voyage" : "voyages"}</span></div>
      {group.calls.map(call => {
        const records = plans.filter(plan => plan.callId === call.id && matchesPlan(plan));
        return <div className="voyage-record" key={call.id}>
          <div className="voyage-record-head"><div><Link to={`/app/vessel-calls/${call.id}`} className="voyage-reference">{call.reference}</Link><p><span>Arrival {dateLabel(call.eta)}</span><span>{call.berth || "Berth not recorded"}</span></p></div><MeasurementBadge status={call.status} /></div>
          {records.length ? records.map(plan => <VoyageTally key={plan.id} plan={plan} />) : <div className="voyage-not-started"><span>Owner declaration not started for this voyage.</span>{canManage && call.status !== "cancelled" && <Link className="btn btn-secondary" to={`/app/measurements/new?callId=${encodeURIComponent(call.id)}`}>Start declaration <Icon name="chevronRight" size={14} /></Link>}</div>}
        </div>;
      })}
    </section>)}
    {unmatched.length > 0 && <section className="card voyage-vessel"><div className="voyage-vessel-head"><div><h3>Other recorded voyages</h3><p>These records retain their voyage reference; vessel details are not currently loaded.</p></div></div>{unmatched.map(plan => <div className="voyage-record" key={plan.id}><div className="voyage-record-head"><strong>{plan.vesselName} · {plan.callReference}</strong></div><VoyageTally plan={plan} /></div>)}</section>}
    {!visible.length && !unmatched.length && <div className="card voyage-empty"><Icon name="ship" size={28} /><h3>No voyages found</h3><p>Change your filters, or register a vessel call to start its voyage record.</p><Link className="btn btn-secondary" to="/app/vessel-calls">View vessel calls</Link></div>}
  </div>;
}

function VoyageTally({ plan }: { plan: MeasurementPlan }) {
  const final = latestReconciliation(plan, "final");
  const draft = latestReconciliation(plan, "draft");
  const returns = latestReturns(plan);
  const allReceived = returns.size > 0 && plan.participants.filter(party => party.requiredSubmission).every(party => returns.has(party.id));
  return <div className="voyage-tally">
    <div className="voyage-tally-title"><Link to={`/app/measurements/${plan.id}`}>{plan.title}</Link><MeasurementBadge status={plan.status} /></div>
    <div className="voyage-tally-status"><span><Icon name="users" size={14} />{returns.size} / {plan.participants.length} agency readings</span><span>{draft ? "NPA review in progress" : final ? "Final tally recorded" : allReceived ? "Ready for NPA reconciliation" : "Awaiting independent readings"}</span></div>
    <div className="voyage-cargo-scroll"><table className="voyage-cargo-table"><caption className="voyage-sr-only">{plan.callReference} declaration and final tally for {plan.title}</caption><thead><tr><th>Cargo item</th><th>Owner declared</th><th>Final NPA tally</th><th>Difference</th></tr></thead><tbody>{plan.lines.map(line => {
      const result = final?.lines.find(item => item.lineId === line.id);
      const baseline = result ? result.manifestQuantity : line.manifestQuantity;
      const comparison = tallyResult(result?.quantity, baseline);
      return <tr key={line.id}><th>{line.description}<small>{line.direction === "export" ? "Historical export · " : ""}{[line.containerSize && `${line.containerSize} ft`, line.loadStatus, UNIT_LABELS[line.unit]].filter(Boolean).join(" · ")}</small></th><td>{readingQuantity(baseline)}</td><td>{result ? readingQuantity(result.quantity) : "Pending"}</td><td><span className={`measurement-tally-status ${comparison.status}`}>{comparison.difference === null ? result ? "Declaration unknown" : "Pending" : comparison.difference === "0" ? "Tallies" : `${comparison.difference} ${UNIT_LABELS[line.unit]}`}</span></td></tr>;
    })}</tbody></table></div>
    <div className="voyage-tally-footer"><Link className="link-btn" to={`/app/measurements/${plan.id}`}>Open voyage sheet <Icon name="chevronRight" size={14} /></Link>{draft && final && <span>Previous final v{final.revision}; amendment awaiting approval.</span>}</div>
  </div>;
}
