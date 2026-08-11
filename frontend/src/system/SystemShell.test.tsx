import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { PlatformRoute, SystemShell } from "./SystemShell";

const authMock = vi.hoisted(() => ({
  user: {
    id: "operator-1", name: "System Operator", email: "operator@example.com", role: "Viewer",
    status: "active", emailVerified: true, mfaEnabled: true, mfaRequired: true,
  },
  platformAccess: {
    role: "SystemAdmin",
    permissions: ["platform.organizations.view", "platform.audit.view"],
    mfaEnrollmentRequired: false,
    stepUpRequired: false,
  } as { role: "SystemAdmin"; permissions: string[]; mfaEnrollmentRequired: boolean; stepUpRequired?: boolean } | null,
  can: vi.fn<(permission: string) => boolean>(),
  logout: vi.fn(),
}));

vi.mock("../auth/AuthContext", () => ({ useAuth: () => authMock }));
vi.mock("../components/ProtectedRoute", () => ({
  ProtectedRoute: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

describe("SystemShell", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/system");
    authMock.platformAccess = {
      role: "SystemAdmin",
      permissions: ["platform.organizations.view", "platform.audit.view"],
      mfaEnrollmentRequired: false,
      stepUpRequired: false,
    };
    authMock.can.mockReset();
    authMock.can.mockImplementation((permission) => authMock.platformAccess?.permissions.includes(permission) ?? false);
    authMock.logout.mockReset();
  });

  it("shows only authorized platform navigation in the isolated shell", () => {
    render(<SystemShell>Platform content</SystemShell>);

    expect(screen.getByText("Platform content")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Overview" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Organizations" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Platform audit" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Account & security" })).toBeInTheDocument();
    expect(screen.queryByText("Vessel calls")).not.toBeInTheDocument();
  });

  it("supports accessible mobile navigation and sign-out", async () => {
    render(<SystemShell>Platform content</SystemShell>);

    await userEvent.click(screen.getByRole("button", { name: "Open menu" }));
    expect(screen.getByRole("button", { name: "Close menu" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Close menu" }));
    expect(screen.queryByRole("button", { name: "Close menu" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(authMock.logout).toHaveBeenCalledOnce();
  });

  it("filters each navigation item by its platform permission", () => {
    authMock.platformAccess = {
      role: "SystemAdmin",
      permissions: ["platform.organizations.view"],
      mfaEnrollmentRequired: false,
    };
    render(<SystemShell>Platform content</SystemShell>);

    expect(screen.getByRole("link", { name: "Organizations" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Platform audit" })).not.toBeInTheDocument();
  });

  it("limits an unenrolled platform identity to account security", () => {
    authMock.platformAccess = {
      role: "SystemAdmin",
      permissions: [],
      mfaEnrollmentRequired: true,
    };
    render(<SystemShell>Enrollment content</SystemShell>);

    expect(screen.getByRole("alert")).toHaveTextContent("Complete authenticator enrollment");
    expect(screen.queryByRole("link", { name: "Overview" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Account & security" })).toBeInTheDocument();
  });

  it("keeps read navigation available while linking expired assurance to step-up", () => {
    authMock.platformAccess = {
      role: "SystemAdmin",
      permissions: ["platform.organizations.view"],
      mfaEnrollmentRequired: false,
      stepUpRequired: true,
    };
    render(<SystemShell>Read-only platform content</SystemShell>);

    expect(screen.getByText("Read-only platform content")).toBeInTheDocument();
    expect(screen.getByText(/Recent MFA verification is required/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Verify now" })).toHaveAttribute("href", "/system/account");
  });

  it("redirects tenant identities away from platform controls", async () => {
    authMock.platformAccess = null;
    render(<PlatformRoute permission="platform.organizations.view">Secret platform content</PlatformRoute>);

    await vi.waitFor(() => expect(window.location.pathname).toBe("/app"));
    expect(screen.queryByText("Secret platform content")).not.toBeInTheDocument();
  });

  it("redirects MFA enrollment before checking zero platform permissions", async () => {
    authMock.platformAccess = {
      role: "SystemAdmin",
      permissions: [],
      mfaEnrollmentRequired: true,
    };
    render(<PlatformRoute permission="platform.organizations.view">Secret platform content</PlatformRoute>);

    await vi.waitFor(() => expect(window.location.pathname).toBe("/system/account"));
  });

  it("renders authorized controls and permits account enrollment explicitly", () => {
    const authorized = render(
      <PlatformRoute permission="platform.organizations.view">Authorized platform content</PlatformRoute>,
    );
    expect(screen.getByText("Authorized platform content")).toBeInTheDocument();
    authorized.unmount();

    authMock.platformAccess = {
      role: "SystemAdmin",
      permissions: [],
      mfaEnrollmentRequired: true,
    };
    render(<PlatformRoute allowDuringEnrollment>Enrollment account</PlatformRoute>);
    expect(screen.getByText("Enrollment account")).toBeInTheDocument();
  });

  it("redirects a platform identity missing a required permission", async () => {
    authMock.platformAccess = {
      role: "SystemAdmin",
      permissions: [],
      mfaEnrollmentRequired: false,
    };
    render(<PlatformRoute permission="platform.audit.view">Audit content</PlatformRoute>);
    await vi.waitFor(() => expect(window.location.pathname).toBe("/system"));
    expect(screen.queryByText("Audit content")).not.toBeInTheDocument();
  });

  it.each([
    ["/system/organizations/org-1", "Organization details"],
    ["/system/organizations", "Organizations"],
    ["/system/audit", "Platform audit"],
    ["/system/account", "Account & Security"],
    ["/system/unknown", "Platform administration"],
  ])("labels the system header at %s", (path, title) => {
    window.history.replaceState(null, "", path);
    render(<SystemShell>Platform content</SystemShell>);
    expect(screen.getByRole("heading", { name: title })).toBeInTheDocument();
  });
});
