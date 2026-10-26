// Pages describe where they sit (Voyages / vessel / voyage); the top bar shows
// that trail instead of repeating the page heading, so each page keeps one H1.
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

import { useLocation } from "../lib/navigation";

export interface Crumb {
  label: string;
  to?: string;
}

type Registered = { path: string; items: Crumb[] } | null;
type BreadcrumbValue = { registered: Registered; register: (value: Registered) => void };

const BreadcrumbContext = createContext<BreadcrumbValue | null>(null);

export function BreadcrumbProvider({ children }: { children: ReactNode }) {
  const [registered, register] = useState<Registered>(null);
  const value = useMemo(() => ({ registered, register }), [registered]);
  return <BreadcrumbContext.Provider value={value}>{children}</BreadcrumbContext.Provider>;
}

export function useBreadcrumbs(items: Crumb[]) {
  const register = useContext(BreadcrumbContext)?.register;
  const { pathname } = useLocation();
  const key = JSON.stringify(items);
  useEffect(() => {
    register?.({ path: pathname, items: JSON.parse(key) as Crumb[] });
  }, [register, pathname, key]);
}

// A trail registered for another route is stale; fall back to the section name.
export function usePageCrumbs(fallback: string): Crumb[] {
  const registered = useContext(BreadcrumbContext)?.registered;
  const { pathname } = useLocation();
  return registered && registered.path === pathname && registered.items.length ? registered.items : [{ label: fallback }];
}
