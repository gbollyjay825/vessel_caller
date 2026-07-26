// App layout: sidebar + topbar + routed content, with a store-driven toast host.
import { useState } from "react";
import { Outlet, useLocation } from "react-router-dom";

import { Icon } from "../components/Icon";
import { Sidebar, TopBar } from "./Shell";
import { useStore } from "./store";

function titleFor(pathname: string): string {
  const p = pathname.replace(/\/+$/, "");
  if (p === "/app" || p === "") return "Dashboard";
  if (p.includes("/vessel-calls")) return "Vessel Calls";
  if (p.includes("/inspections/new")) return "New Inspection";
  if (p.includes("/inspections")) return "Inspections";
  if (p.includes("/invoices")) return "Invoices";
  if (p.includes("/analytics")) return "Analytics";
  if (p.includes("/users")) return "User Management";
  if (p.includes("/settings")) return "Settings";
  return "Dashboard";
}

export function AppShell() {
  const [mobileNav, setMobileNav] = useState(false);
  const loc = useLocation();
  return (
    <div className="app">
      <Sidebar mobileOpen={mobileNav} closeMobile={() => setMobileNav(false)} />
      {mobileNav && <div className="nav-scrim" onClick={() => setMobileNav(false)} />}
      <div className="main">
        <TopBar title={titleFor(loc.pathname)} onHamburger={() => setMobileNav((o) => !o)} />
        <div className="content scroll-host"><Outlet /></div>
      </div>
      <ToastHost />
    </div>
  );
}

function ToastHost() {
  const { toasts, dismissToast } = useStore();
  return (
    <div className="toast-host">
      {toasts.map((t) => (
        <div key={t.id} className={"toast " + (t.type || "success")} role="status">
          <span className="tic">
            <Icon name={t.type === "error" ? "alert" : t.type === "info" ? "info" : "check"} size={18} strokeWidth={2.2} />
          </span>
          <span className="tx">{t.message}</span>
          <button className="tclose" onClick={() => dismissToast(t.id)} aria-label="Dismiss"><Icon name="x" size={15} /></button>
        </div>
      ))}
    </div>
  );
}
