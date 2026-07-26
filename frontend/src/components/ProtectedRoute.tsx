import type { ReactNode } from "react";

import { useAuth, type Permission } from "../auth/AuthContext";
import { Navigate, useLocation } from "../lib/navigation";

export function ProtectedRoute({ permission, children }: { permission?: Permission; children: ReactNode }) {
  const {
    status,
    can,
    authError,
    retrySession,
    sessionExpired,
  } = useAuth();
  const location = useLocation();
  if (status === "loading") {
    return (
      <div className="vc-center" role="status" aria-live="polite">
        <div className="vc-spinner" aria-hidden="true" />
        Loading your workspace…
      </div>
    );
  }
  if (status === "unavailable") {
    return (
      <div className="vc-center auth-service-error" role="alert">
        <strong>Secure sign-in is temporarily unavailable</strong>
        <span>{authError ?? "Check your connection and try again."}</span>
        <button className="btn btn-primary" type="button" onClick={() => void retrySession()}>
          Try again
        </button>
      </div>
    );
  }
  if (status === "anonymous") {
    return (
      <Navigate
        to="/login"
        replace
        state={{
          from: location.pathname + location.search,
          reason: sessionExpired ? "session-expired" : undefined,
        }}
      />
    );
  }
  if (permission && !can(permission)) return <Navigate to="/app" replace />;
  return <>{children}</>;
}
