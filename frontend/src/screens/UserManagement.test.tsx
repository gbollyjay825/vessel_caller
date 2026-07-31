import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Invitation, User } from "../types";
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
  return render(<QueryClientProvider client={client}><UserManagement /></QueryClientProvider>);
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

  it("shows the API-provided role matrix before an Admin grants access", async () => {
    renderManagement();

    expect(await screen.findByRole("heading", { name: "Role access matrix" })).toBeInTheDocument();
    expect(screen.getByLabelText("Admin — Invite, edit, suspend, and remove users: allowed")).toBeInTheDocument();
    expect(screen.getByLabelText("Viewer — Invite, edit, suspend, and remove users: not allowed")).toBeInTheDocument();
    expect(screen.getByText("Invite, edit, suspend, and remove users")).toBeInTheDocument();
    expect(apiMock.roleDefinitions).toHaveBeenCalledTimes(1);
  });

  it("exposes the invitations and audit workspaces as real tabs", async () => {
    renderManagement();
    await userEvent.click(screen.getByRole("tab", { name: "Invitations" }));
    expect(await screen.findByText("No invitations found")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("tab", { name: "Audit" }));
    expect(await screen.findByText("No audit events found")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Export CSV/i })).toHaveAttribute("href", "/api/audit/export");
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

    await userEvent.click(screen.getByRole("tab", { name: "Audit" }));
    await screen.findByText("No audit events found");
    expect(screen.queryByRole("link", { name: /Export CSV/i })).not.toBeInTheDocument();
  });
});
