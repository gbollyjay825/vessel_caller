import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Invitation, User } from "../types";
import { ApiError } from "../lib/api";
import { UserManagement } from "./UserManagement";

const apiMock = vi.hoisted(() => ({
  users: vi.fn(),
  roleDefinitions: vi.fn(),
  invitations: vi.fn(),
  audit: vi.fn(),
  auditExportUrl: vi.fn(() => "/api/audit/export"),
  inviteUser: vi.fn(),
  updateUser: vi.fn(),
  removeUser: vi.fn(),
  sendUserPasswordReset: vi.fn(),
  resetUserMfa: vi.fn(),
  resendInvitation: vi.fn(),
  revokeInvitation: vi.fn(),
}));
const authMock = vi.hoisted(() => ({
  can: vi.fn<(permission: string) => boolean>(),
}));

vi.mock("./OrganizationAccess", () => ({ OrganizationAccess: () => <div>Organization sign-up controls</div> }));

vi.mock("../lib/api", () => ({
  api: apiMock,
  ApiError: class ApiError extends Error {},
}));

vi.mock("../auth/AuthContext", () => ({
  useAuth: () => ({
    user: {
      id: "admin-1",
      name: "Ada Admin",
      email: "ada@example.com",
      role: "Admin",
      status: "active",
      emailVerified: true,
      mfaEnabled: true,
      mfaRequired: true,
    },
    org: { id: "org-1", name: "NPA Test Organization" },
    can: authMock.can,
  }),
}));

const userFixture: User = {
  id: "user-2",
  name: "Grace Finance",
  email: "grace@example.com",
  role: "Finance",
  status: "active",
  emailVerified: true,
  mfaEnabled: true,
  mfaRequired: true,
  lastLogin: "2026-07-25T09:00:00Z",
};

const invitationFixture: Invitation = {
  id: "invitation-1",
  name: "Ola Operations",
  email: "ola@example.com",
  role: "Operations",
  status: "pending",
  createdAt: "2026-07-26T09:00:00Z",
  expiresAt: "2026-08-02T09:00:00Z",
};

function renderManagement() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const view = render(<QueryClientProvider client={client}><UserManagement /></QueryClientProvider>);
  return { ...view, rerenderManagement: () => view.rerender(<QueryClientProvider client={client}><UserManagement /></QueryClientProvider>) };
}

describe("UserManagement", () => {
  beforeEach(() => {
    Object.values(apiMock).forEach((mock) => {
      if ("mockReset" in mock) mock.mockReset();
    });
    apiMock.auditExportUrl.mockReturnValue("/api/audit/export");
    authMock.can.mockReset();
    authMock.can.mockReturnValue(true);
    apiMock.users.mockResolvedValue({ results: [], count: 0, page: 1, pageSize: 20 });
    apiMock.roleDefinitions.mockResolvedValue({ roles: [
      { role: "Admin", permissions: ["users.manage", "calls.manage", "invoices.pay"] },
      { role: "Operations", permissions: ["calls.manage"] },
      { role: "Finance", permissions: ["invoices.pay"] },
      { role: "Viewer", permissions: [] },
    ] });
    apiMock.invitations.mockResolvedValue({ results: [], count: 0, page: 1, pageSize: 20 });
    apiMock.audit.mockResolvedValue({ results: [], count: 0, page: 1, pageSize: 20 });
  });

  it("invites users without exposing direct password controls", async () => {
    renderManagement();
    await screen.findByText("No users found");
    await userEvent.click(screen.getByRole("button", { name: "Invite user" }));

    expect(screen.getByRole("dialog", { name: "Invite user" })).toBeInTheDocument();
    expect(screen.getByText(/recipient chooses their own password/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/password/i)).not.toBeInTheDocument();
  });

  it("loads the API-provided role access only when requested", async () => {
    renderManagement();

    await screen.findByText("No users found");
    expect(apiMock.roleDefinitions).not.toHaveBeenCalled();
    const compare = screen.getByRole("button", { name: "Compare role access" });
    expect(compare).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(compare);
    expect(await screen.findByRole("heading", { name: "Role access" })).toBeInTheDocument();
    expect(screen.getByLabelText("Admin — Invite, edit, suspend, and remove users: allowed")).toBeInTheDocument();
    expect(screen.getByLabelText("Viewer — Invite, edit, suspend, and remove users: not allowed")).toBeInTheDocument();
    expect(screen.getByText("Invite, edit, suspend, and remove users")).toBeInTheDocument();
    expect(apiMock.roleDefinitions).toHaveBeenCalledTimes(1);
    await userEvent.click(compare);
    expect(screen.queryByRole("heading", { name: "Role access" })).not.toBeInTheDocument();
  });

  it("exposes the invitations and audit workspaces as real tabs", async () => {
    renderManagement();
    await userEvent.click(screen.getByRole("tab", { name: "Invitations" }));
    expect(await screen.findByText("No invitations found")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("tab", { name: "Activity" }));
    expect(await screen.findByText("No audit events found")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Export CSV/i })).toHaveAttribute("href", "/api/audit/export");
  });

  it("opens shared organization access separately from direct staff invitations", async () => {
    renderManagement();
    await userEvent.click(screen.getByRole("tab", { name: "Sign-up link" }));
    expect(screen.getByText("Organization sign-up controls")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Sign-up link" })).toHaveAttribute("aria-selected", "true");
  });

  it("updates roles and suspends a user through audited server actions", async () => {
    apiMock.users.mockResolvedValue({ results: [userFixture], count: 1, page: 1, pageSize: 20 });
    apiMock.updateUser.mockResolvedValue({ ...userFixture, role: "Viewer" });
    renderManagement();

    await userEvent.click(await screen.findByRole("button", { name: "Edit Grace Finance" }));
    await userEvent.selectOptions(screen.getByLabelText("Role"), "Viewer");
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(apiMock.updateUser).toHaveBeenCalledWith("user-2", {
      name: "Grace Finance",
      role: "Viewer",
    });

    await userEvent.click(await screen.findByRole("button", { name: "Suspend Grace Finance" }));
    expect(screen.getByRole("alertdialog", { name: "Suspend Grace Finance?" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Suspend user" }));
    expect(apiMock.updateUser).toHaveBeenCalledWith("user-2", { status: "suspended" });
  });

  it("rotates and revokes invitation links", async () => {
    apiMock.invitations.mockResolvedValue({
      results: [invitationFixture],
      count: 1,
      page: 1,
      pageSize: 20,
    });
    apiMock.resendInvitation.mockResolvedValue(invitationFixture);
    apiMock.revokeInvitation.mockResolvedValue(undefined);
    renderManagement();

    await userEvent.click(screen.getByRole("tab", { name: "Invitations" }));
    await userEvent.click((await screen.findAllByRole("button", { name: "Resend" }))[0]);
    expect(apiMock.resendInvitation.mock.calls[0][0]).toBe("invitation-1");

    await userEvent.click(screen.getAllByRole("button", { name: "Revoke invitation for ola@example.com" })[0]);
    await userEvent.click(screen.getByRole("button", { name: "Revoke invitation" }));
    expect(apiMock.revokeInvitation.mock.calls[0][0]).toBe("invitation-1");
  });

  it("requests paginated users and resets the page when filtering", async () => {
    apiMock.users.mockResolvedValue({ results: [userFixture], count: 41, page: 1, pageSize: 20 });
    renderManagement();

    expect(await screen.findAllByText("Grace Finance")).toHaveLength(2);
    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(apiMock.users).toHaveBeenLastCalledWith(expect.objectContaining({ page: 2 }));

    await userEvent.type(screen.getByRole("searchbox", { name: "Search users" }), "Grace");
    expect(apiMock.users).toHaveBeenLastCalledWith(expect.objectContaining({ page: 1 }));
  });

  it("keeps management controls read-only without server-issued permissions", async () => {
    authMock.can.mockImplementation((permission) => (
      permission === "users.view" || permission === "audit.view"
    ));
    apiMock.users.mockResolvedValue({ results: [userFixture], count: 1, page: 1, pageSize: 20 });
    renderManagement();

    expect(await screen.findByRole("button", { name: "View Grace Finance" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Invite user" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Suspend Grace Finance" })).toBeDisabled();

    await userEvent.click(screen.getByRole("button", { name: "View Grace Finance" }));
    expect(screen.getByRole("dialog", { name: "User details" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save changes" })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("tab", { name: "Activity" }));
    await screen.findByText("No audit events found");
    expect(screen.queryByRole("link", { name: /Export CSV/i })).not.toBeInTheDocument();
  });

  it("opens one invitation form from either tab and identifies the organization", async () => {
    renderManagement();
    expect(screen.getByRole("heading", { name: "User management", level: 1 })).toBeInTheDocument();
    expect(screen.getByText(/manage their access to NPA Test Organization/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("tab", { name: "Invitations" }));
    await screen.findByText("No invitations found");
    expect(screen.queryByRole("searchbox", { name: "Search invitations" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Invite user" }));
    expect(screen.getAllByRole("dialog", { name: "Invite user" })).toHaveLength(1);
    expect(screen.getByText(/This role applies across the organization/i)).toBeInTheDocument();
    expect(screen.getByLabelText("Role")).toHaveValue("Operations");
  });

  it("submits a normalized invitation and shows its pending list after success", async () => {
    apiMock.inviteUser.mockResolvedValue(invitationFixture);
    apiMock.invitations.mockResolvedValue({ results: [invitationFixture], count: 1, page: 1, pageSize: 20 });
    renderManagement();
    await userEvent.click(screen.getByRole("button", { name: "Invite user" }));
    await userEvent.type(screen.getByLabelText(/Full name/), "  Ola Operations  ");
    await userEvent.type(screen.getByLabelText(/^Email/), "OLA@EXAMPLE.COM");
    await userEvent.click(screen.getByRole("button", { name: "Send invitation" }));

    await waitFor(() => expect(apiMock.inviteUser).toHaveBeenCalledExactlyOnceWith({ name: "Ola Operations", email: "ola@example.com", role: "Operations" }));
    expect(await screen.findByText("Invitation created")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Invitations" })).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByRole("dialog", { name: "Invite user" })).not.toBeInTheDocument();
    expect(await screen.findAllByText("Ola Operations")).not.toHaveLength(0);
    expect(screen.queryByText(/invitation (was )?sent|email delivered/i)).not.toBeInTheDocument();
  });

  it("requires a valid email before invoking the invitation API", async () => {
    renderManagement();
    await userEvent.click(screen.getByRole("button", { name: "Invite user" }));
    await userEvent.type(screen.getByLabelText(/Full name/), "Ola Operations");
    const email = screen.getByLabelText(/^Email/);
    await userEvent.type(email, "not-an-email");
    expect(email).toBeInvalid();
    await userEvent.click(screen.getByRole("button", { name: "Send invitation" }));
    fireEvent.submit(screen.getByRole("form", { name: "Invitation details" }));
    expect(apiMock.inviteUser).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Invite user" })).toBeInTheDocument();
  });

  it("blocks repeated submissions and keeps the form open while pending", async () => {
    let complete: (value: Invitation) => void = () => undefined;
    apiMock.inviteUser.mockReturnValue(new Promise<Invitation>((resolve) => { complete = resolve; }));
    renderManagement();
    await userEvent.click(screen.getByRole("button", { name: "Invite user" }));
    await userEvent.type(screen.getByLabelText(/Full name/), "Ola Operations");
    await userEvent.type(screen.getByLabelText(/^Email/), "ola@example.com");
    await userEvent.click(screen.getByRole("button", { name: "Send invitation" }));
    fireEvent.submit(screen.getByRole("form", { name: "Invitation details" }));
    expect(screen.getByRole("button", { name: "Creating invitation…" })).toBeDisabled();
    expect(screen.getByLabelText(/^Email/)).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.getByRole("dialog", { name: "Invite user" })).toBeInTheDocument();
    expect(apiMock.inviteUser).toHaveBeenCalledTimes(1);
    complete(invitationFixture);
    expect(await screen.findByText("Invitation created")).toBeInTheDocument();
  });

  it("preserves entered data and shows the API error when an invitation fails", async () => {
    apiMock.inviteUser.mockRejectedValue(new ApiError("An invitation already exists for this email.", 409));
    renderManagement();
    await userEvent.click(screen.getByRole("button", { name: "Invite user" }));
    await userEvent.type(screen.getByLabelText(/Full name/), "Ola Operations");
    await userEvent.type(screen.getByLabelText(/^Email/), "ola@example.com");
    await userEvent.selectOptions(screen.getByLabelText("Role"), "Finance");
    await userEvent.click(screen.getByRole("button", { name: "Send invitation" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("An invitation already exists for this email.");
    expect(screen.getByLabelText(/Full name/)).toHaveValue("Ola Operations");
    expect(screen.getByLabelText(/^Email/)).toHaveValue("ola@example.com");
    expect(screen.getByLabelText("Role")).toHaveValue("Finance");
    expect(screen.getByRole("button", { name: "Send invitation" })).toBeEnabled();
    expect(screen.queryByText("Invitation created")).not.toBeInTheDocument();
  });

  it("does not fetch or offer invitation actions without user-view permission", () => {
    authMock.can.mockReturnValue(false);
    renderManagement();
    expect(screen.getByText("User management is unavailable")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Invite user" })).not.toBeInTheDocument();
    expect(apiMock.users).not.toHaveBeenCalled();
    expect(apiMock.roleDefinitions).not.toHaveBeenCalled();
    expect(apiMock.invitations).not.toHaveBeenCalled();
  });

  it("directs an invitation for an already loaded colleague back to their existing user access", async () => {
    apiMock.users.mockResolvedValue({ results: [userFixture], count: 1, page: 1, pageSize: 20 });
    renderManagement();
    await screen.findAllByText("Grace Finance");
    await userEvent.click(screen.getByRole("tab", { name: "Invitations" }));
    await userEvent.click(screen.getByRole("button", { name: "Invite user" }));
    await userEvent.type(screen.getByLabelText(/Full name/), "Grace Finance");
    await userEvent.type(screen.getByLabelText(/^Email/), "GRACE@EXAMPLE.COM");
    expect(screen.getByText(/already belongs to a user in your organization/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send invitation" })).toBeDisabled();
    fireEvent.submit(screen.getByRole("form", { name: "Invitation details" }));
    expect(apiMock.inviteUser).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Review existing users" }));
    expect(screen.queryByRole("dialog", { name: "Invite user" })).not.toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Users" })).toHaveAttribute("aria-selected", "true");
  });

  it("keeps invitation actions read-only without user-management permission", async () => {
    authMock.can.mockImplementation((permission) => permission === "users.view");
    apiMock.invitations.mockResolvedValue({ results: [invitationFixture], count: 1, page: 1, pageSize: 20 });
    renderManagement();
    expect(screen.queryByRole("tab", { name: "Activity" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("tab", { name: "Invitations" }));
    expect((await screen.findAllByRole("button", { name: "Resend" }))[0]).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Invite user" })).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Revoke invitation for ola@example.com" })[0]).toBeDisabled();
  });

  it("supports keyboard navigation between the management sections", async () => {
    renderManagement();
    const users = screen.getByRole("tab", { name: "Users" });
    users.focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { name: "Invitations" })).toHaveFocus();
    expect(screen.getByRole("tabpanel", { name: "Invitations" })).toBeInTheDocument();
    await userEvent.keyboard("{End}");
    expect(screen.getByRole("tab", { name: "Activity" })).toHaveFocus();
    await userEvent.keyboard("{Home}");
    expect(users).toHaveFocus();
    expect(users).toHaveAttribute("aria-selected", "true");
  });

  it("leaves the Activity workspace when audit permission is withdrawn", async () => {
    const view = renderManagement();
    await userEvent.click(screen.getByRole("tab", { name: "Activity" }));
    await screen.findByText("No audit events found");
    authMock.can.mockImplementation((permission) => permission === "users.view" || permission === "users.manage");
    view.rerenderManagement();
    expect(screen.queryByRole("tab", { name: "Activity" })).not.toBeInTheDocument();
    expect(screen.getByRole("tabpanel", { name: "Users" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Export CSV/i })).not.toBeInTheDocument();
  });

  it("shows an expired pending invitation accurately while allowing the supported renewal action", async () => {
    apiMock.invitations.mockResolvedValue({ results: [{ ...invitationFixture, expiresAt: "2020-01-01T00:00:00Z" }], count: 1, page: 1, pageSize: 20 });
    renderManagement();
    await userEvent.click(screen.getByRole("tab", { name: "Invitations" }));
    await screen.findAllByText("Expired");
    expect(screen.getAllByRole("button", { name: "Resend" })[0]).toBeEnabled();
  });

  it("disables renewal for a stored expired status that the API cannot renew", async () => {
    apiMock.invitations.mockResolvedValue({ results: [{ ...invitationFixture, status: "expired" }], count: 1, page: 1, pageSize: 20 });
    renderManagement();
    await userEvent.click(screen.getByRole("tab", { name: "Invitations" }));
    expect((await screen.findAllByRole("button", { name: "Resend" }))[0]).toBeDisabled();
  });

  it("does not allow an Admin to change or suspend their own managed account", async () => {
    apiMock.users.mockResolvedValue({ results: [{ ...userFixture, id: "admin-1", name: "Ada Admin", role: "Admin" }], count: 1, page: 1, pageSize: 20 });
    renderManagement();
    await userEvent.click(await screen.findByRole("button", { name: "Edit Ada Admin" }));
    const dialog = screen.getByRole("dialog", { name: "User details" });
    expect(within(dialog).getByLabelText(/Full name/)).toBeDisabled();
    expect(within(dialog).getByLabelText("Role")).toBeDisabled();
    expect(within(dialog).queryByRole("button", { name: "Save changes" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Suspend Ada Admin" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Remove Ada Admin" })).toBeDisabled();
  });
});
