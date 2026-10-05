import { useQuery } from "@tanstack/react-query";
import { useStore } from "../app/store";
import { useAuth } from "../auth/AuthContext";
import { Icon } from "../components/Icon";
import { Link, useParams } from "../lib/navigation";
import { measurementApi } from "../measurements/api";
import { dateLabel } from "../measurements/helpers";
import { ErrorMessage } from "../measurements/shared";
import { reportIdentity } from "../measurements/reportIdentity";
import { VoyageReadingsReport } from "../measurements/VoyageReadingsReport";
import "../styles/measurements.css";

export function VoyageReadings() {
  const { callId = "" } = useParams<{ callId: string }>();
  const { org, can } = useAuth();
  const store = useStore();
  const records = useQuery({ queryKey: ["measurement-plans", org?.id, callId], queryFn: () => measurementApi.list(callId), refetchInterval: 30_000 });
  const plans = records.data?.plans.filter(plan => plan.callId === callId) ?? [];
  const call = store.calls?.find(item => item.id === callId);
  const vesselName = call?.vesselName ?? plans[0]?.vesselName;
  const reference = call?.reference ?? plans[0]?.callReference;
  const canStart = Boolean(call && call.status !== "cancelled" && can("measurements.manage"));
  return <div className="content-inner measurement-workspace voyage-readings-page">
    <Link className="measurement-back" to="/app/measurements"><Icon name="chevronLeft" size={16} /> Voyages</Link>
    <div className="page-head"><div><h1>Readings</h1><p className="desc">{vesselName ? <><strong>{vesselName}</strong> · {reference}</> : "Voyage declarations and agency readings"}</p></div>{call && <Link className="btn btn-secondary" to={`/app/vessel-calls/${encodeURIComponent(callId)}`}><Icon name="ship" size={16} /> Voyage details</Link>}</div>
    {call && <dl className="readings-voyage-facts"><div><dt>Voyage</dt><dd>{call.reference}</dd></div><div><dt>Arrival</dt><dd>{dateLabel(call.eta)}</dd></div><div><dt>Terminal / berth</dt><dd>{call.berth || "Not recorded"}</dd></div></dl>}
    <ErrorMessage error={records.error} />
    {records.isPending ? <div className="measurement-loading" role="status">Loading voyage readings…</div> : !records.error && <>
      <VoyageReadingsReport callId={callId} plans={plans} />
      {!plans.length && canStart && <Link className="btn btn-primary" to={`/app/measurements/new?callId=${encodeURIComponent(callId)}`}>Start owner declaration</Link>}
      {plans.length > 0 && can("measurements.manage") && <div className="readings-collection-links">{plans.map(plan => <Link key={plan.id} className="link-btn" to={`/app/measurements/${encodeURIComponent(plan.id)}`}><span>{plans.length === 1 ? "Continue agency readings" : `Open ${plan.title}`}{plans.length > 1 && <small>{reportIdentity(plan, plans)}</small>}</span><Icon name="chevronRight" size={14} /></Link>)}</div>}
    </>}
  </div>;
}
