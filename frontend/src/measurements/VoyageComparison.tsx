import { readingQuantity, tallyResult } from "./comparison";
import { cargoScopeLabel, latestReturns } from "./helpers";
import type { CargoLine, MeasurementPlan, Reconciliation } from "./types";

function groupLabel(line: CargoLine): string {
  const category = line.category === "Liquid" ? "Tanker / liquid cargo" : line.category === "Container" ? "Containers" : line.category;
  const direction = line.direction === "import" ? "Import / discharge" : line.direction === "export" ? "Export / loading" : line.direction;
  return `${category} · ${direction}`;
}

export function ComparisonGrid({ plan, reconciliation, snapshot = false }: {
  plan: MeasurementPlan;
  reconciliation?: Reconciliation;
  snapshot?: boolean;
}) {
  const returns = latestReturns(snapshot && reconciliation
    ? { ...plan, submissions: plan.submissions.filter(item => reconciliation.submissionIds.includes(item.id)) }
    : plan);
  const results = new Map(reconciliation?.lines.map(line => [line.lineId, line]));
  const groups = new Map<string, CargoLine[]>();
  for (const line of plan.lines) {
    const label = groupLabel(line);
    groups.set(label, [...(groups.get(label) ?? []), line]);
  }

  return <div className="measurement-table-wrap" tabIndex={0} role="region" aria-label="Stakeholder quantities comparison">
    <table className="measurement-table comparison measurement-voyage-sheet">
      <caption>Owner-provided declaration, independent agency measurements and the NPA reconciliation result, compared in each cargo row’s stated unit. NPA reconciliation follows the required agency readings.</caption>
      <thead><tr>
        <th scope="col">Cargo / unit</th>
        <th scope="col" className="measurement-declaration">Owner declaration<small>Owner-provided baseline</small></th>
        {plan.participants.map(party => <th scope="col" key={party.id}>{party.name}<small>{party.role} · Independent measurement</small></th>)}
        <th scope="col" className="measurement-selected">{reconciliation ? `${reconciliation.status === "final" ? "Reconciled tally" : "Proposed tally"} v${reconciliation.revision}` : "Reconciled tally"}<small>{reconciliation?.status === "final" ? "Final recorded result" : "NPA reconciliation"}</small></th>
        <th scope="col">Difference<small>Reconciled − owner declared</small></th>
        <th scope="col">Does it tally?</th>
      </tr></thead>
      {[...groups].map(([label, lines]) => <tbody key={label}>
        <tr className="measurement-cargo-group"><th colSpan={plan.participants.length + 5} scope="rowgroup">{label}</th></tr>
        {lines.map(line => {
          const result = results.get(line.id);
          // A saved reconciliation uses its own declaration snapshot, including
          // an explicitly unknown declaration, rather than today's plan value.
          const declared = result ? result.manifestQuantity : line.manifestQuantity;
          const comparison = tallyResult(result?.quantity, declared);
          return <tr key={line.id}>
            <th scope="row">{line.description}<small>{cargoScopeLabel(line)} · {line.unit}</small><small>{line.basis}</small></th>
            <td className="measurement-declaration">{readingQuantity(declared)}<small>{line.baselineReference || "Source not provided"}</small></td>
            {plan.participants.map(party => {
              const entry = returns.get(party.id)?.lines.find(item => item.lineId === line.id);
              const agencyComparison = tallyResult(entry?.status === "reported" ? entry.quantity : null, declared);
              return <td key={party.id} className={!entry ? "measurement-missing" : undefined}>
                {!entry ? "Missing" : entry.status === "not-applicable" ? "N/A" : readingQuantity(entry.quantity)}
                {entry?.status === "reported" && agencyComparison.difference !== null && <small className={`measurement-reading-state ${agencyComparison.status}`}>{agencyComparison.status === "tallies" ? "Tallies" : `${agencyComparison.difference} vs owner declaration`}</small>}
                {entry?.status === "not-applicable" && <small>{entry.note}</small>}
              </td>;
            })}
            <td className="measurement-selected">{result ? readingQuantity(result.quantity) : "Pending"}</td>
            <td>{comparison.difference ?? "—"}<small>{comparison.difference !== null ? line.unit : declared === null ? "Owner declaration not provided" : "Awaiting reconciliation"}</small></td>
            <td><span className={`measurement-tally-status ${comparison.status}`}>{comparison.label}</span></td>
          </tr>;
        })}
      </tbody>)}
    </table>
  </div>;
}
