import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthSession } from "../types";
import { AuthPage } from "./AuthPage";
import { ApiError } from "../lib/api";

const authMock = vi.hoisted(() => ({
  login: vi.fn(),
  register: vi.fn(),
  verifyMfa: vi.fn(),
  status: "anonymous",
}));

const tenantSession: AuthSession = {
  user: {
    id: "user-1", name: "Ada Admin", email: "ada@example.com", role: "Admin",
    status: "active", emailVerified: true, mfaEnabled: true, mfaRequired: true,
  },
  org: {
    id: "org-1", registered: true, name: "Ada Marine", rcNumber: "", email: "ada@example.com",
    phone: "", address: "", designatedPort: "Port of Calabar", primaryPort: "Port of Calabar",
    ports: ["Port of Calabar"], logo: null, rev: 1,
  },
  permissions: [],
};

const platformSession: AuthSession = {
  ...tenantSession,
  org: null,
  permissions: [],
  platformAccess: {
    role: "SystemAdmin",
    permissions: ["platform.organizations.view"],
    mfaEnrollmentRequired: false,
  },
};

vi.mock("../auth/AuthContext", () => ({
  useAuth: () => authMock,
}));

describe("AuthPage", () => {
  beforeEach(() => {
    authMock.login.mockReset();
    authMock.register.mockReset();
    authMock.verifyMfa.mockReset();
    authMock.status = "anonymous";
    window.history.replaceState(null, "", "/login");
  });

  it("moves a session login into the MFA challenge without demo credentials", async () => {
    authMock.login.mockResolvedValue({ mfaRequired: true, challengeId: "challenge-1" });
    render(<AuthPage mode="login" />);

    expect(screen.queryByText(/demo credentials/i)).not.toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Email"), "admin@example.com");
    await userEvent.type(screen.getByLabelText("Password"), "a valid password");
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByRole("heading", { name: "Two-factor verification" })).toBeInTheDocument();
    expect(screen.getByLabelText("Verification code")).toHaveAttribute("autocomplete", "one-time-code");
  });

  it("keeps a new organization pending until email verification", async () => {
    authMock.register.mockResolvedValue({ detail: "Check your inbox.", approvalRequired: true });
    render(<AuthPage mode="register" />);

    await userEvent.type(screen.getByLabelText("Your name"), "Ada Admin");
    await userEvent.type(screen.getByLabelText("Organization name"), "Ada Marine");
    await userEvent.type(screen.getByLabelText("Email"), "ada@example.com");
    await userEvent.type(screen.getByLabelText("Password"), "a secure password");
    await userEvent.click(screen.getByRole("button", { name: "Create organization" }));

    expect(await screen.findByRole("heading", { name: "Verify your email" })).toBeInTheDocument();
    expect(screen.getByText("Check your inbox.")).toBeInTheDocument();
    expect(screen.getByText(/must approve your organization before anyone can sign in/i)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Continue to sign in" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Return to home" })).toHaveAttribute("href", "/");
  });

  it("redirects only after the authenticated state has committed", async () => {
    authMock.login.mockResolvedValue(tenantSession);
    const view = render(<AuthPage mode="login" />);

    await userEvent.type(screen.getByLabelText("Email"), "operations@example.com");
    await userEvent.type(screen.getByLabelText("Password"), "a valid password");
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(window.location.pathname).toBe("/login");

    authMock.status = "authenticated";
    view.rerender(<AuthPage mode="login" />);

    await vi.waitFor(() => expect(window.location.pathname).toBe("/app"));
  });

  it.each(["/app/measurements", "/capture"])("routes overdue customer MFA to enrollment before restoring %s", async (from) => {
    window.history.replaceState({ from }, "", "/login");
    authMock.login.mockResolvedValue({
      ...tenantSession,
      user: { ...tenantSession.user, mfaEnabled: false, mfaEnrollmentRequired: true },
    });
    const view = render(<AuthPage mode="login" />);
    await userEvent.type(screen.getByLabelText("Email"), "admin@example.com");
    await userEvent.type(screen.getByLabelText("Password"), "a valid password");
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));

    authMock.status = "authenticated";
    view.rerender(<AuthPage mode="login" />);
    await vi.waitFor(() => expect(window.location.pathname).toBe("/app/account"));
  });

  it("routes a password-only platform login to mandatory MFA enrollment and ignores a tenant return path", async () => {
    window.history.replaceState({ from: "/app/users" }, "", "/login");
    authMock.login.mockResolvedValue({
      ...platformSession,
      platformAccess: {
        ...platformSession.platformAccess!,
        permissions: [],
        mfaEnrollmentRequired: true,
      },
    });
    const view = render(<AuthPage mode="login" />);

    await userEvent.type(screen.getByLabelText("Email"), "system@example.com");
    await userEvent.type(screen.getByLabelText("Password"), "a valid password");
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(window.location.pathname).toBe("/login");

    authMock.status = "authenticated";
    view.rerender(<AuthPage mode="login" />);
    await vi.waitFor(() => expect(window.location.pathname).toBe("/system/account"));
  });

  it("routes a completed platform MFA challenge to the system console", async () => {
    authMock.login.mockResolvedValue({ mfaRequired: true, challengeId: "challenge-1" });
    authMock.verifyMfa.mockResolvedValue(platformSession);
    const view = render(<AuthPage mode="login" />);

    await userEvent.type(screen.getByLabelText("Email"), "system@example.com");
    await userEvent.type(screen.getByLabelText("Password"), "a valid password");
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await userEvent.type(await screen.findByLabelText("Verification code"), "123456");
    await userEvent.click(screen.getByRole("button", { name: "Verify and sign in" }));

    authMock.status = "authenticated";
    view.rerender(<AuthPage mode="login" />);
    await vi.waitFor(() => expect(window.location.pathname).toBe("/system"));
    expect(authMock.verifyMfa).toHaveBeenCalledWith("challenge-1", "123456");
  });
  it("routes temporary-password sign-in to mandatory replacement without putting the challenge in history", async () => {
    authMock.login.mockResolvedValue({ passwordChangeRequired: true, passwordChangeToken: "limited-test-token", passwordChangeExpiresAt: "2026-10-20T10:00:00Z" });
    render(<AuthPage mode="login" />);
    await userEvent.type(screen.getByLabelText("Email"), "viewer@example.com");
    await userEvent.type(screen.getByLabelText("Password"), "fixture temporary password");
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await vi.waitFor(() => expect(window.location.pathname).toBe("/change-temporary-password"));
    expect(window.location.href).not.toContain("limited-test-token");
    expect(JSON.stringify(window.history.state)).not.toContain("limited-test-token");
    expect(screen.getByLabelText("Password")).toHaveValue("");
  });

  it("uses the organization-specific sign-in link and keeps recovery in the same organization", async () => {
    window.history.replaceState(null, "", "/login?organizationId=org-target");
    authMock.login.mockResolvedValue({ mfaRequired: true, challengeId: "target-challenge" });
    render(<AuthPage mode="login" />);
    expect(screen.getByText("Sign in with the password shared for this organization.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Forgot your password?" })).toHaveAttribute("href", "/forgot-password?organizationId=org-target");
    await userEvent.type(screen.getByLabelText("Email"), "same@example.com");
    await userEvent.type(screen.getByLabelText("Password"), "target organization password");
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(authMock.login).toHaveBeenCalledExactlyOnceWith("same@example.com", "target organization password", "org-target");
    expect(await screen.findByLabelText("Verification code")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Use a different account" })).toBeInTheDocument();
  });

  it("lets a password-proven user choose an organization before continuing through its normal MFA gate", async () => {
    authMock.login.mockResolvedValueOnce({ organizationSelectionRequired: true, organizations: [{ id: "org-one", name: "First Harbour" }, { id: "org-two", name: "Second Harbour" }] })
      .mockResolvedValueOnce({ mfaRequired: true, challengeId: "second-challenge" });
    render(<AuthPage mode="login" />);
    expect(screen.queryByText("First Harbour")).not.toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Email"), "same@example.com");
    await userEvent.type(screen.getByLabelText("Password"), "shared test password");
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByRole("heading", { name: "Choose your organization" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Password")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Continue to organization" })).toBeDisabled();
    await userEvent.selectOptions(screen.getByLabelText("Organization"), "org-two");
    await userEvent.click(screen.getByRole("button", { name: "Continue to organization" }));
    expect(authMock.login).toHaveBeenNthCalledWith(2, "same@example.com", "shared test password", "org-two");
    expect(await screen.findByLabelText("Verification code")).toBeInTheDocument();
    expect(window.location.href).not.toContain("shared");
    expect(JSON.stringify(window.history.state)).not.toContain("shared test password");
    await userEvent.click(screen.getByRole("button", { name: "Use a different account" }));
    expect(screen.getByLabelText("Password")).toHaveValue("");
  });

  it("discards password and organization choices when the user chooses another account", async () => {
    authMock.login.mockResolvedValue({ organizationSelectionRequired: true, organizations: [{ id: "org-one", name: "First Harbour" }, { id: "org-two", name: "Second Harbour" }] });
    render(<AuthPage mode="login" />);
    await userEvent.type(screen.getByLabelText("Email"), "same@example.com");
    await userEvent.type(screen.getByLabelText("Password"), "shared test password");
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await userEvent.click(await screen.findByRole("button", { name: "Use a different account" }));
    expect(screen.getByLabelText("Password")).toHaveValue("");
    expect(screen.queryByLabelText("Organization")).not.toBeInTheDocument();
    expect(screen.queryByText("First Harbour")).not.toBeInTheDocument();
  });

  it("asks for the password again if an organization-specific retry fails", async () => {
    authMock.login.mockResolvedValueOnce({ organizationSelectionRequired: true, organizations: [{ id: "org-one", name: "First Harbour" }, { id: "org-two", name: "Second Harbour" }] })
      .mockRejectedValueOnce(new ApiError("Invalid email or password", 401));
    render(<AuthPage mode="login" />);
    await userEvent.type(screen.getByLabelText("Email"), "same@example.com");
    await userEvent.type(screen.getByLabelText("Password"), "changed test password");
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await userEvent.selectOptions(await screen.findByLabelText("Organization"), "org-two");
    await userEvent.click(screen.getByRole("button", { name: "Continue to organization" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Invalid email or password");
    expect(screen.getByLabelText("Password")).toHaveValue("");
    expect(screen.queryByLabelText("Organization")).not.toBeInTheDocument();
  });

  it("preserves organization scope when a temporary password needs to be changed", async () => {
    window.history.replaceState(null, "", "/login?organizationId=org-target");
    authMock.login.mockResolvedValue({ passwordChangeRequired: true, passwordChangeToken: "limited-test-token", passwordChangeExpiresAt: "2026-10-20T10:00:00Z" });
    render(<AuthPage mode="login" />);
    await userEvent.type(screen.getByLabelText("Email"), "same@example.com");
    await userEvent.type(screen.getByLabelText("Password"), "fixture temporary password");
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await vi.waitFor(() => expect(window.location.pathname).toBe("/change-temporary-password"));
    expect(window.history.state.organizationId).toBe("org-target");
    expect(JSON.stringify(window.history.state)).not.toContain("limited-test-token");
    expect(JSON.stringify(window.history.state)).not.toContain("fixture temporary password");
  });

});
