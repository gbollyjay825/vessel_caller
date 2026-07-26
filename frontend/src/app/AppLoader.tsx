// Loads the org's state once, then mounts the store for the app screens.
import { useEffect, useState, type ReactNode } from "react";

import { api } from "../lib/api";
import type { AppState } from "../types";
import { StoreProvider } from "./store";

export function AppLoader({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AppState | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.state()
      .then((s) => { if (!cancelled) setState(s); })
      .catch((e) => { if (!cancelled) setError(e?.message || "Could not load your data"); });
    return () => { cancelled = true; };
  }, []);

  if (error) return <div className="vc-center">⚠️ {error}</div>;
  if (!state) return <div className="vc-center"><div className="vc-spinner" />Loading port data…</div>;
  return <StoreProvider initial={state}>{children}</StoreProvider>;
}
