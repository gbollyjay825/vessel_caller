// Dashboard: the one thing to do next, then the work waiting for you —
// filtered by what your role can act on (prepare, approve or bill).
import { useState } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { useBreadcrumbs } from "../app/breadcrumbs";
import { useStore } from "../app/store";
import { useAuth } from "../auth/AuthContext";
import { Icon } from "../components/Icon";
import { api } from "../lib/api";
import { Link } from "../lib/navigation";
import { measurementApi } from "../measurements/api";
import { useAgencyDirectory } from "../measurements/agencyDirectory";
import { useCloseoutPreviews, type CloseoutRecord, type PreviewEventAction } from "../measurements/closeoutPreview";
import { dateLabel } from "../measurements/helpers";
import { ErrorMessage, PreviewStorageNotice } from "../measurements/shared";
import { useVariationTariff } from "../measurements/tariffs";
import { STAGE_LABELS, STAGE_TONES, daysSince, nextStepPath, summarizeVoyages, voyagePath, type VoyageStage, type VoyageSummary } from "../measurements/voyageStatus";
import type { MeasurementPlan } from "../measurements/types";
import "../styles/measurements.css";
import "../styles/voyage-workspace.css";
import "../styles/activity-dashboard.css";

export interface DashboardAccess { manage: boolean; approve: boolean; bill: boolean }
type TileKey = "declaration" | "collecting" | "reconcile" | "approval" | "invoices" | "review";
const TILES: { key: TileKey; label: string; stages: VoyageStage[] }[] = [
  { key: "declaration", label: "Declarations to record", stages: ["declaration"] },
  { key: "collecting", label: "Agency readings outstanding", stages: ["collecting"] },
  { key: "reconcile", label: "Ready to reconcile", stages: ["ready", "returned"] },
  { key: "approval", label: "Awaiting approval", stages: ["approval"] },
  { key: "invoices", label: "Invoices to complete", stages: ["invoice", "draft", "held"] },
  { key: "review", label: "Overpayment reviews", stages: ["review"] },
];
// Money and second-review items first, then the work that unblocks them.
const PRIORITY: VoyageStage[] = ["review", "held", "approval", "returned", "ready", "invoice", "draft", "collecting", "declaration"];

/** Voyages this user can move forward, most urgent first. */
export function myWork(voyages: VoyageSummary[], access: DashboardAccess): VoyageSummary[] {
  const viewOnly = !access.manage && !access.approve && !access.bill;
  return voyages.filter(voyage => PRIORITY.includes(voyage.stage) && (viewOnly
    || (access.manage && ["declaration", "collecting", "ready", "returned"].includes(voyage.stage))
    || (access.approve && voyage.stage === "approval")
    || (access.bill && ["invoice", "draft", "held", "review"].includes(voyage.stage))))
    .sort((left, right) => PRIORITY.indexOf(left.stage) - PRIORITY.indexOf(right.stage) || (Date.parse(left.lastActivityAt ?? "") || 0) - (Date.parse(right.lastActivityAt ?? "") || 0));
}

const names = (list: string[]) => list.slice(0, 2).join(", ") + (list.length > 2 ? ` and ${list.length - 2} more` : "");
const lines = (count: number) => `${count} ${count === 1 ? "line" : "lines"}`;

/** What is needed, in one sentence, and the action that does it. */
export function voyageNeed(voyage: VoyageSummary, linkExpiry?: string | null): { need: string; action: string } {
  switch (voyage.stage) {
    case "declaration": return voyage.plans.length
      ? { need: `Declared quantity missing for ${names(voyage.missingDeclarations)}`, action: "Review declaration" }
      : { need: voyage.arrival ? `${Date.parse(voyage.arrival) > Date.now() ? "Arrives" : "Arrived"} ${dateLabel(voyage.arrival)} · owner declaration not recorded` : "Owner declaration not recorded", action: "Record declaration" };
    case "collecting": return { need: `${voyage.pendingAgencies.length ? `Waiting for ${names(voyage.pendingAgencies)}` : "Readings incomplete"} · ${voyage.received} of ${voyage.expected} in${linkExpiry ? ` · a link expires ${dateLabel(linkExpiry)}` : ""}`, action: "Chase readings" };
    case "ready": return { need: `All readings in · ${voyage.differingLines ? `${lines(voyage.differingLines)} ${voyage.differingLines === 1 ? "differs" : "differ"} from the paid declaration` : "every line matches the declaration"}`, action: "Reconcile" };
    case "returned": return { need: `Returned by ${voyage.returned?.returnedBy?.name ?? "the reviewer"}: “${voyage.returned?.returnComment ?? ""}”`, action: "Revise" };
    case "approval": return { need: `Version ${voyage.pending?.revision} prepared by ${voyage.pending?.preparedBy?.name ?? "NPA"} · ${voyage.differingLines ? `${lines(voyage.differingLines)} ${voyage.differingLines === 1 ? "differs" : "differ"} from the declaration` : "all lines agree"}`, action: "Review and approve" };
    case "invoice": return { need: "Final quantities approved · invoice details needed", action: "Complete invoice" };
    case "draft": return { need: `${voyage.invoice?.number} drafted · ${voyage.invoice?.currency} ${Number(voyage.invoice?.total ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2 })} for additional load`, action: "Review invoice" };
    case "review": return { need: `${names(voyage.invoice?.lines.filter(line => line.status === "overpayment-review").map(line => line.description) ?? [])} below the paid declaration · no credit created automatically`, action: "Open review" };
    case "held": return { need: "Billing on hold: an earlier charge exceeds what is now due", action: "Review hold" };
    default: return { need: STAGE_LABELS[voyage.stage], action: "Open" };
  }
}

function waiting(voyage: VoyageSummary): { text: string; urgent: boolean } {
  if (voyage.stage === "declaration" && !voyage.plans.length && voyage.arrival && Date.parse(voyage.arrival) > Date.now()) return { text: `ETA ${new Date(voyage.arrival).toLocaleDateString(undefined, { day: "numeric", month: "short" })}`, urgent: Date.parse(voyage.arrival) - Date.now() < 2 * 86_400_000 };
  const days = daysSince(voyage.lastActivityAt);
  if (days === null) return { text: "—", urgent: false };
  return { text: days === 0 ? "Today" : `${days} ${days === 1 ? "day" : "days"}`, urgent: days >= 5 };
}

const EVENT_TITLES: Record<PreviewEventAction, string> = {
  "report-submitted": "Final quantities sent for approval", "report-returned": "Final quantities returned for changes", "report-approved": "Final quantities approved",
  "invoice-drafted": "Variation invoice drafted", "no-charge-recorded": "No additional charge recorded", "overpayment-flagged": "Overpayment flagged for review", "billing-held": "Variation held for review",
};
function recentActivity(plans: MeasurementPlan[], records: CloseoutRecord[]) {
  const entries: { id: string; callId: string; at: string; title: string; who: string; href: string }[] = [];
  for (const plan of plans) for (const submission of plan.submissions) {
    const agency = plan.participants.find(party => party.id === submission.participantId)?.name ?? "An agency";
    entries.push({ id: `s:${submission.id}`, callId: plan.callId, at: submission.recordedAt, title: `${agency} submitted a reading${submission.revision > 1 ? ` (revision ${submission.revision})` : ""}`, who: submission.recordedBy ? `entered by ${submission.recordedBy.name}` : "via secure link", href: voyagePath(plan.callId, "readings") });
  }
  for (const record of records) for (const event of record.events) entries.push({ id: `e:${event.id}`, callId: event.callId, at: event.at, title: EVENT_TITLES[event.action], who: event.actor.name, href: voyagePath(event.callId, event.action.startsWith("report") ? "readings" : "variation-invoice") });
  return entries.sort((left, right) => (Date.parse(right.at) || 0) - (Date.parse(left.at) || 0));
}

function greeting(): string {
  const hour = new Date().getHours();
  return hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
}

function SetupChecklist({ calls, plans }: { calls: number; plans: number }) {
  const { org, can } = useAuth();
  const directory = useAgencyDirectory(org?.id);
  const { tariff } = useVariationTariff(org?.id);
  const team = useQuery({ queryKey: ["dashboard-team-size", org?.id], queryFn: () => api.users({ pageSize: 1 }), enabled: can("users.view"), retry: false, staleTime: 300_000 });
  const items = [
    { done: directory.agencies.some(agency => agency.active), label: "Add the agencies that report readings", href: "/app/settings/agencies", show: true },
    { done: (team.data?.count ?? 0) > 1, label: "Invite your team", href: "/app/users", show: can("users.view") },
    { done: calls > 0, label: "Register a vessel voyage", href: "/app/vessel-calls?register", show: can("registerCall") },
    { done: plans > 0, label: "Record the first paid declaration", href: "/app/measurements/new", show: can("measurements.manage") },
    { done: Boolean(tariff), label: "Set the variation tariff rates", href: "/app/settings/tariffs", show: can("measurements.bill") },
  ].filter(item => item.show);
  const done = items.filter(item => item.done).length;
  if (!items.length || done === items.length || directory.loading) return null;
  return <section className="voyage-card voyage-card-pad dashboard-setup" aria-labelledby="setup-heading">
    <div className="dashboard-side-head"><h2 id="setup-heading">Workspace setup</h2><span>{done} of {items.length} done</span></div>
    <div className="voyage-progress" role="progressbar" aria-label="Workspace setup progress" aria-valuemin={0} aria-valuemax={items.length} aria-valuenow={done}><span style={{ width: `${Math.round(done / items.length * 100)}%` }} /></div>
    <ul>{items.map(item => <li key={item.label} className={item.done ? "done" : ""}>{item.done ? <Icon name="check" size={16} strokeWidth={2.6} /> : <span className="dashboard-setup-dot" aria-hidden="true" />}{item.done ? <span>{item.label}<span className="hide-sr"> (done)</span></span> : <Link to={item.href}>{item.label}</Link>}</li>)}</ul>
  </section>;
}

export function ActivityDashboard() {
  const { org, user, can } = useAuth();
  const store = useStore();
  useBreadcrumbs([{ label: "Dashboard" }]);
  const access: DashboardAccess = { manage: can("measurements.manage"), approve: can("measurements.approve"), bill: can("measurements.bill") };
  const plansQuery = useQuery({ queryKey: ["measurement-plans", org?.id, undefined], queryFn: () => measurementApi.list(), refetchInterval: 30_000 });
  const previews = useCloseoutPreviews(org?.id);
  const plans = plansQuery.data?.plans ?? [];
  const voyages = summarizeVoyages(store.calls ?? [], plans, previews.records);
  const [tile, setTile] = useState<TileKey | null>(null);
  const [now] = useState(() => Date.now());
  const collectingPlans = voyages.filter(voyage => voyage.stage === "collecting").flatMap(voyage => voyage.plans).slice(0, 12);
  const linkQueries = useQueries({ queries: collectingPlans.map(plan => ({ queryKey: ["agency-links", org?.id, plan.id], queryFn: () => measurementApi.agencyLinks(plan.id), enabled: access.manage, retry: false, staleTime: 60_000 })) });
  const expiryByCall = new Map<string, string>();
  collectingPlans.forEach((plan, index) => {
    const soonest = linkQueries[index]?.data?.links.filter(link => !link.revokedAt && !link.submittedAt && Date.parse(link.expiresAt) > now).map(link => link.expiresAt).sort()[0];
    if (soonest && Date.parse(soonest) - now < 3 * 86_400_000) expiryByCall.set(plan.callId, soonest);
  });
  const mine = myWork(voyages, access);
  const selected = tile ? TILES.find(item => item.key === tile)! : null;
  const rows = selected ? voyages.filter(voyage => selected.stages.includes(voyage.stage)).sort((left, right) => PRIORITY.indexOf(left.stage) - PRIORITY.indexOf(right.stage)) : mine;
  const next = mine[0];
  const nextNeed = next ? voyageNeed(next, expiryByCall.get(next.callId)) : null;
  const activity = recentActivity(plans, previews.records).slice(0, 6);
  const voyageById = new Map(voyages.map(voyage => [voyage.callId, voyage]));
  const firstName = user?.name?.split(" ")[0] ?? "";

  return <div className="content-inner measurement-workspace activity-dashboard">
    <div className="page-head">
      <div><h1>{greeting()}{firstName ? `, ${firstName}` : ""}</h1><p className="desc">{new Date().toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" })} · your work as <strong>{user?.role ?? "a viewer"}</strong></p></div>
      {access.manage && <Link className="btn btn-primary" to="/app/measurements/new"><Icon name="plus" size={17} /> New voyage</Link>}
    </div>
    <ErrorMessage error={plansQuery.error} />
    {previews.error && <p role="alert" className="measurement-notice error">{previews.error}</p>}
    {plansQuery.isPending ? <div className="measurement-loading" role="status">Loading your work…</div> : !plansQuery.error && <>
      <section className={`dashboard-next${next && ["review", "held"].includes(next.stage) ? " review" : ""}`} aria-labelledby="next-heading">
        <div>
          <span className="dashboard-eyebrow">{next ? "Next action" : voyages.length ? "You’re up to date" : "Get started"}</span>
          {next && nextNeed ? <>
            <h2 id="next-heading">{nextNeed.action}: {next.vesselName}</h2>
            <p className="dashboard-next-voyage"><strong>{next.reference}</strong><span className={`stage-chip ${STAGE_TONES[next.stage]}`}>{STAGE_LABELS[next.stage]}</span><span>{waiting(next).text === "Today" ? "Today" : next.stage === "declaration" && !next.plans.length ? waiting(next).text : `Waiting ${waiting(next).text}`}</span></p>
            <p>{nextNeed.need}</p>
          </> : <>
            <h2 id="next-heading">{voyages.length ? "Nothing needs you right now" : "Start with a voyage’s paid declaration"}</h2>
            <p>{voyages.length ? "New readings, approvals and invoices will appear here as they arrive." : "Register the vessel’s voyage, record what the owner declared and paid for, then invite the agencies that will measure it."}</p>
          </>}
        </div>
        {next && nextNeed ? <Link className="btn btn-primary" to={nextStepPath(next)}>{nextNeed.action}<Icon name="arrowRight" size={16} /></Link>
          : access.manage && !voyages.length ? <Link className="btn btn-primary" to="/app/measurements/new">New voyage <Icon name="arrowRight" size={16} /></Link>
          : <Link className="btn btn-secondary" to="/app/measurements">All voyages <Icon name="chevronRight" size={15} /></Link>}
      </section>

      <div className="dashboard-tiles" role="group" aria-label="Voyages at each step">
        {TILES.map(item => {
          const count = voyages.filter(voyage => item.stages.includes(voyage.stage)).length;
          const tone = item.key === "invoices" ? "amber" : item.key === "review" ? "blue" : "";
          return <button type="button" key={item.key} className={`dashboard-tile${tile === item.key ? " on" : ""}`} aria-pressed={tile === item.key} onClick={() => setTile(current => current === item.key ? null : item.key)}>
            <strong className={tone}>{count}</strong><span>{item.label}</span>
          </button>;
        })}
      </div>

      <div className="voyage-columns">
        <section className="voyage-card voyage-main dashboard-queue" aria-labelledby="queue-heading">
          <div className="voyage-card-head">
            <h2 id="queue-heading">{selected ? `${selected.label} · all voyages` : "My work"} <span className="stage-chip">{rows.length}</span></h2>
            {selected ? <button type="button" className="link-btn" onClick={() => setTile(null)}>Show my work</button> : <Link className="link-btn" to="/app/measurements">All voyages <Icon name="chevronRight" size={13} /></Link>}
          </div>
          {rows.length ? <ul className="dashboard-rows">{rows.map(voyage => {
            const { need, action } = voyageNeed(voyage, expiryByCall.get(voyage.callId));
            const wait = waiting(voyage);
            return <li key={voyage.callId}>
              <div className="dashboard-row-voyage"><strong>{voyage.vesselName}</strong><span>{voyage.reference}</span></div>
              <div className="dashboard-row-need"><span className={`stage-chip ${STAGE_TONES[voyage.stage]}`}>{STAGE_LABELS[voyage.stage]}</span><p>{need}</p></div>
              <span className={`dashboard-row-wait${wait.urgent ? " urgent" : ""}`}><Icon name="calendar" size={14} />{wait.text}{wait.urgent && <span className="hide-sr"> (overdue)</span>}</span>
              <Link className="btn btn-secondary btn-sm" to={nextStepPath(voyage)} aria-label={`${action} · ${voyage.vesselName} ${voyage.reference}`}>{action}</Link>
            </li>;
          })}</ul> : <p className="dashboard-empty">{selected ? "No voyages at this step." : "Nothing is waiting for you."}</p>}
        </section>

        <aside className="voyage-aside">
          <SetupChecklist calls={store.calls?.length ?? 0} plans={plans.length} />
          <section className="voyage-card voyage-card-pad dashboard-activity" aria-labelledby="activity-heading">
            <div className="dashboard-side-head"><h2 id="activity-heading">Recent activity</h2></div>
            {activity.length ? <ol>{activity.map(entry => {
              const voyage = voyageById.get(entry.callId);
              return <li key={entry.id}><Link to={entry.href}>{entry.title}</Link><small>{voyage ? `${voyage.vesselName} · ${voyage.reference} · ` : ""}{entry.who} · {dateLabel(entry.at)}</small></li>;
            })}</ol> : <p className="dashboard-empty">Agency submissions, approvals and invoices will appear here.</p>}
          </section>
        </aside>
      </div>
      <PreviewStorageNotice />
    </>}
  </div>;
}
