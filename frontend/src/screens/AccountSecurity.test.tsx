import type { ComponentProps } from "react";
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
const qrMock = vi.hoisted(() => ({ render: vi.fn() }));
const authState = vi.hoisted(() => ({
  platformAccess: null as null | { role: "SystemAdmin"; permissions: string[] },
  mfaEnabled: false,
}));

vi.mock("qrcode.react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("qrcode.react")>();
  return {
    ...actual,
    QRCodeSVG: (props: ComponentProps<typeof actual.QRCodeSVG>) => {
      qrMock.render(props);
      return <actual.QRCodeSVG {...props} />;
    },
  };
});

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
  const view = render(
    <QueryClientProvider client={client}>
      <AccountSecurity {...props} />
    </QueryClientProvider>,
  );
  return { ...view, client };
}

describe("AccountSecurity", () => {
  beforeEach(() => {
    qrMock.render.mockClear();
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

  it("guides setup using a locally rendered QR with the exact provisioning URI and manual fallback", async () => {
    const provisioningUri = "otpauth://totp/NPA%20Vessel%20Caller:ada%40example.com?secret=JBSWY3DPEHPK3PXP&issuer=NPA%20Vessel%20Caller";
    apiMock.setupMfa.mockResolvedValue({ secret: "JBSWY3DPEHPK3PXP", provisioningUri });
    const { client } = renderAccount({ guidedMfa: true });

    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Change password" })).not.toBeInTheDocument();
    expect(screen.getByText(/the new one you just chose/)).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText(/Current password/), "new private password");
    await userEvent.click(screen.getByRole("button", { name: "Set up authenticator" }));

    const qr = await screen.findByRole("img", { name: "Scan to add NPA Vessel Caller to your authenticator" });
    expect(qr.tagName.toLowerCase()).toBe("svg");
    expect(qr.querySelector("path")).toBeInTheDocument();
    expect(qr.querySelector("image")).toBeNull();
    expect(qrMock.render.mock.lastCall?.[0].value).toBe(provisioningUri);
    expect(screen.getByRole("link", { name: "Add to authenticator" })).toHaveAttribute("href", provisioningUri);
    await userEvent.click(screen.getByText("Can’t scan the QR code?"));
    expect(screen.getByText("JBSWY3DPEHPK3PXP")).toBeVisible();
    expect(screen.getByText("Time based")).toBeVisible();
    expect(screen.getByRole("button", { name: "Copy setup key" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Enable MFA" })).toBeDisabled();
    expect(client.getMutationCache().getAll()).toHaveLength(0);
  });

  it("preserves recovery codes across session refresh and requires saved-code acknowledgment before continuing", async () => {
    apiMock.setupMfa.mockResolvedValue({ secret: "PRIVATESEED", provisioningUri: "otpauth://totp/test?secret=PRIVATESEED" });
    apiMock.confirmMfa.mockResolvedValue({ recoveryCodes: ["private-recovery-one", "private-recovery-two"] });
    authMock.refreshSession.mockImplementation(async () => { authState.mfaEnabled = true; });
    const onComplete = vi.fn();
    const { client } = renderAccount({ guidedMfa: true, onMfaSetupComplete: onComplete });
    await userEvent.type(screen.getByLabelText(/Current password/), "current private password");
    await userEvent.click(screen.getByRole("button", { name: "Set up authenticator" }));
    await userEvent.type(await screen.findByLabelText(/Authenticator code/), "123456");
    await userEvent.click(screen.getByRole("button", { name: "Enable MFA" }));

    expect(await screen.findByRole("heading", { name: "Save your recovery codes" })).toBeInTheDocument();
    expect(screen.getByText("private-recovery-one")).toBeVisible();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(screen.queryByText("PRIVATESEED")).not.toBeInTheDocument();
    expect(authMock.refreshSession).toHaveBeenCalledOnce();
    const continueButton = screen.getByRole("button", { name: "Continue to workspace" });
    expect(continueButton).toBeDisabled();
    await userEvent.click(continueButton);
    expect(onComplete).not.toHaveBeenCalled();
    expect(client.getMutationCache().getAll()).toHaveLength(0);
    await userEvent.click(screen.getByRole("checkbox", { name: "I have saved my recovery codes" }));
    await userEvent.click(continueButton);
    expect(onComplete).toHaveBeenCalledOnce();
    expect(screen.queryByText("private-recovery-one")).not.toBeInTheDocument();
  });

  it("keeps enrollment retryable after setup or code failure without replacing a successful seed", async () => {
    const { ApiError } = await import("../lib/api");
    apiMock.setupMfa.mockRejectedValueOnce(new ApiError("Password was not accepted", 400)).mockResolvedValueOnce({ secret: "PRIVATESEED", provisioningUri: "otpauth://totp/test?secret=PRIVATESEED" });
    apiMock.confirmMfa.mockRejectedValueOnce(new ApiError("Code has expired", 400)).mockResolvedValueOnce({ recoveryCodes: ["safe-recovery-code"] });
    renderAccount({ guidedMfa: true });
    await userEvent.type(screen.getByLabelText(/Current password/), "private password");
    await userEvent.click(screen.getByRole("button", { name: "Set up authenticator" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Password was not accepted");
    await userEvent.click(screen.getByRole("button", { name: "Set up authenticator" }));
    const codeInput = await screen.findByLabelText(/Authenticator code/);
    await userEvent.type(codeInput, "123456");
    await userEvent.click(screen.getByRole("button", { name: "Enable MFA" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Code has expired");
    expect(screen.getByRole("img")).toBeVisible();
    await userEvent.clear(codeInput);
    await userEvent.type(codeInput, "654321");
    await userEvent.click(screen.getByRole("button", { name: "Enable MFA" }));
    expect(await screen.findByText("safe-recovery-code")).toBeInTheDocument();
    expect(apiMock.setupMfa).toHaveBeenCalledTimes(2);
    expect(apiMock.confirmMfa).toHaveBeenLastCalledWith("654321");
  });

  it("retries only the account refresh if enrollment already succeeded", async () => {
    apiMock.setupMfa.mockResolvedValue({ secret: "PRIVATESEED", provisioningUri: "otpauth://totp/test?secret=PRIVATESEED" });
    apiMock.confirmMfa.mockResolvedValue({ recoveryCodes: ["preserved-recovery-code"] });
    authMock.refreshSession.mockRejectedValueOnce(new Error("Network unavailable")).mockResolvedValueOnce(undefined);
    const onComplete = vi.fn();
    renderAccount({ guidedMfa: true, onMfaSetupComplete: onComplete });
    await userEvent.type(screen.getByLabelText(/Current password/), "current password");
    await userEvent.click(screen.getByRole("button", { name: "Set up authenticator" }));
    await userEvent.type(await screen.findByLabelText(/Authenticator code/), "123456");
    await userEvent.click(screen.getByRole("button", { name: "Enable MFA" }));
    expect(await screen.findByRole("button", { name: "Retry account refresh" })).toBeInTheDocument();
    expect(screen.getByText("preserved-recovery-code")).toBeVisible();
    await userEvent.click(screen.getByRole("checkbox", { name: "I have saved my recovery codes" }));
    expect(screen.getByRole("button", { name: "Continue to workspace" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Retry account refresh" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Continue to workspace" })).toBeEnabled());
    expect(apiMock.confirmMfa).toHaveBeenCalledOnce();
    expect(screen.getByText("preserved-recovery-code")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Continue to workspace" }));
    expect(onComplete).toHaveBeenCalledOnce();
  });

  it("prevents duplicate setup and confirmation requests and clears a cancelled seed", async () => {
    let resolveSetup!: (value: { secret: string; provisioningUri: string }) => void;
    let resolveConfirm!: (value: { recoveryCodes: string[] }) => void;
    apiMock.setupMfa.mockReturnValue(new Promise((resolve) => { resolveSetup = resolve; }));
    apiMock.confirmMfa.mockReturnValue(new Promise((resolve) => { resolveConfirm = resolve; }));
    renderAccount({ guidedMfa: true });
    await userEvent.type(screen.getByLabelText(/Current password/), "current password");
    await userEvent.dblClick(screen.getByRole("button", { name: "Set up authenticator" }));
    expect(apiMock.setupMfa).toHaveBeenCalledOnce();
    resolveSetup({ secret: "cancelled-seed", provisioningUri: "otpauth://totp/test?secret=cancelled-seed" });
    await screen.findByRole("img");
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByText("cancelled-seed")).not.toBeInTheDocument();
    expect(screen.getByLabelText(/Current password/)).toHaveValue("");
    await userEvent.type(screen.getByLabelText(/Current password/), "current password");
    await userEvent.click(screen.getByRole("button", { name: "Set up authenticator" }));
    await userEvent.type(await screen.findByLabelText(/Authenticator code/), "123456");
    await userEvent.dblClick(screen.getByRole("button", { name: "Enable MFA" }));
    expect(apiMock.confirmMfa).toHaveBeenCalledOnce();
    resolveConfirm({ recoveryCodes: ["only-once"] });
    expect(await screen.findByText("only-once")).toBeInTheDocument();
  });

  it("discards an outstanding setup result after leaving the screen", async () => {
    let resolveSetup!: (value: { secret: string; provisioningUri: string }) => void;
    apiMock.setupMfa.mockReturnValue(new Promise((resolve) => { resolveSetup = resolve; }));
    const first = renderAccount({ guidedMfa: true });
    await userEvent.type(screen.getByLabelText(/Current password/), "current password");
    await userEvent.click(screen.getByRole("button", { name: "Set up authenticator" }));
    first.unmount();
    resolveSetup({ secret: "discarded-seed", provisioningUri: "otpauth://totp/test?secret=discarded-seed" });
    renderAccount({ guidedMfa: true });
    await waitFor(() => expect(screen.getByRole("button", { name: "Set up authenticator" })).toBeInTheDocument());
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(screen.queryByText("discarded-seed")).not.toBeInTheDocument();
    expect(first.client.getMutationCache().getAll()).toHaveLength(0);
  });

  it("lets an already-enrolled user continue without claiming new recovery codes were saved", async () => {
    authState.mfaEnabled = true;
    const onComplete = vi.fn();
    renderAccount({ guidedMfa: true, onMfaSetupComplete: onComplete });
    expect(screen.getByText("Authenticator already enabled")).toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Set up authenticator" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Continue to workspace" }));
    expect(onComplete).toHaveBeenCalledOnce();
    expect(apiMock.setupMfa).not.toHaveBeenCalled();
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
