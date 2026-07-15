// App chrome: primary Sidebar (router-driven nav) + TopBar (port, user, sign out).
// Ported from calabar/shell.jsx — same className structure, no window globals,
// no user-switcher (real auth), navigation via react-router NavLink.
import { useState } from "react";
import { NavLink } from "react-router-dom";

import { useAuth } from "../auth/AuthContext";
import { Icon } from "../components/Icon";
import { orgPortsLabel, userInitials } from "../lib/format";
import { useStore } from "./store";

interface NavItem {
  key: string;
  label: string;
  icon: string;
  to: string;
  end?: boolean;
}

const NAV_ITEMS: NavItem[] = [
  { key: "dashboard",    label: "Dashboard",    icon: "dashboard", to: "/app", end: true },
  { key: "vessel-calls", label: "Vessel Calls", icon: "ship",      to: "/app/vessel-calls" },
  { key: "inspections",  label: "Inspections",  icon: "clipboard", to: "/app/inspections" },
  { key: "invoices",     label: "Invoices",     icon: "invoice",   to: "/app/invoices" },
  { key: "analytics",    label: "Analytics",    icon: "gauge",     to: "/app/analytics" },
  { key: "settings",     label: "Settings",     icon: "settings",  to: "/app/settings" },
];

export function Sidebar({ mobileOpen, closeMobile }: { mobileOpen?: boolean; closeMobile?: () => void }) {
  const { org } = useStore();
  const { user, logout } = useAuth();
  const orgName = org?.name || "Vessel Caller";
  const portLine = orgPortsLabel(org, "Port of Calabar") + " · Inspection";
  return (
    <nav className={"sidebar " + (mobileOpen ? "open" : "")} aria-label="Primary">
      <div className="sb-brand">
        <div className="sb-mark" style={org && org.logo ? { background: "#fff", overflow: "hidden", border: "1px solid var(--hairline)" } : undefined}>
          {org && org.logo
            ? <img src={org.logo} alt={orgName + " logo"} style={{ width: "100%", height: "100%", objectFit: "contain" }} />
            : <Icon name="anchor" size={19} strokeWidth={2} />}
        </div>
        <div className="sb-wordmark">{orgName}<span>{portLine}</span></div>
      </div>
      <div className="sb-nav scroll-host">
        <div className="sb-nav-label">Operations</div>
        {NAV_ITEMS.map((item) => (
          <NavLink
            key={item.key}
            to={item.to}
            end={item.end}
            className={({ isActive }) => "sb-item " + (isActive ? "active" : "")}
            onClick={() => closeMobile?.()}
          >
            <Icon name={item.icon} size={19} className="ico" />
            <span className="lbl">{item.label}</span>
          </NavLink>
        ))}
      </div>
      <div className="sb-user">
        <div className="avatar">{user ? userInitials(user.name) : "—"}</div>
        <div className="sb-user-meta">
          <div className="nm">{user ? user.name : "No user"}</div>
          <div className="rl">{user ? user.role : "—"}</div>
        </div>
        <button className="sb-signout" title="Sign out" aria-label="Sign out" onClick={logout}><Icon name="logout" size={17} /></button>
      </div>
    </nav>
  );
}

export function TopBar({ title, onHamburger }: { title: string; onHamburger?: () => void }) {
  const { org, portLabel } = useStore();
  const { user, logout } = useAuth();
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    <header className="topbar">
      <div className="flex items-center" style={{ minWidth: 0 }}>
        <button className="hamburger" onClick={onHamburger} aria-label="Open menu"><Icon name="menu" /></button>
        <h1>{title}</h1>
      </div>
      <div className="topbar-right">
        <button className="port-select">
          <Icon name="anchor" size={15} strokeWidth={2} />
          <span className="ps-label">{portLabel}</span>
          <Icon name="chevronDown" size={15} />
        </button>
        <button className="icon-btn" aria-label="Notifications" title="Notifications">
          <Icon name="bell" size={19} /><span className="bell-dot" />
        </button>
        <div style={{ position: "relative" }}>
          <button className="icon-btn" onClick={() => setMenuOpen((o) => !o)} aria-label="User menu"
            style={{ width: "auto", padding: "0 6px", gap: 6 }}>
            <div className="avatar" style={{ width: 30, height: 30, fontSize: 12 }}>{user ? userInitials(user.name) : "—"}</div>
            <Icon name="chevronDown" size={15} />
          </button>
          {menuOpen && (
            <>
              <div style={{ position: "fixed", inset: 0, zIndex: 1 }} onClick={() => setMenuOpen(false)} />
              <div style={{ position: "absolute", right: 0, top: "110%", background: "#fff", border: "1px solid var(--hairline)", borderRadius: 8, boxShadow: "var(--shadow-pop)", minWidth: 240, zIndex: 2, padding: 6 }}>
                <div style={{ padding: "8px 10px", borderBottom: "1px solid var(--hairline)", marginBottom: 4 }}>
                  <div style={{ fontWeight: 600, fontSize: 13 }}>{user ? user.name : "No user"}</div>
                  <div style={{ fontSize: 12, color: "var(--slate-soft)" }}>{user ? `${user.role} · ${org?.name || "Vessel Caller"}` : "—"}</div>
                </div>
                <button className="sb-item" style={{ borderLeft: "none", color: "var(--danger)" }}
                  onClick={() => { setMenuOpen(false); logout(); }}>
                  <Icon name="logout" size={17} /><span className="lbl">Sign out</span>
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </header>
  );
}
