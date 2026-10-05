import { UNIT_LABELS } from "./cargoTemplates";
import { readingQuantity } from "./comparison";
import { latestReturns } from "./helpers";
import { reportIdentity } from "./reportIdentity";
import type { CargoLine, MeasurementPlan, Participant, Submission } from "./types";
import "../styles/voyage-readings.css";

type AgencyColumn = { key: string; name: string; role: string };
const clean = (value: string) => value.trim().replace(/\s+/g, " ");
const normalized = (value: string) => clean(value).normalize("NFKC").toLowerCase();
const agencyKey = (party: Participant) => JSON.stringify([normalized(party.name), normalized(party.role)]);
const statusLabels: Record<MeasurementPlan["status"], string> = { scheduled: "Scheduled", "in-progress": "In progress", reconciled: "Reconciled", cancelled: "Cancelled" };
const quantityLabel = (value: string | null | undefined) => {
  const label = readingQuantity(value);
  return label === "Not provided" ? "Unknown" : label;
};
function cargoHeading(line: CargoLine) {
  if (line.category !== "Container" || !line.containerSize) return line.description;
  const load = line.loadStatus ? line.loadStatus[0].toUpperCase() + line.loadStatus.slice(1) : "";
  return [`${line.containerSize} ft`, load].filter(Boolean).join(" · ");
}
function cargoContext(line: CargoLine) {
  const category = line.category === "Liquid" ? "Tanker / liquid cargo" : line.category === "Container" ? "Containers" : line.category;
  const direction = line.direction === "import" ? "Import / discharge" : line.direction === "export" ? "Export / loading" : line.direction;
  return [category, direction, line.basis].filter(Boolean).join(" · ");
}

function orderedCargoItems(lines: CargoLine[]) {
  const groups = new Map<string, CargoLine[]>();
  for (const line of lines) {
    const group = groups.get(line.category);
    if (group) group.push(line); else groups.set(line.category, [line]);
  }
  const directionRank = (value: string) => value === "import" ? 0 : value === "export" ? 1 : 2;
  const sizeRank = (value: string) => ["20", "40", "45"].includes(value) ? Number(value) : 100;
  const loadRank = (value: string) => value === "laden" ? 0 : value === "empty" ? 1 : 2;
  // Retain cargo-category order and every separate item; only container
  // categories are arranged in the same order as the owner's declaration.
  return [...groups].flatMap(([category, items]) => category === "Container" ? items.sort((left, right) =>
    directionRank(left.direction) - directionRank(right.direction)
    || left.direction.localeCompare(right.direction)
    || sizeRank(left.containerSize) - sizeRank(right.containerSize)
    || left.containerSize.localeCompare(right.containerSize)
    || loadRank(left.loadStatus) - loadRank(right.loadStatus)
    || left.loadStatus.localeCompare(right.loadStatus)
  ) : items);
}

function AgencyReading({ party, submission, line, cancelled }: { party: Participant; submission?: Submission; line: CargoLine; cancelled: boolean }) {
  if (!submission) return <span className="voyage-reading-missing">{party.requiredSubmission && !cancelled ? "Awaiting" : "Not submitted"}</span>;
  const entry = submission.lines.find(item => item.lineId === line.id);
  if (!entry) return <span className="voyage-reading-missing">Not reported</span>;
  if (entry.status === "not-applicable") return <><span>N/A</span><small>{entry.note || "No reason provided"}</small></>;
  return <><span>{quantityLabel(entry.quantity)}</span>{entry.note && <small>{entry.note}</small>}</>;
}

export function VoyageReadingsReport({ callId, plans }: { callId: string; plans: MeasurementPlan[] }) {
  const sheets = plans.filter(plan => plan.callId === callId).sort((left, right) => left.scheduledAt.localeCompare(right.scheduledAt) || left.id.localeCompare(right.id));
  const columnsByKey = new Map<string, AgencyColumn>();
  const records = sheets.map(plan => {
    const parties = new Map<string, Participant[]>();
    for (const party of plan.participants) {
      const key = agencyKey(party);
      if (!columnsByKey.has(key)) columnsByKey.set(key, { key, name: clean(party.name), role: clean(party.role) });
      const existing = parties.get(key);
      if (existing) existing.push(party); else parties.set(key, [party]);
    }
    return { plan, parties, lines: orderedCargoItems(plan.lines), returns: latestReturns(plan), identity: reportIdentity(plan, sheets) };
  });
  const columns = [...columnsByKey.values()].sort((left, right) => left.key.localeCompare(right.key));
  const expected = sheets.reduce((count, plan) => count + plan.participants.length, 0);
  const received = records.reduce((count, { plan, returns }) => count + plan.participants.filter(party => returns.has(party.id)).length, 0);
  const cancelled = sheets.filter(plan => plan.status === "cancelled").length;
  if (!sheets.length) return <div className="voyage-readings-empty" role="status"><strong>No cargo sheets recorded for this voyage.</strong><p>The owner declaration and agency readings will appear here when a voyage sheet is created.</p></div>;

  return <div className="voyage-readings-report">
    <div className="voyage-readings-summary"><p><strong>{received} / {expected}</strong> agency submissions received <span>· {sheets.length} cargo {sheets.length === 1 ? "sheet" : "sheets"}</span></p>{cancelled > 0 && <p className="voyage-readings-cancelled-note">Includes {cancelled} cancelled {cancelled === 1 ? "sheet" : "sheets"}.</p>}</div>
    <div className="voyage-readings-scroll" role="region" aria-label="Voyage readings table" tabIndex={0}>
      <table className="voyage-readings-table">
        <caption>Owner declaration and agency readings for this voyage</caption>
        <thead><tr><th scope="col" className="voyage-readings-cargo">Cargo item</th><th scope="col" className="voyage-readings-unit">Unit</th><th scope="col" className="voyage-readings-owner">Owner declaration<small>Vessel owner baseline</small></th>{columns.map(agency => <th scope="col" key={agency.key}>{agency.name}<small>{agency.role}</small></th>)}</tr></thead>
        {records.map(({ plan, parties, lines, returns, identity }) => <tbody key={plan.id}>
          <tr className="voyage-readings-sheet"><th scope="rowgroup" colSpan={columns.length + 3}><div><span><strong>{plan.title}</strong>{plan.scope && <small>{plan.scope}</small>}{identity && <small>{identity}</small>}</span><span className={`voyage-readings-status ${plan.status}`}>{statusLabels[plan.status]}</span></div></th></tr>
          {lines.length ? lines.map(line => <tr key={line.id}>
            <th scope="row" className="voyage-readings-cargo"><strong>{cargoHeading(line)}</strong>{cargoHeading(line) !== line.description && <small>{line.description}</small>}<small>{cargoContext(line)}</small></th>
            <td className="voyage-readings-unit">{UNIT_LABELS[line.unit]}</td>
            <td className="voyage-readings-owner"><strong>{quantityLabel(line.manifestQuantity)}</strong>{line.baselineReference && <small>{line.baselineReference}</small>}</td>
            {columns.map(agency => {
              const participants = parties.get(agency.key);
              return <td key={agency.key}>{participants ? participants.map(party => <div className="voyage-reading-value" key={party.id}>{participants.length > 1 && <small className="voyage-reading-representative">{party.representative}</small>}<AgencyReading party={party} submission={returns.get(party.id)} line={line} cancelled={plan.status === "cancelled"} /></div>) : <span className="voyage-reading-absent">—<small>Not participating</small></span>}</td>;
            })}
          </tr>) : <tr><td colSpan={columns.length + 3} className="voyage-readings-no-items">No cargo items recorded on this sheet.</td></tr>}
        </tbody>)}
      </table>
    </div>
    <div className="voyage-readings-legend"><p>Latest submitted reading from each agency. Each cargo item keeps its own unit and scope.</p><p><strong>NIL (0)</strong> = explicitly zero · <strong>Unknown</strong> = quantity not provided · <strong>Awaiting</strong> = required reading not submitted · <strong>Not submitted</strong> = optional or cancelled-sheet reading not received · <strong>Not reported</strong> = item missing from the submitted reading · <strong>N/A</strong> = not applicable, with reason.</p></div>
  </div>;
}
