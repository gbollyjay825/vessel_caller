import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthSession } from "../types";
import { AuthPage } from "./AuthPage";

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
    authMock.register.mockResolvedValue({ detail: "Check your inbox." });
    render(<AuthPage mode="register" />);

    await userEvent.type(screen.getByLabelText("Your name"), "Ada Admin");
    await userEvent.type(screen.getByLabelText("Organization name"), "Ada Marine");
    await userEvent.type(screen.getByLabelText("Email"), "ada@example.com");
    await userEvent.type(screen.getByLabelText("Password"), "a secure password");
    await userEvent.click(screen.getByRole("button", { name: "Create organization" }));

    expect(await screen.findByRole("heading", { name: "Verify your email" })).toBeInTheDocument();
    expect(screen.getByText("Check your inbox.")).toBeInTheDocument();
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
});
