import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AuthPage } from "./AuthPage";

const authMock = vi.hoisted(() => ({
  login: vi.fn(),
  register: vi.fn(),
  verifyMfa: vi.fn(),
  status: "anonymous",
}));

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
    authMock.login.mockResolvedValue(null);
    const view = render(<AuthPage mode="login" />);

    await userEvent.type(screen.getByLabelText("Email"), "operations@example.com");
    await userEvent.type(screen.getByLabelText("Password"), "a valid password");
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(window.location.pathname).toBe("/login");

    authMock.status = "authenticated";
    view.rerender(<AuthPage mode="login" />);

    await vi.waitFor(() => expect(window.location.pathname).toBe("/app"));
  });
});
