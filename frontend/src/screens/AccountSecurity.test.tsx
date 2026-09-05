import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AccountSecurity } from "./AccountSecurity";

const apiMock = vi.hoisted(() => ({
  profile: vi.fn(),
  updateProfile: vi.fn(),
  changePassword: vi.fn(),
  setupMfa: vi.fn(),
  confirmMfa: vi.fn(),
  regenerateRecoveryCodes: vi.fn(),
  disableMfa: vi.fn(),
  sessions: vi.fn(),
  revokeSession: vi.fn(),
  signOutEverywhere: vi.fn(),
}));
const authMock = vi.hoisted(() => ({
  refreshSession: vi.fn(),
  logout: vi.fn(),
}));
const authState = vi.hoisted(() => ({
  platformAccess: null as null | { role: "SystemAdmin"; permissions: string[] },
  mfaEnabled: false,
}));

vi.mock("../lib/api", () => ({
  api: apiMock,
  ApiError: class ApiError extends Error {},
}));

vi.mock("../auth/AuthContext", () => ({
  useAuth: () => ({
    user: {
      id: "user-1",
      name: "Ada Admin",
      email: "ada@example.com",
      role: "Admin",
      status: "active",
      emailVerified: true,
      mfaEnabled: authState.mfaEnabled,
      mfaRequired: true,
      mfaEnrollmentRequired: !authState.mfaEnabled,
      mfaGraceEndsAt: "2026-08-02T09:00:00Z",
    },
    refreshSession: authMock.refreshSession,
    logout: authMock.logout,
    platformAccess: authState.platformAccess,
  }),
}));

const profile = {
  id: "user-1",
  name: "Ada Admin",
  email: "ada@example.com",
  pendingEmail: null,
  role: "Admin" as const,
  emailVerified: true,
  mfaEnabled: false,
  mfaRequired: true,
};

function renderAccount(props: Parameters<typeof AccountSecurity>[0] = {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <AccountSecurity {...props} />
    </QueryClientProvider>,
  );
}

describe("AccountSecurity", () => {
  beforeEach(() => {
    Object.values(apiMock).forEach((mock) => mock.mockReset());
    Object.values(authMock).forEach((mock) => mock.mockReset());
    apiMock.profile.mockResolvedValue({ user: profile });
    apiMock.sessions.mockResolvedValue({ results: [] });
    authMock.refreshSession.mockResolvedValue(undefined);
    authMock.logout.mockResolvedValue(undefined);
    authState.platformAccess = null;
    authState.mfaEnabled = false;
  });

  it("updates profile data and surfaces verified-email workflow", async () => {
    apiMock.updateProfile.mockResolvedValue({
      user: { ...profile, name: "Ada Okafor", pendingEmail: "new@example.com" },
      verificationRequired: true,
    });
    renderAccount();

    const name = await screen.findByLabelText(/Full name/);
    await userEvent.clear(name);
    await userEvent.type(name, "Ada Okafor");
    const email = screen.getByLabelText(/Email/);
    await userEvent.clear(email);
    await userEvent.type(email, "new@example.com");
    await userEvent.type(screen.getByLabelText(/Current password/), "profile password");
    await userEvent.click(screen.getByRole("button", { name: "Save profile" }));

    expect(apiMock.updateProfile).toHaveBeenCalledWith({
      name: "Ada Okafor",
      email: "new@example.com",
      currentPassword: "profile password",
    });
    expect(await screen.findByText(/Check your new email address/i)).toBeInTheDocument();
    expect(authMock.refreshSession).toHaveBeenCalledOnce();
  });

  it("labels platform access without presenting it as a tenant role", async () => {
    authState.platformAccess = { role: "SystemAdmin", permissions: [] };
    apiMock.profile.mockResolvedValue({ user: { ...profile, role: "Viewer" } });
    renderAccount();

    expect(await screen.findByText("System Administrator")).toBeInTheDocument();
    expect(screen.getByText(/controlled operator process/i)).toBeInTheDocument();
    expect(screen.queryByText(/another organization Admin/i)).not.toBeInTheDocument();
  });

  it("can open directly on MFA and put authenticator setup before password for enrollment", () => {
    authState.platformAccess = { role: "SystemAdmin", permissions: [] };
    renderAccount({ initialTab: "security", prioritizeMfa: true });

    expect(screen.getByRole("tab", { name: "Password & MFA" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("region", { name: "Authenticator app" })).toBeInTheDocument();
    expect(screen.queryByText("Profile", { selector: ".card-title" })).not.toBeInTheDocument();

    const panels = document.querySelectorAll(".account-grid > .account-panel");
    expect(panels).toHaveLength(2);
    expect(panels[0]).toHaveAttribute("aria-labelledby", "mfa-heading");
    expect(panels[1].tagName).toBe("FORM");
  });

  it("requires a current factor for recovery codes and hides platform MFA disable", async () => {
    authState.platformAccess = { role: "SystemAdmin", permissions: [] };
    authState.mfaEnabled = true;
    apiMock.regenerateRecoveryCodes.mockResolvedValue({ recoveryCodes: ["fresh-code"] });
    renderAccount();

    await userEvent.click(screen.getByRole("tab", { name: "Password & MFA" }));
    expect(screen.queryByRole("button", { name: "Disable MFA" })).not.toBeInTheDocument();
    expect(screen.getByText(/cannot be disabled in the product/i)).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText(/Current authenticator code/), "123456");
    await userEvent.click(screen.getByRole("button", { name: "New recovery codes" }));

    expect(apiMock.regenerateRecoveryCodes).toHaveBeenCalledWith("123456");
    expect(await screen.findByText("fresh-code")).toBeInTheDocument();
  });

  it("changes a password and completes authenticator enrollment", async () => {
    apiMock.changePassword.mockResolvedValue({ detail: "Password changed." });
    apiMock.setupMfa.mockResolvedValue({
      secret: "JBSWY3DPEHPK3PXP",
      provisioningUri: "otpauth://totp/VesselCaller:ada@example.com?secret=JBSWY3DPEHPK3PXP",
    });
    apiMock.confirmMfa.mockResolvedValue({ recoveryCodes: ["recovery-one", "recovery-two"] });
    renderAccount();

    await userEvent.click(screen.getByRole("tab", { name: "Password & MFA" }));
    const currentPasswordFields = screen.getAllByLabelText(/Current password/);
    await userEvent.type(currentPasswordFields[0], "old secure password");
    await userEvent.type(screen.getByLabelText(/^New password/), "new secure password");
    await userEvent.type(screen.getByLabelText(/Confirm new password/), "new secure password");
    await userEvent.click(screen.getByRole("button", { name: "Change password" }));
    expect(apiMock.changePassword).toHaveBeenCalledWith("old secure password", "new secure password");
    expect(await screen.findByText("Password changed.")).toBeInTheDocument();

    await userEvent.type(currentPasswordFields[1], "mfa setup password");
    await userEvent.click(screen.getByRole("button", { name: "Set up authenticator" }));
    expect(apiMock.setupMfa).toHaveBeenCalledWith("mfa setup password");
    expect(await screen.findByRole("link", { name: "Add to authenticator" })).toHaveAttribute(
      "href",
      expect.stringContaining("otpauth://"),
    );
    await userEvent.type(screen.getByLabelText(/Authenticator code/), "123456");
    await userEvent.click(screen.getByRole("button", { name: "Enable MFA" }));

    expect(apiMock.confirmMfa).toHaveBeenCalledWith("123456");
    expect(await screen.findByText("recovery-one")).toBeInTheDocument();
    expect(authMock.refreshSession).toHaveBeenCalledOnce();
  });

  it("lists devices, revokes a remote session, and signs out everywhere", async () => {
    apiMock.sessions.mockResolvedValue({
      results: [
        {
          id: "current",
          current: true,
          createdAt: "2026-07-26T08:00:00Z",
          lastSeenAt: "2026-07-26T10:00:00Z",
          expiresAt: "2026-08-25T08:00:00Z",
          ipAddress: "203.0.113.1",
          userAgent: "Chrome",
        },
        {
          id: "remote",
          current: false,
          createdAt: "2026-07-25T08:00:00Z",
          lastSeenAt: "2026-07-25T10:00:00Z",
          expiresAt: "2026-08-24T08:00:00Z",
          ipAddress: "198.51.100.2",
          userAgent: "Firefox",
        },
      ],
    });
    apiMock.revokeSession.mockResolvedValue(undefined);
    apiMock.signOutEverywhere.mockResolvedValue(undefined);
    renderAccount();

    await userEvent.click(screen.getByRole("tab", { name: "Sessions" }));
    expect(await screen.findByText("Firefox")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Revoke" }));
    expect(apiMock.revokeSession.mock.calls[0][0]).toBe("remote");

    await userEvent.click(screen.getByRole("button", { name: "Sign out everywhere" }));
    await waitFor(() => expect(apiMock.signOutEverywhere).toHaveBeenCalledOnce());
    expect(authMock.logout).toHaveBeenCalledOnce();
  });
});
