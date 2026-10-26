import { Navigate, useParams } from "../lib/navigation";
import { voyagePath } from "../measurements/voyageStatus";

// Final quantities are now agreed inside the readings report; keep old links working.
export function VoyageReconciliation() {
  const { callId = "" } = useParams<{ callId: string }>();
  return <Navigate to={voyagePath(callId, "readings")} replace />;
}
