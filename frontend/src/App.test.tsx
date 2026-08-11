import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import App from "./App";

const authMock = vi.hoisted(() => ({
  platformAccess: null as null | { role: "SystemAdmin" },
  homePath: "/app",
}));

vi.mock("./auth/AuthContext", () => ({
  AuthProvider: ({ children }: { children: ReactNode }) => <div data-testid="auth-provider">{children}</div>,
  useAuth: () => authMock,
}));
vi.mock("./components/ProtectedRoute", () => ({
  ProtectedRoute: ({ permission, children }: { permission?: string; children: ReactNode }) => (
    <div data-permission={permission ?? "authenticated"}>{children}</div>
  ),
}));
vi.mock("./app/AppLoader", () => ({
  AppLoader: ({ children }: { children: ReactNode }) => <div data-testid="app-loader">{children}</div>,
}));
vi.mock("./app/AppShell", () => ({
  AppShell: ({ children }: { children: ReactNode }) => <div data-testid="app-shell">{children}</div>,
}));
vi.mock("./lib/navigation", () => ({
  Navigate: ({ to }: { to: string }) => <div>Navigate:{to}</div>,
}));
vi.mock("./mobile/MobileApp", () => ({ MobileApp: () => <div>Mobile capture screen</div> }));
vi.mock("./screens/AccountSecurity", () => ({ AccountSecurity: () => <div>Account security screen</div> }));
vi.mock("./screens/Analytics", () => ({ Analytics: () => <div>Analytics screen</div> }));
vi.mock("./screens/AuthPage", () => ({ AuthPage: ({ mode }: { mode: string }) => <div>Auth:{mode}</div> }));
vi.mock("./screens/Dashboard", () => ({ Dashboard: () => <div>Dashboard screen</div> }));
vi.mock("./screens/EmailVerification", () => ({ EmailVerification: () => <div>Email verification screen</div> }));
vi.mock("./screens/Inspections", () => ({
  Inspections: () => <div>Inspections screen</div>,
  NewInspection: () => <div>New inspection screen</div>,
}));
vi.mock("./screens/InvitationAccept", () => ({ InvitationAccept: () => <div>Invitation screen</div> }));
vi.mock("./screens/Invoices", () => ({ Invoices: () => <div>Invoices screen</div> }));
vi.mock("./screens/LandingFull", () => ({ Landing: () => <div>Landing screen</div> }));
vi.mock("./screens/PasswordRecovery", () => ({
  ForgotPassword: () => <div>Forgot password screen</div>,
  ResetPassword: () => <div>Reset password screen</div>,
}));
vi.mock("./screens/Settings", () => ({ Settings: () => <div>Settings screen</div> }));
vi.mock("./screens/UserManagement", () => ({ UserManagement: () => <div>User management screen</div> }));
vi.mock("./screens/VesselCalls", () => ({
  VesselCalls: () => <div>Vessel calls screen</div>,
  VesselCallDetail: () => <div>Vessel call detail screen</div>,
}));
vi.mock("./system/SystemAudit", () => ({ SystemAudit: () => <div>System audit screen</div> }));
vi.mock("./system/SystemAccount", () => ({ SystemAccount: () => <div>System account screen</div> }));
vi.mock("./system/SystemOrganizationDetail", () => ({ SystemOrganizationDetail: () => <div>System organization detail screen</div> }));
vi.mock("./system/SystemOrganizations", () => ({ SystemOrganizations: () => <div>System organizations screen</div> }));
vi.mock("./system/SystemOverview", () => ({ SystemOverview: () => <div>System overview screen</div> }));
vi.mock("./system/SystemShell", () => ({
  PlatformRoute: ({ permission, children }: { permission?: string; children: ReactNode }) => (
    <div data-platform-permission={permission ?? "authenticated"}>{children}</div>
  ),
  SystemShell: ({ children }: { children: ReactNode }) => <div data-testid="system-shell">{children}</div>,
}));

afterEach(() => cleanup());

function renderPath(path: string) {
  window.history.replaceState(null, "", path);
  return render(<App />);
}

describe("App route contract", () => {
  it.each([
    ["/", "Landing screen"],
    ["/login", "Auth:login"],
    ["/register", "Auth:register"],
    ["/verify-email", "Email verification screen"],
    ["/forgot-password", "Forgot password screen"],
    ["/reset-password", "Reset password screen"],
    ["/accept-invitation", "Invitation screen"],
  ])("routes the public path %s", (path, expected) => {
    renderPath(path);
    expect(screen.getByText(expected)).toBeInTheDocument();
    expect(screen.getByTestId("auth-provider")).toBeInTheDocument();
  });

  it.each([
    ["/app", "Dashboard screen", "authenticated"],
    ["/app/vessel-calls", "Vessel calls screen", "authenticated"],
    ["/app/vessel-calls/call-1", "Vessel call detail screen", "authenticated"],
    ["/app/inspections", "Inspections screen", "authenticated"],
    ["/app/inspections/new", "New inspection screen", "inspections.manage"],
    ["/app/invoices", "Invoices screen", "authenticated"],
    ["/app/account", "Account security screen", "authenticated"],
    ["/app/analytics", "Analytics screen", "analytics.view"],
    ["/app/users", "User management screen", "users.view"],
    ["/app/settings", "Settings screen", "settings.view"],
  ])("routes the workspace path %s", (path, expected, permission) => {
    const view = renderPath(path);
    expect(screen.getByText(expected)).toBeInTheDocument();
    expect(screen.getByTestId("app-loader")).toBeInTheDocument();
    expect(screen.getByTestId("app-shell")).toBeInTheDocument();
    expect(view.container.querySelector(`[data-permission="${permission}"]`)).toBeInTheDocument();
  });

  it("protects field capture and redirects unknown paths safely", () => {
    const capture = renderPath("/capture");
    expect(screen.getByText("Mobile capture screen")).toBeInTheDocument();
    expect(capture.container.querySelector('[data-permission="inspections.manage"]')).toBeInTheDocument();
    capture.unmount();

    const workspaceFallback = renderPath("/app/not-a-route");
    expect(screen.getByText("Navigate:/app")).toBeInTheDocument();
    workspaceFallback.unmount();

    renderPath("/not-a-route");
    expect(screen.getByText("Navigate:/")).toBeInTheDocument();
  });

  it.each([
    ["/system", "System overview screen", "platform.organizations.view"],
    ["/system/organizations", "System organizations screen", "platform.organizations.view"],
    ["/system/organizations/org-1", "System organization detail screen", "platform.organizations.view"],
    ["/system/audit", "System audit screen", "platform.audit.view"],
    ["/system/account", "System account screen", "authenticated"],
  ])("routes %s through the isolated platform shell", (path, expected, permission) => {
    const view = renderPath(path);
    expect(screen.getByText(expected)).toBeInTheDocument();
    expect(screen.getByTestId("system-shell")).toBeInTheDocument();
    expect(screen.queryByTestId("app-loader")).not.toBeInTheDocument();
    expect(screen.queryByTestId("app-shell")).not.toBeInTheDocument();
    expect(view.container.querySelector(`[data-platform-permission="${permission}"]`)).toBeInTheDocument();
  });
});
