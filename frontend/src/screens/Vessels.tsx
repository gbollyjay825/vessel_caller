// Vessels and their voyage history. A vessel is identified by name and flag
// until the backend keeps a vessel record of its own.
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useBreadcrumbs } from "../app/breadcrumbs";
import { useStore } from "../app/store";
import { useAuth } from "../auth/AuthContext";
import { Icon } from "../components/Icon";
import { Link, useParams } from "../lib/navigation";
import { measurementApi } from "../measurements/api";
import { useCloseoutPreviews, type PreviewReport } from "../measurements/closeoutPreview";
import { quantityDifference } from "../measurements/comparison";
import { dateLabel } from "../measurements/helpers";
import { ErrorMessage } from "../measurements/shared";
import { STAGE_LABELS, STAGE_TONES, declarationTotals, nextStepPath, summarizeVoyages, type VoyageSummary } from "../measurements/voyageStatus";
import { vesselPath, vesselSlug } from "../measurements/voyages";
import type { VesselCall } from "../types";
import "../styles/measurements.css";
import "../styles/voyage-workspace.css";
import "../styles/vessels.css";

interface VesselGroup { slug: string; name: string; flag: string; type: string; nrt: number | null; calls: VesselCall[]; voyages: VoyageSummary[] }
const CLOSED = ["no-charge", "cancelled"];
const arrivalTime = (voyage: VoyageSummary) => Date.parse(voyage.arrival || voyage.call?.registered || "") || 0;

function useVessels() {
  const { org } = useAuth();
  const store = useStore();
  const plansQuery = useQuery({ queryKey: ["measurement-plans", org?.id, undefined], queryFn: () => measurementApi.list(), refetchInterval: 60_000 });
  const previews = useCloseoutPreviews(org?.id);
  const calls = store.calls ?? [];
  const voyages = summarizeVoyages(calls, plansQuery.data?.plans ?? [], previews.records);
  const groups = new Map<string, VesselGroup>();
  for (const call of calls) {
    const slug = vesselSlug(call.vesselName, call.flag);
    const group = groups.get(slug) ?? { slug, name: call.vesselName, flag: call.flag ?? "", type: call.type, nrt: call.nrt ?? null, calls: [], voyages: [] };
    group.calls.push(call);
    groups.set(slug, group);
  }
  for (const group of groups.values()) {
    group.voyages = voyages.filter(voyage => group.calls.some(call => call.id === voyage.callId)).sort((left, right) => arrivalTime(right) - arrivalTime(left));
    const latest = group.voyages[0]?.call;
    if (latest) { group.type = latest.type; group.nrt = latest.nrt ?? null; }
  }
  return { plansQuery, previews, groups: [...groups.values()].sort((left, right) => left.name.localeCompare(right.name)) };
}

/** "+10 above · −2 below" across an approved report, per unit, never mixed. */
function varianceSummary(report?: PreviewReport): { above: string; below: string } | null {
  if (!report) return null;
  const above: { category: string; unit: "count" | "tonnes" | "m3"; manifestQuantity: string }[] = [];
  const below: typeof above = [];
  for (const line of report.lines) {
    const difference = quantityDifference(line.quantity, line.declaredQuantity);
    if (!difference || difference === "0") continue;
    const cargo = report.sourcePlans.find(plan => plan.id === line.planId)?.lines.find(item => item.id === line.lineId);
    const entry = { category: cargo?.category ?? "", unit: line.unit, manifestQuantity: difference.replace(/^[+-]/, "") };
    (difference.startsWith("-") ? below : above).push(entry);
  }
  return { above: declarationTotals(above), below: declarationTotals(below) };
}

export function Vessels() {
  useBreadcrumbs([{ label: "Vessels" }]);
  const { plansQuery, groups } = useVessels();
  const [search, setSearch] = useState("");
  const query = search.trim().toLocaleLowerCase();
  const visible = groups.filter(group => !query || [group.name, group.flag, group.type, ...group.calls.map(call => call.reference)].join(" ").toLocaleLowerCase().includes(query));
  return <div className="content-inner measurement-workspace">
    <div className="page-head"><div><h1>Vessels</h1><p className="desc">Each vessel’s particulars and the history of its voyages.</p></div></div>
    <div className="filter-bar"><div className="search-input"><Icon name="search" size={17} /><input aria-label="Search vessels" placeholder="Vessel, flag or voyage…" value={search} onChange={event => setSearch(event.target.value)} /></div></div>
    <ErrorMessage error={plansQuery.error} />
    {visible.length ? <div className="voyage-card vessels-scroll" role="region" aria-label="Vessels" tabIndex={0}><table className="vessels-table">
      <thead><tr><th scope="col">Vessel</th><th scope="col">Type</th><th scope="col">Voyages</th><th scope="col">Latest voyage</th><th scope="col">Open</th><th scope="col"><span className="hide-sr">Open vessel</span></th></tr></thead>
      <tbody>{visible.map(group => {
        const latest = group.voyages[0];
        const open = group.voyages.filter(voyage => !CLOSED.includes(voyage.stage)).length;
        return <tr key={group.slug}>
          <th scope="row"><Link to={vesselPath(group.name, group.flag)}>{group.name}</Link><small>{group.flag || "Flag not recorded"}</small></th>
          <td>{group.type || "—"}</td>
          <td>{group.voyages.length}</td>
          <td>{latest ? <>{latest.reference} <span className={`stage-chip ${STAGE_TONES[latest.stage]}`}>{STAGE_LABELS[latest.stage]}</span><small>{latest.arrival ? `Arrival ${dateLabel(latest.arrival)}` : ""}</small></> : "—"}</td>
          <td>{open || "—"}</td>
          <td><Link className="btn btn-secondary btn-sm" to={vesselPath(group.name, group.flag)} aria-label={`Open ${group.name}`}>Open</Link></td>
        </tr>;
      })}</tbody>
    </table></div> : <section className="voyage-card voyage-card-pad vessels-empty"><h2>{groups.length ? "No vessels match" : "No vessels yet"}</h2><p>{groups.length ? "Try another name, flag or voyage number." : "Vessels appear here when their first voyage is registered."}</p></section>}
  </div>;
}

export function VesselProfile() {
  const { slug = "" } = useParams<{ slug: string }>();
  const { can } = useAuth();
  const { plansQuery, groups } = useVessels();
  const key = decodeURIComponent(slug);
  const group = groups.find(item => item.slug === key);
  useBreadcrumbs([{ label: "Vessels", to: "/app/vessels" }, { label: group?.name ?? "Vessel" }]);
  if (!group) return <div className="content-inner measurement-workspace"><section className="voyage-card voyage-card-pad vessels-empty"><h1>Vessel not found</h1><p>No voyages are registered for this vessel in your organisation.</p><Link className="btn btn-secondary" to="/app/vessels">All vessels</Link></section></div>;
  const open = group.voyages.filter(voyage => !CLOSED.includes(voyage.stage)).length;
  const drafted = new Map<string, number>();
  for (const voyage of group.voyages) if (voyage.stage === "draft" && voyage.invoice) drafted.set(voyage.invoice.currency, (drafted.get(voyage.invoice.currency) ?? 0) + Math.round(Number(voyage.invoice.total) * 100));
  const reviews = group.voyages.filter(voyage => voyage.stage === "review").length;
  const agencies = new Map<string, { name: string; role: string; voyages: Set<string> }>();
  for (const voyage of group.voyages) for (const plan of voyage.plans) for (const party of plan.participants) {
    const keyName = `${party.name}|${party.role}`;
    const entry = agencies.get(keyName) ?? { name: party.name, role: party.role, voyages: new Set<string>() };
    entry.voyages.add(voyage.callId); agencies.set(keyName, entry);
  }
  const earliest = group.voyages.at(-1);
  const newVoyage = `/app/vessel-calls?${new URLSearchParams({ register: "", then: "declaration", vesselName: group.name, flag: group.flag, type: group.type })}`;
  return <div className="content-inner measurement-workspace voyage-workspace">
    <div className="voyage-header">
      <span className="voyage-header-icon" aria-hidden="true"><Icon name="ship" size={24} /></span>
      <div className="voyage-header-text"><p className="voyage-header-eyebrow">Vessel</p><h1>{group.name}</h1>
        <div className="vessel-chips">{group.type && <span className="stage-chip">{group.type}</span>}<span className="stage-chip">Flag: {group.flag || "not recorded"}</span>{group.nrt != null && <span className="stage-chip">NRT {group.nrt.toLocaleString()}</span>}</div></div>
      <div className="voyage-header-actions">{can("registerCall") && <Link className="btn btn-primary" to={newVoyage}><Icon name="plus" size={16} /> New voyage for this vessel</Link>}</div>
    </div>
    <ErrorMessage error={plansQuery.error} />
    <div className="vessel-stats">
      <div className="voyage-card voyage-card-pad"><strong>{group.voyages.length}</strong><span>{group.voyages.length === 1 ? "Voyage recorded" : "Voyages recorded"}</span><small>{earliest?.arrival ? `Since ${new Date(earliest.arrival).toLocaleDateString(undefined, { month: "long", year: "numeric" })}` : ""}{open ? ` · ${open} open` : ""}</small></div>
      <div className="voyage-card voyage-card-pad"><strong className="amber">{[...drafted].map(([currency, cents]) => `${currency} ${(cents / 100).toLocaleString(undefined, { minimumFractionDigits: 2 })}`).join(" · ") || "—"}</strong><span>Variation drafted</span><small>Additional load above paid declarations</small></div>
      <div className="voyage-card voyage-card-pad"><strong className={reviews ? "blue" : ""}>{reviews}</strong><span>Overpayment {reviews === 1 ? "review" : "reviews"}</span><small>Lower than the paid declaration</small></div>
    </div>
    <div className="voyage-columns">
      <section className="voyage-card voyage-main" aria-labelledby="history-heading">
        <div className="voyage-card-head"><h2 id="history-heading">Voyage history</h2><span className="tracker-help">Newest first · each voyage keeps its own paid declaration</span></div>
        <div className="vessels-scroll" role="region" aria-label="Voyage history" tabIndex={0}><table className="vessels-table vessel-history-table">
          <thead><tr><th scope="col">Voyage</th><th scope="col">Declared</th><th scope="col">Readings</th><th scope="col">Final vs declaration</th><th scope="col">Variation invoice</th><th scope="col">Status</th></tr></thead>
          <tbody>{group.voyages.map(voyage => {
            const variance = varianceSummary(voyage.report);
            return <tr key={voyage.callId}>
              <th scope="row"><Link to={nextStepPath(voyage)} aria-label={`Open voyage ${voyage.reference}`}>{voyage.reference}</Link><small>{voyage.arrival ? dateLabel(voyage.arrival) : ""}</small></th>
              <td>{declarationTotals(voyage.plans.flatMap(plan => plan.lines)) || <span className="tracker-muted">Not recorded</span>}{voyage.declaration?.invoiceReference && <small>{voyage.declaration.invoiceReference}{voyage.declaration.paymentStatus === "paid" ? " · paid" : ""}</small>}</td>
              <td>{voyage.expected ? `${voyage.received} of ${voyage.expected}` : "—"}</td>
              <td>{variance ? <>{variance.above && <span className="var-badge above">+{variance.above}</span>} {variance.below && <span className="var-badge below">−{variance.below}</span>}{!variance.above && !variance.below && <span className="var-match"><Icon name="check" size={13} strokeWidth={3} />Matches</span>}</> : <span className="tracker-muted">{voyage.pending ? "Awaiting approval" : "—"}</span>}</td>
              <td>{voyage.invoice ? <>{voyage.invoice.number}<small>{voyage.invoice.currency} {Number(voyage.invoice.total).toLocaleString(undefined, { minimumFractionDigits: 2 })}</small></> : <span className="tracker-muted">—</span>}</td>
              <td><span className={`stage-chip ${STAGE_TONES[voyage.stage]}`}>{STAGE_LABELS[voyage.stage]}</span></td>
            </tr>;
          })}</tbody>
        </table></div>
      </section>
      <aside className="voyage-aside">
        <section className="voyage-card voyage-card-pad vessel-particulars" aria-labelledby="particulars-heading">
          <h2 id="particulars-heading">Particulars</h2>
          <dl>{[["Vessel type", group.type], ["Flag", group.flag], ["Net tonnage (NRT)", group.nrt != null ? group.nrt.toLocaleString() : ""], ["Gross tonnage (GRT)", ""], ["Length overall (LOA)", ""], ["IMO number", ""]].map(([label, value]) => <div key={label}><dt>{label}</dt><dd className={value ? "" : "tracker-muted"}>{value || "Not recorded"}</dd></div>)}</dl>
        </section>
        {agencies.size > 0 && <section className="voyage-card voyage-card-pad vessel-agencies" aria-labelledby="vessel-agencies-heading">
          <h2 id="vessel-agencies-heading">Agencies on its voyages</h2>
          <ul>{[...agencies.values()].sort((left, right) => right.voyages.size - left.voyages.size).map(agency => <li key={`${agency.name}|${agency.role}`}><span><strong>{agency.name}</strong><small>{agency.role}</small></span><span className="tracker-muted">{agency.voyages.size} {agency.voyages.size === 1 ? "voyage" : "voyages"}</span></li>)}</ul>
          <p className="tracker-help">Suggested automatically when a new voyage starts from this vessel.</p>
        </section>}
      </aside>
    </div>
  </div>;
}
