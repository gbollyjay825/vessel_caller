// Voyage step 2: every agency's reading and secure link, per cargo sheet.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useStore } from "../app/store";
import { useAuth } from "../auth/AuthContext";
import { Icon } from "../components/Icon";
import { ApiError } from "../lib/api";
import { Link, useParams } from "../lib/navigation";
import { AgencyCollection } from "../measurements/AgencyCollection";
import { measurementApi } from "../measurements/api";
import { reportIdentity } from "../measurements/reportIdentity";
import { VoyageFrame, useVoyage } from "../measurements/VoyageWorkspace";
import { voyagePath } from "../measurements/voyageStatus";
import type { MeasurementPlan } from "../measurements/types";

function PlanTracker({ plan, sheets }: { plan: MeasurementPlan; sheets: MeasurementPlan[] }) {
  const { can, org } = useAuth();
  const { toast } = useStore();
  const client = useQueryClient();
  const manage = can("measurements.manage");
  const links = useQuery({ queryKey: ["agency-links", org?.id, plan.id], queryFn: () => measurementApi.agencyLinks(plan.id), enabled: manage, retry: false });
  const linksReady = Boolean(links.data);
  const refreshLinks = () => client.invalidateQueries({ queryKey: ["agency-links", org?.id, plan.id] });
  const refreshPlans = () => client.invalidateQueries({ queryKey: ["measurement-plans"] });
  return <div className="voyage-sheet">
    {sheets.length > 1 && <h2 className="voyage-sheet-title">{plan.title}<small>{reportIdentity(plan, sheets)}</small></h2>}
    {links.data?.uiPreview && <p className="measurement-notice" role="status">UI preview: links, submissions and PDF receipts use demo records in this browser.</p>}
    <AgencyCollection plan={plan} canManage={manage} links={links.data?.links} declarationHref={voyagePath(plan.callId, "declaration")}
      onCreateLink={linksReady ? async (participantId, days) => { const created = await measurementApi.createAgencyLink(plan.id, participantId, days); await refreshLinks(); return created; } : undefined}
      onRevokeLink={linksReady ? async id => { await measurementApi.revokeAgencyLink(plan.id, id); await refreshLinks(); } : undefined}
      onDownloadSubmission={linksReady ? async id => {
        const response = await fetch(measurementApi.submissionDocumentUrl(plan.id, id), { credentials: "include", headers: { Accept: "application/pdf" } });
        if (!response.ok || !response.headers.get("Content-Type")?.startsWith("application/pdf")) throw new Error("The agency PDF could not be downloaded. Try again.");
        const url = URL.createObjectURL(await response.blob());
        const anchor = document.createElement("a"); anchor.href = url; anchor.download = `agency-reading-${id}.pdf`; document.body.append(anchor); anchor.click(); anchor.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      } : undefined}
      onSubmit={async (input, version) => {
        try {
          await measurementApi.submit(plan.id, version, input);
          await refreshPlans();
          toast("Agency reading saved");
        } catch (error) {
          if (error instanceof ApiError && error.status === 409) await refreshPlans();
          throw error;
        }
      }} />
    {manage && links.error && <p className="measurement-help">Secure agency links are not enabled on this server yet.</p>}
  </div>;
}

export function VoyageAgencies() {
  const { callId = "" } = useParams<{ callId: string }>();
  const voyage = useVoyage(callId);
  const { can } = useAuth();
  const sheets = voyage.plans;
  const canStart = can("measurements.manage") && voyage.summary.stage !== "cancelled";
  return <VoyageFrame voyage={voyage} step="agencies">
    {sheets.length ? sheets.map(plan => <PlanTracker key={plan.id} plan={plan} sheets={sheets} />) : <section className="voyage-card voyage-card-pad readings-empty">
      <h2>Record the declaration first</h2>
      <p>Agencies are invited once the owner’s paid declaration is recorded for this voyage.</p>
      {canStart && <Link className="btn btn-primary" to={`/app/measurements/new?callId=${encodeURIComponent(callId)}`}>Record declaration</Link>}
    </section>}
    {sheets.length > 0 && <div className="voyage-card voyage-footer">
      <Link className="btn btn-secondary" to={voyagePath(callId, "declaration")}>Back to declaration</Link>
      <div className="readings-actions"><span className="tracker-help">You can compare readings as they arrive.</span><Link className="btn btn-primary" to={voyagePath(callId, "readings")}>Open readings report <Icon name="chevronRight" size={16} /></Link></div>
    </div>}
  </VoyageFrame>;
}
