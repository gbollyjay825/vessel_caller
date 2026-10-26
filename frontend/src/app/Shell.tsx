// App chrome: primary Sidebar (router-driven nav) + TopBar (breadcrumbs, port, user, sign out).
// Ported from calabar/shell.jsx — same className structure, no window globals,
// no user-switcher (real auth), navigation via the local SPA router adapter.
import { useState } from "react";
import { Link, NavLink } from "../lib/navigation";
import { SHOW_SECONDARY_WORKFLOW_UI } from "../lib/featureVisibility";

import { useAuth, type Permission } from "../auth/AuthContext";
import { Icon } from "../components/Icon";
import { ProductBrand, PRODUCT_NAME } from "../components/ProductBrand";
import { orgPortsLabel, userInitials } from "../lib/format";
import type { Crumb } from "./breadcrumbs";
import { useStore } from "./store";

type NavGroup = "work" | "directory" | "admin";

interface NavItem {
  key: string;
  label: string;
  icon: string;
  to: string;
  group: NavGroup;
  end?: boolean;
  permission?: Permission;
  // Earlier inspection-era screens stay routable but out of the main navigation.
  secondary?: boolean;
}

const NAV_GROUPS: { key: NavGroup; label: string }[] = [
  { key: "work", label: "Work" },
  { key: "directory", label: "Directory" },
  { key: "admin", label: "Admin" },
];

const NAV_ITEMS: NavItem[] = [
  { key: "dashboard",    group: "work", label: "Dashboard", icon: "dashboard", to: "/app/dashboard", end: true, permission: "measurements.view" },
  { key: "voyages",      group: "work", label: "Voyages",   icon: "route",     to: "/app/measurements", permission: "measurements.view" },
  { key: "vessels",      group: "work", label: "Vessels",   icon: "ship",      to: "/app/vessels", permission: "calls.view" },
  { key: "variation-invoices", group: "work", label: "Invoices", icon: "invoice", to: "/app/variation-invoices", permission: "measurements.view" },
  { key: "vessel-calls", group: "work", label: "Vessel Calls", icon: "anchor", to: "/app/vessel-calls", permission: "calls.view", secondary: true },
  { key: "inspections",  group: "work", label: "Inspections",  icon: "clipboard", to: "/app/inspections", permission: "inspections.view", secondary: true },
  { key: "invoices",     group: "work", label: "Harbour dues", icon: "receipt",   to: "/app/invoices", permission: "invoices.view", secondary: true },
  { key: "agencies",     group: "directory", label: "Agencies", icon: "building", to: "/app/settings/agencies", permission: "settings.view" },
  { key: "users",        group: "admin", label: "Users", icon: "users", to: "/app/users", permission: "users.view" },
  { key: "tariffs",      group: "admin", label: "Variation tariff", icon: "receipt", to: "/app/settings/tariffs", permission: "measurements.bill" },
  { key: "analytics",    group: "admin", label: "Analytics", icon: "gauge", to: "/app/analytics", permission: "analytics.view", secondary: true },
  { key: "settings",     group: "admin", label: "Settings", icon: "settings", to: "/app/settings", end: true, permission: "settings.view", secondary: true },
];

export function Sidebar({ mobileOpen, closeMobile }: { mobileOpen?: boolean; closeMobile?: () => void }) {
  const { org } = useStore();
  const { user, logout, can } = useAuth();
  const orgName = org?.name || PRODUCT_NAME;
  const logo = org?.logo || "/branding/npa-logo.png";
  const hasNpaLogo = logo === "/branding/npa-logo.png";
  const portLine = orgPortsLabel(org, "Port of Calabar");
  // Users without voyage access keep the vessel call screen they rely on.
  const visible = NAV_ITEMS.filter((item) => (!item.secondary || SHOW_SECONDARY_WORKFLOW_UI || (item.key === "vessel-calls" && !can("measurements.view")))
    && (!item.permission || can(item.permission)));
  return (
    <nav className={"sidebar " + (mobileOpen ? "open" : "")} aria-label="Primary">
      <div className={"sb-brand" + (hasNpaLogo ? " sb-brand--npa" : "")}>
        {hasNpaLogo ? (
          <ProductBrand className="sb-product-brand" subtitle={org?.name || portLine} />
        ) : (
          <>
            <div className="sb-mark" style={{ background: "#fff", overflow: "hidden", border: "1px solid var(--hairline)" }}>
              <img src={logo} alt={orgName + " logo"} style={{ width: "100%", height: "100%", objectFit: "contain" }} />
            </div>
            <div className="sb-wordmark">{orgName}<span>{portLine}</span></div>
          </>
        )}
      </div>
      <div className="sb-nav scroll-host">
        {NAV_GROUPS.map((group) => {
          const items = visible.filter((item) => item.group === group.key);
          if (!items.length) return null;
          return (
            <div className="sb-group" key={group.key}>
              <div className="sb-nav-label">{group.label}</div>
              {items.map((item) => (
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
          );
        })}
      </div>
      <div className="sb-user">
        <div className="avatar">{user ? userInitials(user.name) : "—"}</div>
        <div className="sb-user-meta">
          <div className="nm">{user ? user.name : "No user"}</div>
          <div className="rl">{user ? user.role : "—"}</div>
        </div>
        <button className="sb-signout" title="Sign out" aria-label="Sign out" onClick={() => void logout()}><Icon name="logout" size={17} /></button>
      </div>
    </nav>
  );
}

export function TopBar({ title, crumbs, onHamburger }: { title: string; crumbs?: Crumb[]; onHamburger?: () => void }) {
  const { org, portLabel } = useStore();
  const { user, logout, can } = useAuth();
  const [menuOpen, setMenuOpen] = useState(false);
  const trail = crumbs?.length ? crumbs : [{ label: title }];
  return (
    <header className="topbar">
      <div className="topbar-left">
        <button className="hamburger" onClick={onHamburger} aria-label="Open menu"><Icon name="menu" /></button>
        <nav className="crumbs" aria-label="Breadcrumb">
          <ol>
            {trail.map((crumb, index) => {
              const last = index === trail.length - 1;
              return (
                <li key={`${index}:${crumb.label}`}>
                  {crumb.to && !last
                    ? <Link to={crumb.to}>{crumb.label}</Link>
                    : <span aria-current={last ? "page" : undefined}>{crumb.label}</span>}
                </li>
              );
            })}
          </ol>
        </nav>
      </div>
      <div className="topbar-right">
        <div className="port-select" aria-label={`Current port: ${portLabel}`}>
          <Icon name="anchor" size={15} strokeWidth={2} />
          <span className="ps-label">{portLabel}</span>
        </div>
        <div style={{ position: "relative" }}>
          <button className="icon-btn" onClick={() => setMenuOpen((o) => !o)} aria-label="User menu" aria-expanded={menuOpen}
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
                  <div style={{ fontSize: 12, color: "var(--slate-soft)" }}>{user ? `${user.role} · ${org?.name || PRODUCT_NAME}` : "—"}</div>
                </div>
                <Link className="sb-item" style={{ borderLeft: "none" }} to="/app/account" onClick={() => setMenuOpen(false)}
                  aria-label="Account and security">
                  <Icon name="settings" size={17} /><span className="lbl">Account &amp; security</span>
                </Link>
                {can("users.view") && (
                  <Link className="sb-item" style={{ borderLeft: "none" }} to="/app/users" onClick={() => setMenuOpen(false)}
                    aria-label="Manage users">
                    <Icon name="users" size={17} /><span className="lbl">Manage users</span>
                  </Link>
                )}
                <button className="sb-item" style={{ borderLeft: "none", color: "var(--danger)" }}
                  aria-label="Sign out"
                  onClick={() => { setMenuOpen(false); void logout(); }}>
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
