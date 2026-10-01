// Loads the org's state once, then mounts the store for the app screens.
import { useEffect, useState, type ReactNode } from "react";

import { useAuth } from "../auth/AuthContext";
import { Link } from "../lib/navigation";
import { api } from "../lib/api";
import type { AppState } from "../types";
import { StoreProvider } from "./store";

export function AppLoader({ children }: { children: ReactNode }) {
  const { logout } = useAuth();
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<AppState | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.state()
      .then((s) => { if (!cancelled) setState(s); })
      .catch((e) => { if (!cancelled) setError(e?.message || "Could not load your data"); });
    return () => { cancelled = true; };
  }, [attempt]);

  if (error) return (
    <div className="vc-center auth-service-error" role="alert">
      <strong>Workspace unavailable</strong>
      <span>{error}</span>
      <div className="flex account-actions">
        <button className="btn btn-primary" type="button" onClick={() => { setError(null); setAttempt((value) => value + 1); }}>
          Try again
        </button>
        <Link className="btn btn-ghost" to="/app/account">Account &amp; security</Link>
        <button className="btn btn-ghost" type="button" onClick={() => void logout()}>Sign out</button>
      </div>
    </div>
  );
  if (!state) return <div className="vc-center"><div className="vc-spinner" />Loading port data…</div>;
  return <StoreProvider initial={state}>{children}</StoreProvider>;
}
