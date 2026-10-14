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
  createTemporaryPasswordUser: vi.fn(),
  regenerateTemporaryPassword: vi.fn(),
  updateUser: vi.fn(),
  removeUser: vi.fn(),
  sendUserPasswordReset: vi.fn(),
  resetUserMfa: vi.fn(),
  resendInvitation: vi.fn(),
  revokeInvitation: vi.fn(),
}));
const authMock = vi.hoisted(() => ({
  can: vi.fn<(permission: string) => boolean>(),
  userId: "admin-1",
}));

vi.mock("./OrganizationAccess", () => ({ OrganizationAccess: () => <div>Organization sign-up controls</div> }));

vi.mock("../lib/api", () => ({
  api: apiMock,
  ApiError: class ApiError extends Error {
    status: number;
    errors: Record<string, string[] | string>;
    constructor(message: string, status: number, errors: Record<string, string[] | string> = {}) {
      super(message);
      this.status = status;
      this.errors = errors;
    }
  },
}));

vi.mock("../auth/AuthContext", () => ({
  useAuth: () => ({
    user: {
      id: authMock.userId,
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
  return { ...view, client, rerenderManagement: () => view.rerender(<QueryClientProvider client={client}><UserManagement /></QueryClientProvider>) };
}

async function openInvitation() {
  await userEvent.click(screen.getByRole("button", { name: "Add user" }));
  await userEvent.click(screen.getByRole("radio", { name: /Email invitation/ }));
}

describe("UserManagement", () => {
  beforeEach(() => {
    Object.values(apiMock).forEach((mock) => {
      if ("mockReset" in mock) mock.mockReset();
    });
    apiMock.auditExportUrl.mockReturnValue("/api/audit/export");
    authMock.userId = "admin-1";
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
    await openInvitation();

    expect(screen.getByRole("dialog", { name: "Add user" })).toBeInTheDocument();
    expect(screen.getByText(/recipient chooses their own password/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/^Password$/i)).not.toBeInTheDocument();
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
    expect(screen.queryByRole("button", { name: "Add user" })).not.toBeInTheDocument();
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
    await openInvitation();
    expect(screen.getAllByRole("dialog", { name: "Add user" })).toHaveLength(1);
    expect(screen.getByText(/This role applies across the organization/i)).toBeInTheDocument();
    expect(screen.getByLabelText("Role")).toHaveValue("Operations");
  });

  it("submits a normalized invitation and shows its pending list after success", async () => {
    apiMock.inviteUser.mockResolvedValue(invitationFixture);
    apiMock.invitations.mockResolvedValue({ results: [invitationFixture], count: 1, page: 1, pageSize: 20 });
    renderManagement();
    await openInvitation();
    await userEvent.type(screen.getByLabelText(/Full name/), "  Ola Operations  ");
    await userEvent.type(screen.getByLabelText(/^Email\*?$/), "OLA@EXAMPLE.COM");
    await userEvent.click(screen.getByRole("button", { name: "Send invitation" }));

    await waitFor(() => expect(apiMock.inviteUser).toHaveBeenCalledExactlyOnceWith({ name: "Ola Operations", email: "ola@example.com", role: "Operations" }));
    expect(await screen.findByText("Invitation created")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Invitations" })).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByRole("dialog", { name: "Add user" })).not.toBeInTheDocument();
    expect(await screen.findAllByText("Ola Operations")).not.toHaveLength(0);
    expect(screen.queryByText(/invitation (was )?sent|email delivered/i)).not.toBeInTheDocument();
  });

  it("requires a valid email before invoking the invitation API", async () => {
    renderManagement();
    await openInvitation();
    await userEvent.type(screen.getByLabelText(/Full name/), "Ola Operations");
    const email = screen.getByLabelText(/^Email\*?$/);
    await userEvent.type(email, "not-an-email");
    expect(email).toBeInvalid();
    await userEvent.click(screen.getByRole("button", { name: "Send invitation" }));
    fireEvent.submit(screen.getByRole("form", { name: "New user details" }));
    expect(apiMock.inviteUser).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Add user" })).toBeInTheDocument();
  });

  it("blocks repeated submissions and keeps the form open while pending", async () => {
    let complete: (value: Invitation) => void = () => undefined;
    apiMock.inviteUser.mockReturnValue(new Promise<Invitation>((resolve) => { complete = resolve; }));
    renderManagement();
    await openInvitation();
    await userEvent.type(screen.getByLabelText(/Full name/), "Ola Operations");
    await userEvent.type(screen.getByLabelText(/^Email\*?$/), "ola@example.com");
    await userEvent.click(screen.getByRole("button", { name: "Send invitation" }));
    fireEvent.submit(screen.getByRole("form", { name: "New user details" }));
    expect(screen.getByRole("button", { name: "Creating invitation…" })).toBeDisabled();
    expect(screen.getByLabelText(/^Email\*?$/)).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.getByRole("dialog", { name: "Add user" })).toBeInTheDocument();
    expect(apiMock.inviteUser).toHaveBeenCalledTimes(1);
    complete(invitationFixture);
    expect(await screen.findByText("Invitation created")).toBeInTheDocument();
  });

  it("preserves entered data and shows the API error when an invitation fails", async () => {
    apiMock.inviteUser.mockRejectedValue(new ApiError("An invitation already exists for this email.", 409));
    renderManagement();
    await openInvitation();
    await userEvent.type(screen.getByLabelText(/Full name/), "Ola Operations");
    await userEvent.type(screen.getByLabelText(/^Email\*?$/), "ola@example.com");
    await userEvent.selectOptions(screen.getByLabelText("Role"), "Finance");
    await userEvent.click(screen.getByRole("button", { name: "Send invitation" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("An invitation already exists for this email.");
    expect(screen.getByLabelText(/Full name/)).toHaveValue("Ola Operations");
    expect(screen.getByLabelText(/^Email\*?$/)).toHaveValue("ola@example.com");
    expect(screen.getByLabelText("Role")).toHaveValue("Finance");
    expect(screen.getByRole("button", { name: "Send invitation" })).toBeEnabled();
    expect(screen.queryByText("Invitation created")).not.toBeInTheDocument();
  });

  it("does not fetch or offer invitation actions without user-view permission", () => {
    authMock.can.mockReturnValue(false);
    renderManagement();
    expect(screen.getByText("User management is unavailable")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add user" })).not.toBeInTheDocument();
    expect(apiMock.users).not.toHaveBeenCalled();
    expect(apiMock.roleDefinitions).not.toHaveBeenCalled();
    expect(apiMock.invitations).not.toHaveBeenCalled();
  });

  it("directs an invitation for an already loaded colleague back to their existing user access", async () => {
    apiMock.users.mockResolvedValue({ results: [userFixture], count: 1, page: 1, pageSize: 20 });
    renderManagement();
    await screen.findAllByText("Grace Finance");
    await userEvent.click(screen.getByRole("tab", { name: "Invitations" }));
    await openInvitation();
    await userEvent.type(screen.getByLabelText(/Full name/), "Grace Finance");
    await userEvent.type(screen.getByLabelText(/^Email\*?$/), "GRACE@EXAMPLE.COM");
    expect(screen.getByText(/already belongs to a user in your organization/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send invitation" })).toBeDisabled();
    fireEvent.submit(screen.getByRole("form", { name: "New user details" }));
    expect(apiMock.inviteUser).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Review existing users" }));
    expect(screen.queryByRole("dialog", { name: "Add user" })).not.toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Users" })).toHaveAttribute("aria-selected", "true");
  });

  it("keeps invitation actions read-only without user-management permission", async () => {
    authMock.can.mockImplementation((permission) => permission === "users.view");
    apiMock.invitations.mockResolvedValue({ results: [invitationFixture], count: 1, page: 1, pageSize: 20 });
    renderManagement();
    expect(screen.queryByRole("tab", { name: "Activity" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("tab", { name: "Invitations" }));
    expect((await screen.findAllByRole("button", { name: "Resend" }))[0]).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Add user" })).not.toBeInTheDocument();
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
  it("shows the generated-password slot before creation without accepting a manual password", async () => {
    renderManagement();
    await userEvent.click(screen.getByRole("button", { name: "Add user" }));
    const password = screen.getByLabelText("Temporary password");
    expect(password).toHaveAttribute("readonly");
    expect(password).toHaveAttribute("placeholder", "Generated when you create this user");
    expect(password).toHaveValue("");
    await userEvent.type(password, "manual-password");
    expect(password).toHaveValue("");
    expect(apiMock.createTemporaryPasswordUser).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("radio", { name: /Email invitation/ }));
    expect(screen.queryByLabelText("Temporary password")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("radio", { name: /Temporary password/ }));
    expect(screen.getByLabelText("Temporary password")).toHaveValue("");
  });

  it("creates a user with a visible one-time password to copy without caching or sending an invitation", async () => {
    const user = userEvent.setup();
    const credential = "fixture-temporary-password-42";
    apiMock.createTemporaryPasswordUser.mockResolvedValue({ user: { ...userFixture, passwordChangeRequired: true }, rev: 2, temporaryPassword: credential, temporaryPasswordExpiresAt: "2026-10-20T10:00:00Z", signInUrl: "https://staging.vesselcalls.com/login?organizationId=org-1" });
    const view = renderManagement();
    await userEvent.click(screen.getByRole("button", { name: "Add user" }));
    expect(screen.getByRole("radio", { name: /Temporary password/ })).toBeChecked();
    await userEvent.type(screen.getByLabelText(/Full name/), " Grace Finance ");
    await userEvent.type(screen.getByLabelText(/^Email\*?$/), "GRACE@EXAMPLE.COM");
    await userEvent.selectOptions(screen.getByLabelText("Role"), "Finance");
    await userEvent.click(screen.getByRole("button", { name: "Create user" }));
    expect(await screen.findByRole("dialog", { name: "User ready to sign in" })).toBeInTheDocument();
    expect(apiMock.createTemporaryPasswordUser).toHaveBeenCalledExactlyOnceWith({ name: "Grace Finance", email: "grace@example.com", role: "Finance" });
    expect(apiMock.inviteUser).not.toHaveBeenCalled();
    const password = screen.getByLabelText("Temporary password");
    expect(password).toHaveAttribute("type", "text");
    expect(password).toHaveAttribute("readonly");
    expect(password).toHaveValue(credential);
    expect(screen.getByLabelText("Sign-in page")).toHaveValue("https://staging.vesselcalls.com/login?organizationId=org-1");
    expect(within(screen.getByRole("dialog", { name: "User ready to sign in" })).getByText("NPA Test Organization")).toBeInTheDocument();
    expect(JSON.stringify(view.client.getQueryCache().getAll().map((query) => query.state.data))).not.toContain(credential);
    expect(JSON.stringify(view.client.getMutationCache().getAll().map((mutation) => mutation.state.data))).not.toContain(credential);
    expect(window.location.href).not.toContain(credential);
    await userEvent.click(screen.getByRole("button", { name: "Hide password" }));
    expect(password).toHaveAttribute("type", "password");
    await userEvent.click(screen.getByRole("button", { name: "Show password" }));
    expect(password).toHaveAttribute("type", "text");
    const clipboard = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    await user.click(screen.getByRole("button", { name: "Copy password" }));
    expect(clipboard).toHaveBeenLastCalledWith(credential);
    expect(await screen.findByText("Temporary password copied. Share it directly with this user.")).toBeInTheDocument();
    expect(screen.getAllByRole("status").every((element) => !element.textContent?.includes(credential))).toBe(true);
    await user.click(screen.getByRole("button", { name: "Copy sign-in details" }));
    expect(clipboard).toHaveBeenLastCalledWith(expect.stringContaining(`Temporary password: ${credential}`));
    expect(clipboard).toHaveBeenLastCalledWith(expect.stringContaining("Sign in: https://staging.vesselcalls.com/login?organizationId=org-1"));
    expect(clipboard).toHaveBeenLastCalledWith(expect.stringContaining("Organization: NPA Test Organization"));
    expect(screen.getByText("Sign-in details copied. Share them directly with this user.")).toBeInTheDocument();
    expect(screen.getAllByRole("status").every((element) => !element.textContent?.includes(credential))).toBe(true);
    await userEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.queryByLabelText("Temporary password")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Add user" }));
    expect(screen.queryByRole("dialog", { name: "User ready to sign in" })).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue(credential)).not.toBeInTheDocument();
  });

  it("clears the one-time password when the authenticated identity changes", async () => {
    apiMock.createTemporaryPasswordUser.mockResolvedValue({ user: userFixture, rev: 2, temporaryPassword: "fixture-credential-only", temporaryPasswordExpiresAt: "2026-10-20T10:00:00Z", signInUrl: "https://staging.vesselcalls.com/login" });
    const view = renderManagement();
    await userEvent.click(screen.getByRole("button", { name: "Add user" }));
    await userEvent.type(screen.getByLabelText(/Full name/), "Grace Finance");
    await userEvent.type(screen.getByLabelText(/^Email\*?$/), "grace@example.com");
    await userEvent.click(screen.getByRole("button", { name: "Create user" }));
    await screen.findByRole("dialog", { name: "User ready to sign in" });
    authMock.userId = "admin-2";
    view.rerenderManagement();
    expect(screen.getByLabelText("Temporary password")).toHaveValue("");
    expect(screen.queryByDisplayValue("fixture-credential-only")).not.toBeInTheDocument();
  });

  it("prevents duplicate temporary-password creation and preserves input after a server conflict", async () => {
    let reject!: (error: Error) => void;
    apiMock.createTemporaryPasswordUser.mockReturnValue(new Promise((_, rejectPromise) => { reject = rejectPromise; }));
    renderManagement();
    await userEvent.click(screen.getByRole("button", { name: "Add user" }));
    await userEvent.type(screen.getByLabelText(/Full name/), "Grace Finance");
    await userEvent.type(screen.getByLabelText(/^Email\*?$/), "grace@example.com");
    await userEvent.click(screen.getByRole("button", { name: "Create user" }));
    fireEvent.submit(screen.getByRole("form", { name: "New user details" }));
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.getByRole("dialog", { name: "Add user" })).toBeInTheDocument();
    expect(apiMock.createTemporaryPasswordUser).toHaveBeenCalledTimes(1);
    reject(new ApiError("This email already belongs to an account.", 409));
    expect(await screen.findByRole("alert")).toHaveTextContent("This email already belongs to an account.");
    expect(screen.getByLabelText(/^Email\*?$/)).toHaveValue("grace@example.com");
    expect(screen.getByRole("button", { name: "Create user" })).toBeEnabled();
  });

  it("replaces a pending email invitation only after explicit confirmation in the same form", async () => {
    apiMock.createTemporaryPasswordUser
      .mockRejectedValueOnce(new ApiError("The request could not be completed", 409, { code: "pending_invitation", email: ["An email invitation is pending."] }))
      .mockResolvedValueOnce({ user: { ...userFixture, role: "Admin", passwordChangeRequired: true }, rev: 2, temporaryPassword: "fixture-converted-password", temporaryPasswordExpiresAt: "2026-10-20T10:00:00Z", signInUrl: "https://staging.vesselcalls.com/login" });
    const view = renderManagement();
    const invalidate = vi.spyOn(view.client, "invalidateQueries");
    await userEvent.click(screen.getByRole("button", { name: "Add user" }));
    await userEvent.type(screen.getByLabelText(/Full name/), "Grace Finance");
    await userEvent.type(screen.getByLabelText(/^Email\*?$/), "grace@example.com");
    await userEvent.selectOptions(screen.getByLabelText("Role"), "Admin");
    await userEvent.click(screen.getByRole("button", { name: "Create user" }));
    const replace = await screen.findByRole("checkbox", { name: "Replace pending invitation" });
    expect(replace).not.toBeChecked();
    expect(screen.getByText(/old email invitation will stop working/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Full name/)).toHaveValue("Grace Finance");
    expect(screen.getByLabelText("Role")).toHaveValue("Admin");
    expect(screen.getByRole("button", { name: "Create user" })).toBeDisabled();
    fireEvent.submit(screen.getByRole("form", { name: "New user details" }));
    expect(apiMock.createTemporaryPasswordUser).toHaveBeenCalledTimes(1);
    expect(apiMock.createTemporaryPasswordUser).toHaveBeenNthCalledWith(1, { name: "Grace Finance", email: "grace@example.com", role: "Admin" });
    await userEvent.click(replace);
    await userEvent.click(screen.getByRole("button", { name: "Create user" }));
    expect(await screen.findByRole("dialog", { name: "User ready to sign in" })).toBeInTheDocument();
    expect(apiMock.createTemporaryPasswordUser).toHaveBeenNthCalledWith(2, { name: "Grace Finance", email: "grace@example.com", role: "Admin", replacePendingInvitation: true });
    expect(screen.getByLabelText("Temporary password")).toHaveValue("fixture-converted-password");
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["invitations"] });
    expect(apiMock.inviteUser).not.toHaveBeenCalled();
  });

  it.each(["email", "sign-in method"])("clears pending-invitation consent when the %s changes", async (changedField) => {
    apiMock.createTemporaryPasswordUser.mockRejectedValueOnce(new ApiError("The request could not be completed", 409, { code: "pending_invitation" }));
    renderManagement();
    await userEvent.click(screen.getByRole("button", { name: "Add user" }));
    await userEvent.type(screen.getByLabelText(/Full name/), "Grace Finance");
    await userEvent.type(screen.getByLabelText(/^Email\*?$/), "grace@example.com");
    await userEvent.click(screen.getByRole("button", { name: "Create user" }));
    await userEvent.click(await screen.findByRole("checkbox", { name: "Replace pending invitation" }));
    if (changedField === "email") {
      await userEvent.clear(screen.getByLabelText(/^Email\*?$/));
      await userEvent.type(screen.getByLabelText(/^Email\*?$/), "new@example.com");
    } else {
      await userEvent.click(screen.getByRole("radio", { name: /Email invitation/ }));
      await userEvent.click(screen.getByRole("radio", { name: /Temporary password/ }));
    }
    expect(screen.queryByRole("checkbox", { name: "Replace pending invitation" })).not.toBeInTheDocument();
    apiMock.createTemporaryPasswordUser.mockRejectedValueOnce(new ApiError("Could not create user", 400));
    await userEvent.click(screen.getByRole("button", { name: "Create user" }));
    expect(apiMock.createTemporaryPasswordUser).toHaveBeenLastCalledWith({ name: "Grace Finance", email: changedField === "email" ? "new@example.com" : "grace@example.com", role: "Operations" });
  });

  it.each([400, 409])("never offers invitation replacement for a generic %i account conflict", async (status) => {
    apiMock.createTemporaryPasswordUser.mockRejectedValue(new ApiError("A user or pending request already exists", status));
    renderManagement();
    await userEvent.click(screen.getByRole("button", { name: "Add user" }));
    await userEvent.type(screen.getByLabelText(/Full name/), "Grace Finance");
    await userEvent.type(screen.getByLabelText(/^Email\*?$/), "grace@example.com");
    await userEvent.click(screen.getByRole("button", { name: "Create user" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("A user or pending request already exists");
    expect(screen.queryByRole("checkbox", { name: "Replace pending invitation" })).not.toBeInTheDocument();
    expect(apiMock.createTemporaryPasswordUser).toHaveBeenCalledExactlyOnceWith({ name: "Grace Finance", email: "grace@example.com", role: "Operations" });
  });

  it("retains the visible password for manual copying if clipboard access fails", async () => {
    const user = userEvent.setup();
    apiMock.createTemporaryPasswordUser.mockResolvedValue({ user: userFixture, rev: 2, temporaryPassword: "fixture-copy-password", temporaryPasswordExpiresAt: "2026-10-20T10:00:00Z", signInUrl: "https://staging.vesselcalls.com/login" });
    renderManagement();
    await userEvent.click(screen.getByRole("button", { name: "Add user" }));
    await userEvent.type(screen.getByLabelText(/Full name/), "Grace Finance");
    await userEvent.type(screen.getByLabelText(/^Email\*?$/), "grace@example.com");
    await userEvent.click(screen.getByRole("button", { name: "Create user" }));
    await screen.findByRole("dialog", { name: "User ready to sign in" });
    vi.spyOn(navigator.clipboard, "writeText").mockRejectedValueOnce(new Error("Clipboard unavailable"));
    await user.click(screen.getByRole("button", { name: "Copy password" }));
    expect(await screen.findByText("Could not copy automatically. Select and copy the sign-in fields above.")).toBeInTheDocument();
    expect(screen.getByLabelText("Temporary password")).toHaveValue("fixture-copy-password");
    expect(screen.getByLabelText("Temporary password")).toHaveAttribute("type", "text");
    expect(screen.getAllByRole("status").every((element) => !element.textContent?.includes("fixture-copy-password"))).toBe(true);
  });

  it("regenerates only a pending temporary account and clears the replacement when closed", async () => {
    const pendingMember = { ...userFixture, adminProvisioned: true, passwordChangeRequired: true, temporaryPasswordExpiresAt: "2020-01-01T00:00:00Z" };
    apiMock.users.mockResolvedValue({ results: [pendingMember], count: 1, page: 1, pageSize: 20 });
    apiMock.regenerateTemporaryPassword.mockResolvedValue({ user: pendingMember, rev: 2, temporaryPassword: "fixture-replacement-credential", temporaryPasswordExpiresAt: "2026-10-20T10:00:00Z", signInUrl: "https://staging.vesselcalls.com/login" });
    const view = renderManagement();
    await userEvent.click(await screen.findByRole("button", { name: "Edit Grace Finance" }));
    expect(screen.queryByRole("button", { name: "Send password reset" })).not.toBeInTheDocument();
    expect(within(screen.getByRole("dialog")).getByText("Temporary password expired")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Generate new temporary password" }));
    expect(await screen.findByRole("dialog", { name: "User ready to sign in" })).toBeInTheDocument();
    expect(screen.getByLabelText("Temporary password")).toHaveValue("fixture-replacement-credential");
    expect(apiMock.regenerateTemporaryPassword).toHaveBeenCalledExactlyOnceWith("user-2");
    expect(apiMock.sendUserPasswordReset).not.toHaveBeenCalled();
    expect(JSON.stringify(view.client.getMutationCache().getAll().map((mutation) => mutation.state.data))).not.toContain("fixture-replacement-credential");
    await userEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.queryByLabelText("Temporary password")).not.toBeInTheDocument();
  });

  it("keeps activated users on the existing password-reset flow without offering temporary regeneration", async () => {
    apiMock.users.mockResolvedValue({ results: [{ ...userFixture, adminProvisioned: true, passwordChangeRequired: false }], count: 1, page: 1, pageSize: 20 });
    renderManagement();
    await userEvent.click(await screen.findByRole("button", { name: "Edit Grace Finance" }));
    expect(screen.getByRole("button", { name: "Send password reset" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Generate new temporary password" })).not.toBeInTheDocument();
    expect(apiMock.regenerateTemporaryPassword).not.toHaveBeenCalled();
  });

  it("clears regenerated credentials when the Admin identity changes", async () => {
    const pendingMember = { ...userFixture, adminProvisioned: true, passwordChangeRequired: true };
    apiMock.users.mockResolvedValue({ results: [pendingMember], count: 1, page: 1, pageSize: 20 });
    apiMock.regenerateTemporaryPassword.mockResolvedValue({ user: pendingMember, rev: 2, temporaryPassword: "fixture-replacement-credential", temporaryPasswordExpiresAt: "2026-10-20T10:00:00Z", signInUrl: "https://staging.vesselcalls.com/login" });
    const view = renderManagement();
    await userEvent.click(await screen.findByRole("button", { name: "Edit Grace Finance" }));
    await userEvent.click(screen.getByRole("button", { name: "Generate new temporary password" }));
    await screen.findByLabelText("Temporary password");
    authMock.userId = "admin-2";
    view.rerenderManagement();
    expect(screen.queryByLabelText("Temporary password")).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue("fixture-replacement-credential")).not.toBeInTheDocument();
  });

  it("blocks repeated regeneration and retains the pending user after an API conflict", async () => {
    const pendingMember = { ...userFixture, adminProvisioned: true, passwordChangeRequired: true };
    apiMock.users.mockResolvedValue({ results: [pendingMember], count: 1, page: 1, pageSize: 20 });
    let reject!: (error: Error) => void;
    apiMock.regenerateTemporaryPassword.mockReturnValue(new Promise((_, rejectPromise) => { reject = rejectPromise; }));
    renderManagement();
    await userEvent.click(await screen.findByRole("button", { name: "Edit Grace Finance" }));
    await userEvent.click(screen.getByRole("button", { name: "Generate new temporary password" }));
    await userEvent.click(screen.getByRole("button", { name: "Generating temporary password…" }));
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.getByRole("dialog", { name: "Edit user" })).toBeInTheDocument();
    expect(apiMock.regenerateTemporaryPassword).toHaveBeenCalledTimes(1);
    reject(new ApiError("This user has already completed first sign-in.", 409));
    expect(await screen.findByRole("alert")).toHaveTextContent("already completed first sign-in");
    expect(screen.queryByLabelText("Temporary password")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Generate new temporary password" })).toBeEnabled();
  });

});
