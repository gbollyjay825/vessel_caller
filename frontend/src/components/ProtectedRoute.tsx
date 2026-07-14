import { Navigate, Outlet } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";

export function ProtectedRoute() {
  const { status } = useAuth();
  if (status === "loading") {
    return <div className="vc-center"><div className="vc-spinner" />Loading your workspace…</div>;
  }
  if (status === "anonymous") return <Navigate to="/login" replace />;
  return <Outlet />;
}
