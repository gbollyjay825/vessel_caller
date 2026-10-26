// Voyage step 1 after setup: the owner's declaration as recorded, plus what has
// already been paid for it.
import { useAuth } from "../auth/AuthContext";
import { Icon } from "../components/Icon";
import { Link, Navigate, useParams } from "../lib/navigation";
import { UNIT_LABELS } from "../measurements/cargoTemplates";
import { readingQuantity } from "../measurements/comparison";
import { PaidDeclarationCard } from "../measurements/PaidDeclarationFields";
import { cargoHeading } from "../measurements/readingsModel";
import { reportIdentity } from "../measurements/reportIdentity";
import { VoyageFrame, useVoyage } from "../measurements/VoyageWorkspace";
import { declarationTotals, voyagePath } from "../measurements/voyageStatus";
import type { MeasurementPlan } from "../measurements/types";
import "../styles/measurement-entry.css";

function DeclarationSheet({ plan, sheets }: { plan: MeasurementPlan; sheets: MeasurementPlan[] }) {
  const containers = plan.lines.filter(line => line.category === "Container" && line.containerSize);
  const sizes = [...new Set(containers.map(line => line.containerSize))].sort((left, right) => Number(left) - Number(right));
  const others = plan.lines.filter(line => !containers.includes(line));
  const references = [...new Set(plan.lines.map(line => line.baselineReference).filter(Boolean))];
  const cell = (size: string, load: string) => containers.find(line => line.containerSize === size && line.loadStatus === load);
  return <section className="voyage-card voyage-card-pad declaration-sheet" aria-labelledby={`sheet-${plan.id}`}>
    <div className="declaration-sheet-head">
      <div><h2 id={`sheet-${plan.id}`}>{sheets.length > 1 ? plan.title : "What the owner declared"}</h2><p>{sheets.length > 1 ? reportIdentity(plan, sheets) : `Manifest / bill of lading: ${references.join(", ") || "not recorded"}`}</p></div>
      <strong>{declarationTotals(plan.lines) || "Nothing declared"}</strong>
    </div>
    {sizes.length > 0 && <div className="entry-items-scroll"><table className="entry-matrix"><caption className="hide-sr">Declared containers by size, laden and empty</caption>
      <thead><tr><th scope="col">Containers</th><th scope="col">Laden</th><th scope="col">Empty</th><th scope="col">Total</th></tr></thead>
      <tbody>{sizes.map(size => {
        const laden = cell(size, "laden"), empty = cell(size, "empty");
        const total = [laden, empty].reduce((sum, line) => sum + (line?.manifestQuantity ? Number(line.manifestQuantity) : 0), 0);
        return <tr key={size}><th scope="row">{size} ft</th><td className="entry-total">{laden ? readingQuantity(laden.manifestQuantity) : "—"}</td><td className="entry-total">{empty ? readingQuantity(empty.manifestQuantity) : "—"}</td><td className="entry-total">{total.toLocaleString()}</td></tr>;
      })}</tbody>
    </table></div>}
    {others.length > 0 && <div className="entry-items-scroll"><table className="entry-items-table"><caption className="hide-sr">Other declared cargo</caption>
      <thead><tr><th scope="col">Cargo line</th><th scope="col">Type</th><th scope="col">Declared</th></tr></thead>
      <tbody>{others.map(line => <tr key={line.id}><th scope="row">{cargoHeading(line)}</th><td>{line.category === "Liquid" ? "Tanker / liquid" : line.category === "Bulk" ? "Dry bulk" : line.category}</td><td className="entry-total">{readingQuantity(line.manifestQuantity)} {UNIT_LABELS[line.unit].toLowerCase()}</td></tr>)}</tbody>
    </table></div>}
    <p className="entry-help">Blank lines were not declared; NIL (0) means declared as none. Cargo lines are fixed once agencies are invited or readings arrive.</p>
  </section>;
}

export function VoyageDeclaration() {
  const { callId = "" } = useParams<{ callId: string }>();
  const voyage = useVoyage(callId);
  const { can, user } = useAuth();
  const { summary, plans, preview } = voyage;
  const cancelled = summary.stage === "cancelled";
  if (!voyage.records.isPending && !voyage.records.error && !plans.length && can("measurements.manage") && !cancelled) return <Navigate to={`/app/measurements/new?callId=${encodeURIComponent(callId)}`} replace />;
  return <VoyageFrame voyage={voyage} step="declaration">
    {plans.length ? <>
      <div className="voyage-columns">
        <div className="voyage-main">{plans.map(plan => <DeclarationSheet key={plan.id} plan={plan} sheets={plans} />)}</div>
        <aside className="voyage-aside">
          <PaidDeclarationCard declaration={summary.declaration} canEdit={(can("measurements.manage") || can("measurements.bill")) && !cancelled}
            onSave={value => user ? preview.saveDeclaration(value, { id: user.id, name: user.name }) : null} />
        </aside>
      </div>
      <div className="voyage-card voyage-footer">
        {can("measurements.manage") && !cancelled ? <Link className="link-btn" to={`/app/measurements/new?callId=${encodeURIComponent(callId)}`}>Add a separate cargo sheet</Link> : <span />}
        <Link className="btn btn-primary" to={voyagePath(callId, "agencies")}>Continue to agency readings <Icon name="chevronRight" size={16} /></Link>
      </div>
    </> : <section className="voyage-card voyage-card-pad readings-empty"><h2>No declaration recorded</h2><p>An Operations user records the owner’s paid declaration for this voyage.</p></section>}
  </VoyageFrame>;
}
