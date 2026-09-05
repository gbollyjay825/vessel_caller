import { useEffect, useState, type ReactNode } from "react";

import { useAuth, type Permission } from "../auth/AuthContext";
import { Icon } from "../components/Icon";
import { ProtectedRoute } from "../components/ProtectedRoute";
import { Link, Navigate, NavLink, useLocation } from "../lib/navigation";
import { userInitials } from "../lib/format";
import { getPlatformEnvironment } from "./environment";

const NAVIGATION: Array<{ to: string; label: string; icon: string; permission: Permission; end?: boolean }> = [
  { to: "/system", label: "Overview", icon: "dashboard", permission: "platform.organizations.view", end: true },
  { to: "/system/organizations", label: "Organizations", icon: "building", permission: "platform.organizations.view" },
  { to: "/system/audit", label: "Platform audit", icon: "fileText", permission: "platform.audit.view" },
];

function pageTitle(pathname: string): string {
  if (pathname === "/system") return "Platform overview";
  if (pathname.startsWith("/system/organizations/")) return "Organization details";
  if (pathname.startsWith("/system/organizations")) return "Organizations";
  if (pathname.startsWith("/system/audit")) return "Platform audit";
  if (pathname.startsWith("/system/account")) return "Account & Security";
  return "Platform administration";
}

function PlatformAuthorization({
  permission,
  allowDuringEnrollment,
  children,
}: {
  permission?: Permission;
  allowDuringEnrollment?: boolean;
  children: ReactNode;
}) {
  const { platformAccess, can } = useAuth();
  if (!platformAccess) return <Navigate to="/app" replace />;
  if (platformAccess.mfaEnrollmentRequired && !allowDuringEnrollment) {
    return <Navigate to="/system/account" replace />;
  }
  if (permission && !can(permission)) return <Navigate to="/system" replace />;
  return <>{children}</>;
}

export function PlatformRoute({
  permission,
  allowDuringEnrollment,
  children,
}: {
  permission?: Permission;
  allowDuringEnrollment?: boolean;
  children: ReactNode;
}) {
  return (
    <ProtectedRoute>
      <PlatformAuthorization permission={permission} allowDuringEnrollment={allowDuringEnrollment}>
        {children}
      </PlatformAuthorization>
    </ProtectedRoute>
  );
}

export function SystemShell({ children }: { children: ReactNode }) {
  const { user, platformAccess, can, logout, refreshSession } = useAuth();
  const location = useLocation();
  const [mobileOpen, setMobileOpen] = useState(false);
  const enrollmentRequired = Boolean(platformAccess?.mfaEnrollmentRequired);
  const stepUpRequired = Boolean(platformAccess?.stepUpRequired) && !enrollmentRequired;
  const emailDeliveryReady = platformAccess?.emailDeliveryReady === true;
  const environment = getPlatformEnvironment(platformAccess?.environment);
  const mutationsEnabled = platformAccess?.mutationsEnabled === true && environment.kind !== "unknown";

  useEffect(() => {
    if (!platformAccess) return undefined;
    const refreshPlatformAccess = () => {
      void refreshSession().catch(() => {
        // The API remains the source of truth and fails closed on every write.
        // Keep the current read-only screen available through a transient poll failure.
      });
    };
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") refreshPlatformAccess();
    };
    const timer = window.setInterval(refreshWhenVisible, 30_000);
    window.addEventListener("focus", refreshPlatformAccess);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refreshPlatformAccess);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [platformAccess?.role, refreshSession]);

  return (
    <div className="app system-app">
      <nav className={`sidebar system-sidebar ${mobileOpen ? "open" : ""}`} aria-label="System administration">
        <div className="sb-brand">
          <div className="sb-mark"><Icon name="anchor" size={19} strokeWidth={2} /></div>
          <div className="sb-wordmark">Vessel Caller<span>Platform administration</span></div>
        </div>
        <div className="sb-nav scroll-host">
          <div className="sb-nav-label">Control plane</div>
          {enrollmentRequired ? (
            <>
              <div className="system-nav-lock-note">
                <strong>Control plane locked</strong>
                <span>Set up MFA to view organizations and platform activity.</span>
              </div>
              {NAVIGATION.map((item) => (
                <div
                  key={item.to}
                  className="sb-item system-nav-locked"
                  aria-disabled="true"
                  title="Complete authenticator setup to unlock this section"
                >
                  <Icon name={item.icon} size={19} />
                  <span className="lbl">{item.label}</span>
                  <span className="system-nav-locked-label">Locked</span>
                </div>
              ))}
            </>
          ) : NAVIGATION.filter((item) => can(item.permission)).map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className={({ isActive }) => `sb-item ${isActive ? "active" : ""}`}
                onClick={() => setMobileOpen(false)}
              >
                <Icon name={item.icon} size={19} />
                <span className="lbl">{item.label}</span>
              </NavLink>
            ))}
          <NavLink
            to="/system/account"
            className={({ isActive }) => `sb-item ${isActive ? "active" : ""}`}
            onClick={() => setMobileOpen(false)}
          >
            <Icon name="settings" size={19} />
            <span className="lbl">Account &amp; security</span>
          </NavLink>
        </div>
        <div className="sb-user">
          <div className="avatar">{user ? userInitials(user.name) : "—"}</div>
          <div className="sb-user-meta">
            <div className="nm">{user?.name ?? "No user"}</div>
            <div className="rl">System Administrator</div>
          </div>
          <button className="sb-signout" type="button" aria-label="Sign out" onClick={() => void logout()}>
            <Icon name="logout" size={17} />
          </button>
        </div>
      </nav>
      {mobileOpen && <button className="nav-scrim" type="button" aria-label="Close menu" onClick={() => setMobileOpen(false)} />}
      <div className="main">
        <header className="topbar">
          <div className="flex items-center" style={{ minWidth: 0 }}>
            <button className="hamburger" type="button" onClick={() => setMobileOpen((open) => !open)} aria-label="Open menu">
              <Icon name="menu" />
            </button>
            <h1>{pageTitle(location.pathname)}</h1>
          </div>
          <div className="topbar-right system-context">
            <span className={`tag system-environment-tag ${environment.kind}`}>{environment.label}</span>
            <span className="tag">System Admin</span>
            <Link className="icon-btn" to="/system/account" aria-label="Account and security">
              <div className="avatar">{user ? userInitials(user.name) : "—"}</div>
            </Link>
          </div>
        </header>
        <div
          className={`system-environment-bar ${environment.kind}`}
          aria-label={`${environment.label} environment`}
        >
          <span className="system-environment-dot" aria-hidden="true" />
          <strong>{environment.label}</strong>
          <span>{environment.description}</span>
          <span className={`tag system-mutation-state ${mutationsEnabled ? "enabled" : "locked"}`}>
            {mutationsEnabled ? "Changes enabled" : "Read only"}
          </span>
        </div>
        {enrollmentRequired && (
          <div className="security-banner" role="alert">
            <Icon name="alert" size={16} />
            Complete authenticator enrollment before using platform controls.
            <Link to="/system/account">Set up MFA</Link>
          </div>
        )}
        {stepUpRequired && (
          <div className="security-banner warning" role="status">
            <Icon name="alert" size={16} />
            Recent MFA verification is required before platform changes and audit export.
            <Link to="/system/account">Verify now</Link>
          </div>
        )}
        {!enrollmentRequired && !emailDeliveryReady && (
          <div className="security-banner" role="status">
            <Icon name="alert" size={16} />
            Email delivery is unavailable, so platform changes and email-based support actions are locked.
          </div>
        )}
        {!enrollmentRequired && emailDeliveryReady && !mutationsEnabled && (
          <div className="security-banner system-readonly-banner" role="status">
            <Icon name="info" size={16} />
            Platform changes are locked in this environment. You can safely review organizations and audit activity.
          </div>
        )}
        <main className="content scroll-host" id="main-content">{children}</main>
      </div>
    </div>
  );
}
