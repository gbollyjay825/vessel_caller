import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { Route } from "wouter";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "../lib/api";
import type {
  Invitation,
  PlatformAuditEvent,
  PlatformOrganization,
  PlatformOverview,
  User,
} from "../types";
import { SystemAudit } from "./SystemAudit";
import { SystemOrganizationDetail } from "./SystemOrganizationDetail";
import { SystemOrganizations } from "./SystemOrganizations";
import { SystemOverview } from "./SystemOverview";

const apiMock = vi.hoisted(() => ({
  systemOverview: vi.fn(),
  systemOrganizations: vi.fn(),
  systemOrganization: vi.fn(),
  createSystemOrganization: vi.fn(),
  updateSystemOrganization: vi.fn(),
  suspendSystemOrganization: vi.fn(),
  reactivateSystemOrganization: vi.fn(),
  systemOrganizationUsers: vi.fn(),
  systemOrganizationInvitations: vi.fn(),
  inviteSystemOrganizationAdmin: vi.fn(),
  resendSystemOrganizationInvitation: vi.fn(),
  revokeSystemOrganizationInvitation: vi.fn(),
  sendSystemAdminPasswordReset: vi.fn(),
  resetSystemAdminMfa: vi.fn(),
  systemOrganizationAudit: vi.fn(),
  systemAudit: vi.fn(),
  systemAuditExportUrl: vi.fn(() => "/api/system/audit/export"),
}));
const authMock = vi.hoisted(() => ({
  can: vi.fn<(permission: string) => boolean>(),
  platformAccess: {
    role: "SystemAdmin",
    permissions: ["platform.audit.export"],
    stepUpRequired: false,
    assuranceExpiresAt: "2099-01-01T00:00:00Z" as string | null,
  },
}));

vi.mock("../lib/api", () => ({
  api: apiMock,
  ApiError: class ApiError extends Error {
    status: number;
    errors: Record<string, string | string[]>;
    requestId: string | null;
    constructor(message: string, status: number, errors = {}, requestId: string | null = null) {
      super(message);
      this.status = status;
      this.errors = errors;
      this.requestId = requestId;
    }
  },
  createIdempotencyKey: vi.fn(() => "generated-idempotency-key"),
}));
vi.mock("../auth/AuthContext", () => ({ useAuth: () => authMock }));

const organization: PlatformOrganization = {
  id: "org-1",
  name: "Harbour Logistics",
  status: "active",
  registered: true,
  rcNumber: "RC-123",
  email: "contact@harbour.example",
  phone: "+234 800 000 0000",
  address: "1 Marina Road",
  primaryPort: "Port of Calabar",
  ports: ["Port of Calabar"],
  revision: 4,
  userCount: 2,
  activeUserCount: 2,
  adminCount: 1,
  pendingInvitationCount: 1,
  createdAt: "2026-08-01T10:00:00Z",
  updatedAt: "2026-08-09T12:00:00Z",
};
const admin: User = {
  id: "admin-1",
  name: "Ada Admin",
  email: "ada@harbour.example",
  role: "Admin",
  status: "active",
  emailVerified: true,
  mfaEnabled: true,
  mfaRequired: true,
  lastLogin: "2026-08-09T12:00:00Z",
};
const finance: User = {
  ...admin,
  id: "finance-1",
  name: "Finn Finance",
  email: "finn@harbour.example",
  role: "Finance",
  mfaEnabled: false,
};
const invitation: Invitation = {
  id: "invitation-1",
  name: "Grace Admin",
  email: "grace@harbour.example",
  role: "Admin",
  status: "pending",
  expiresAt: "2026-08-11T12:00:00Z",
  createdAt: "2026-08-10T12:00:00Z",
};
const auditEvent: PlatformAuditEvent = {
  id: "event-1",
  action: "organization.suspended",
  organizationId: "org-1",
  organizationName: "Harbour Logistics",
  actor: { id: "operator-1", name: "System Operator", email: "operator@example.com" },
  targetType: "organization",
  targetId: "org-1",
  targetLabel: "Harbour Logistics",
  reason: "Customer requested a temporary access hold while ownership records are reviewed.",
  requestId: "request-1",
  occurredAt: "2026-08-10T12:00:00Z",
};

function page<T>(results: T[]) {
  return { results, count: results.length, page: 1, pageSize: 20 };
}

function renderScreen(ui: ReactElement, path = "/system") {
  window.history.replaceState(null, "", path);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

describe("System console screens", () => {
  beforeEach(() => {
    Object.values(apiMock).forEach((mock) => mock.mockReset());
    apiMock.systemAuditExportUrl.mockReturnValue("/api/system/audit/export");
    authMock.can.mockReset();
    authMock.can.mockReturnValue(true);
    authMock.platformAccess.stepUpRequired = false;
    authMock.platformAccess.assuranceExpiresAt = "2099-01-01T00:00:00Z";
    apiMock.systemOrganization.mockResolvedValue({ organization });
    apiMock.systemOrganizations.mockResolvedValue(page([organization]));
    apiMock.systemOrganizationUsers.mockResolvedValue(page([admin, finance]));
    apiMock.systemOrganizationInvitations.mockResolvedValue(page([invitation]));
    apiMock.systemOrganizationAudit.mockResolvedValue(page([auditEvent]));
    apiMock.systemAudit.mockResolvedValue(page([auditEvent]));
  });

  it("renders access-only overview metrics without tenant operational data", async () => {
    const overview: PlatformOverview = {
      organizationCount: 3,
      activeOrganizationCount: 2,
      suspendedOrganizationCount: 1,
      activeUserCount: 8,
      pendingInvitationCount: 2,
      recentOrganizations: [organization],
    };
    apiMock.systemOverview.mockResolvedValue(overview);
    renderScreen(<SystemOverview />);

    expect(await screen.findAllByText("Harbour Logistics")).not.toHaveLength(0);
    expect(screen.getByText("Customer organizations")).toBeInTheDocument();
    expect(screen.getByText("2 pending invitations")).toBeInTheDocument();
    expect(screen.queryByText(/vessel calls/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/invoices/i)).not.toBeInTheDocument();
    expect(screen.queryByText("contact@harbour.example")).not.toBeInTheDocument();
  });

  it("shows a retryable overview error with its request ID", async () => {
    apiMock.systemOverview.mockRejectedValue(new ApiError("Overview unavailable", 503, {}, "request-failed"));
    renderScreen(<SystemOverview />);

    expect(await screen.findByRole("alert")).toHaveTextContent("Overview unavailable");
    expect(screen.getByRole("alert")).toHaveTextContent("request-failed");
    apiMock.systemOverview.mockResolvedValue({
      organizationCount: 0,
      activeOrganizationCount: 0,
      suspendedOrganizationCount: 0,
      activeUserCount: 0,
      pendingInvitationCount: 0,
      recentOrganizations: [],
    });
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("No organizations yet")).toBeInTheDocument();
  });

  it("filters organizations and retries creation with the same idempotency key", async () => {
    apiMock.createSystemOrganization
      .mockRejectedValueOnce(new Error("Connection interrupted"))
      .mockResolvedValueOnce({ organization, rev: 4, invitation });
    renderScreen(<SystemOrganizations />, "/system/organizations");

    expect(await screen.findAllByText("Harbour Logistics")).not.toHaveLength(0);
    await userEvent.click(screen.getByRole("button", { name: "Create organization" }));

    await userEvent.type(screen.getByLabelText(/^Organization name/), "New Harbour");
    await userEvent.type(screen.getByLabelText(/^Admin name/), "New Admin");
    await userEvent.type(screen.getByLabelText(/^Admin email/), "new.admin@example.com");
    await userEvent.click(screen.getByRole("button", { name: "Create and invite Admin" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Connection interrupted");
    await userEvent.click(screen.getByRole("button", { name: "Create and invite Admin" }));
    await vi.waitFor(() => expect(apiMock.createSystemOrganization).toHaveBeenCalledTimes(2));
    expect(apiMock.createSystemOrganization.mock.calls[0][1]).toBe("generated-idempotency-key");
    expect(apiMock.createSystemOrganization.mock.calls[1][1]).toBe("generated-idempotency-key");
    expect(apiMock.createSystemOrganization.mock.calls[0][0]).toEqual(expect.objectContaining({
      name: "New Harbour",
      initialAdmin: { name: "New Admin", email: "new.admin@example.com" },
    }));
    await userEvent.type(screen.getByRole("searchbox", { name: "Search organizations" }), "Harbour");
    await vi.waitFor(() => expect(apiMock.systemOrganizations).toHaveBeenLastCalledWith(expect.objectContaining({ search: "Harbour" })));
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Lifecycle status" }), "active");
  });

  it("edits, suspends, and safely recovers tenant Admin access", async () => {
    const updated = { ...organization, name: "Harbour Agency", revision: 5 };
    const suspended = {
      ...updated,
      status: "suspended" as const,
      revision: 6,
      suspendedAt: "2026-08-10T13:00:00Z",
      suspensionReason: "Customer ownership review",
    };
    apiMock.updateSystemOrganization
      .mockRejectedValueOnce(new ApiError("Conflict", 409))
      .mockResolvedValueOnce({ organization: updated, rev: 5 });
    apiMock.suspendSystemOrganization.mockResolvedValue({ organization: suspended, rev: 6 });
    apiMock.sendSystemAdminPasswordReset.mockResolvedValue({ detail: "Password reset queued.", rev: 7 });
    apiMock.resetSystemAdminMfa.mockResolvedValue({ user: { ...admin, mfaEnabled: false }, rev: 8 });
    apiMock.resendSystemOrganizationInvitation.mockResolvedValue({ invitation, rev: 9 });
    apiMock.revokeSystemOrganizationInvitation.mockResolvedValue({ invitation: { ...invitation, status: "revoked" }, rev: 10 });
    apiMock.inviteSystemOrganizationAdmin.mockResolvedValue({ invitation, rev: 11 });

    renderScreen(
      <Route path="/system/organizations/:id"><SystemOrganizationDetail /></Route>,
      "/system/organizations/org-1",
    );
    expect(await screen.findByRole("heading", { name: "Harbour Logistics" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Edit" }));
    const name = screen.getByLabelText(/^Organization name/);
    await userEvent.clear(name);
    await userEvent.type(name, "Harbour Agency");
    await userEvent.click(screen.getByRole("button", { name: "Save profile" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("edits are preserved");
    await userEvent.click(screen.getByRole("button", { name: "Save profile" }));
    expect(await screen.findByRole("heading", { name: "Harbour Agency" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Suspend organization" }));
    const suspendDialog = screen.getByRole("alertdialog", { name: /Suspend Harbour Agency/ });
    const suspendButton = within(suspendDialog).getByRole("button", { name: "Suspend organization" });
    expect(suspendButton).toBeDisabled();
    await userEvent.type(within(suspendDialog).getByLabelText(/^Suspension reason/), "Customer ownership review");
    await userEvent.click(suspendButton);
    expect(await screen.findByText("Workspace access is suspended.")).toBeInTheDocument();
    expect(apiMock.suspendSystemOrganization).toHaveBeenCalledWith(
      "org-1", "Customer ownership review", 5, "generated-idempotency-key",
    );

    await userEvent.click(screen.getByRole("tab", { name: "Access" }));
    expect(await screen.findAllByText("Ada Admin")).not.toHaveLength(0);
    expect(screen.getAllByText("Read only")).not.toHaveLength(0);

    await userEvent.click(screen.getAllByRole("button", { name: "Send password reset" })[0]);
    const passwordDialog = screen.getByRole("alertdialog", { name: /Send password reset for Ada Admin/ });
    await userEvent.type(within(passwordDialog).getByLabelText(/^Support reason/), "Customer requested recovery");
    await userEvent.click(within(passwordDialog).getByRole("button", { name: "Send password reset" }));
    expect(await screen.findByText("Password reset queued.")).toBeInTheDocument();

    await userEvent.click(screen.getAllByRole("button", { name: "Reset MFA" })[0]);
    const mfaDialog = screen.getByRole("alertdialog", { name: /Reset MFA for Ada Admin/ });
    await userEvent.type(within(mfaDialog).getByLabelText(/^Support reason/), "Lost authenticator device");
    await userEvent.click(within(mfaDialog).getByRole("button", { name: "Reset MFA and sessions" }));
    expect(await screen.findByText("MFA reset for Ada Admin.")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Resend" }));
    expect(await screen.findByText(/new 24-hour invitation/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Revoke" }));
    await userEvent.click(within(screen.getByRole("alertdialog", { name: /Revoke invitation/ })).getByRole("button", { name: "Revoke invitation" }));
    expect(await screen.findByText(/was revoked/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Invite tenant Admin" }));
    const drawer = screen.getByRole("dialog", { name: "Invite tenant Admin" });
    await userEvent.type(within(drawer).getByLabelText(/^Full name/), "Grace Admin");
    await userEvent.type(within(drawer).getByLabelText(/^Email/), "grace@harbour.example");
    await userEvent.click(within(drawer).getByRole("button", { name: "Send Admin invitation" }));
    await vi.waitFor(() => expect(apiMock.inviteSystemOrganizationAdmin).toHaveBeenCalledWith(
      "org-1",
      { name: "Grace Admin", email: "grace@harbour.example" },
      "generated-idempotency-key",
    ));
  });

  it("renders reason-rich platform audit and gates filtered CSV export", async () => {
    renderScreen(<SystemAudit />, "/system/audit");

    expect(await screen.findAllByText(auditEvent.reason!)).not.toHaveLength(0);
    const exportLink = screen.getByRole("link", { name: "Download CSV" });
    expect(exportLink).toHaveAttribute("href", "/api/system/audit/export");
    expect(apiMock.systemAuditExportUrl).toHaveBeenCalledWith({ search: "", action: "" });
    await userEvent.type(screen.getByRole("searchbox", { name: "Search platform audit" }), "ownership");
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Audit action" }), "organization.suspended");
    await vi.waitFor(() => expect(apiMock.systemAudit).toHaveBeenLastCalledWith(expect.objectContaining({
      search: "ownership",
      action: "organization.suspended",
    })));
  });

  it("routes expired-assurance mutations and audit export to step-up", async () => {
    apiMock.createSystemOrganization.mockRejectedValue(new ApiError(
      "Recent multi-factor verification is required",
      403,
      { code: "system_mfa_step_up_required" },
    ));
    renderScreen(<SystemOrganizations />, "/system/organizations");
    await screen.findAllByText("Harbour Logistics");
    await userEvent.click(screen.getByRole("button", { name: "Create organization" }));
    await userEvent.type(screen.getByLabelText(/^Organization name/), "Assurance Test");
    await userEvent.type(screen.getByLabelText(/^Admin name/), "Test Admin");
    await userEvent.type(screen.getByLabelText(/^Admin email/), "admin@test.example");
    await userEvent.click(screen.getByRole("button", { name: "Create and invite Admin" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Recent multi-factor verification is required");
    expect(screen.getByRole("link", { name: "Verify now" })).toHaveAttribute("href", "/system/account");

    authMock.platformAccess.stepUpRequired = true;
    renderScreen(<SystemAudit />, "/system/audit");
    expect(await screen.findByRole("link", { name: "Verify to export CSV" })).toHaveAttribute("href", "/system/account");
    expect(screen.queryByRole("link", { name: "Download CSV" })).not.toBeInTheDocument();
  });

  it("rechecks assurance when CSV export is clicked after the page has been left open", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-08-10T12:00:00Z"));
    authMock.platformAccess.assuranceExpiresAt = "2026-08-10T12:00:01Z";
    renderScreen(<SystemAudit />, "/system/audit");

    const exportLink = await screen.findByRole("link", { name: "Download CSV" });
    vi.setSystemTime(new Date("2026-08-10T12:00:02Z"));
    fireEvent.click(exportLink);

    expect(window.location.pathname).toBe("/system/account");
    vi.useRealTimers();
  });

  it("hides privileged controls when platform permissions are read-only", async () => {
    authMock.can.mockReturnValue(false);
    renderScreen(
      <Route path="/system/organizations/:id"><SystemOrganizationDetail /></Route>,
      "/system/organizations/org-1",
    );
    expect(await screen.findByRole("heading", { name: "Harbour Logistics" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Suspend organization" })).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Access" })).not.toBeInTheDocument();

    renderScreen(<SystemAudit />, "/system/audit");
    expect(await screen.findAllByText(auditEvent.reason!)).not.toHaveLength(0);
    expect(screen.queryByRole("link", { name: "Download CSV" })).not.toBeInTheDocument();
  });
});
