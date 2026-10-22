import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "../lib/api";
import type { AuthSession } from "../types";
import { TemporaryPasswordChange } from "./TemporaryPasswordChange";

const authMock = vi.hoisted(() => ({
  passwordChangeChallenge: null as null | { passwordChangeRequired: true; passwordChangeToken: string; passwordChangeExpiresAt: string },
  completeTemporaryPassword: vi.fn(), verifyMfa: vi.fn(), logout: vi.fn(), status: "anonymous",
}));
vi.mock("../auth/AuthContext", () => ({ useAuth: () => authMock }));
const session: AuthSession = {
  user: { id: "user-1", name: "Test Viewer", email: "viewer@example.com", role: "Viewer", status: "active", emailVerified: false, mfaEnabled: false, mfaRequired: false },
  org: null, permissions: ["measurements.view"],
};
async function enterPasswords(password = "fresh unique fixture password", confirmation = password) {
  await userEvent.type(screen.getByLabelText("New password"), password);
  await userEvent.type(screen.getByLabelText("Confirm new password"), confirmation);
}
describe("TemporaryPasswordChange", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authMock.status = "anonymous";
    authMock.passwordChangeChallenge = { passwordChangeRequired: true, passwordChangeToken: "limited-fixture-challenge", passwordChangeExpiresAt: new Date(Date.now() + 300_000).toISOString() };
    window.history.replaceState(null, "", "/change-temporary-password");
  });
  it("requires matching private passwords before any request and never exposes the limited token", async () => {
    render(<TemporaryPasswordChange />);
    expect(screen.getByText("NPA Vessel Caller")).toBeInTheDocument();
    expect(screen.getByAltText("Nigerian Ports Authority")).toBeInTheDocument();
    expect(screen.getByLabelText("New password")).toHaveAttribute("type", "password");
    await enterPasswords("fresh unique fixture password", "different fixture password");
    await userEvent.click(screen.getByRole("button", { name: "Change password and continue" }));
    expect(screen.getByRole("alert")).toHaveTextContent("The passwords do not match.");
    expect(authMock.completeTemporaryPassword).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain("limited-fixture-challenge");
    expect(window.location.href).not.toContain("limited-fixture-challenge");
  });
  it("redirects only after the replaced-password session has committed", async () => {
    authMock.completeTemporaryPassword.mockResolvedValue(session);
    const view = render(<TemporaryPasswordChange />);
    await enterPasswords();
    await userEvent.click(screen.getByRole("button", { name: "Change password and continue" }));
    expect(authMock.completeTemporaryPassword).toHaveBeenCalledWith("fresh unique fixture password");
    expect(window.location.pathname).toBe("/change-temporary-password");
    authMock.status = "authenticated";
    authMock.passwordChangeChallenge = null;
    view.rerender(<TemporaryPasswordChange />);
    await waitFor(() => expect(window.location.pathname + window.location.search).toBe("/app/account?setup=authenticator"));
    expect(window.history.state).toMatchObject({ passwordUpdated: true });
  });
  it("continues enrolled MFA after replacement and directs required enrollment before app access", async () => {
    authMock.completeTemporaryPassword.mockResolvedValue({ mfaRequired: true, challengeId: "mfa-fixture" });
    authMock.verifyMfa.mockResolvedValue({ ...session, user: { ...session.user, role: "Admin", mfaRequired: true, mfaEnrollmentRequired: true } });
    const view = render(<TemporaryPasswordChange />);
    await enterPasswords();
    await userEvent.click(screen.getByRole("button", { name: "Change password and continue" }));
    authMock.passwordChangeChallenge = null;
    view.rerender(<TemporaryPasswordChange />);
    expect(await screen.findByRole("heading", { name: "Two-factor verification" })).toBeInTheDocument();
    expect(screen.queryByLabelText("New password")).not.toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Verification code"), "123456");
    await userEvent.click(screen.getByRole("button", { name: "Verify and sign in" }));
    expect(authMock.verifyMfa).toHaveBeenCalledWith("mfa-fixture", "123456");
    authMock.status = "authenticated";
    view.rerender(<TemporaryPasswordChange />);
    await waitFor(() => expect(window.location.pathname + window.location.search).toBe("/app/account?setup=authenticator"));
  });
  it("guides a new Admin through enrollment even during the server MFA grace period", async () => {
    authMock.completeTemporaryPassword.mockResolvedValue({ ...session, user: { ...session.user, role: "Admin", mfaRequired: true, mfaEnrollmentRequired: false } });
    window.history.replaceState({ from: "/app/measurements" }, "", "/change-temporary-password");
    const view = render(<TemporaryPasswordChange />);
    await enterPasswords();
    await userEvent.click(screen.getByRole("button", { name: "Change password and continue" }));
    authMock.status = "authenticated";
    view.rerender(<TemporaryPasswordChange />);
    await waitFor(() => expect(window.location.pathname + window.location.search).toBe("/app/account?setup=authenticator"));
    expect(window.history.state).toEqual({ from: "/app/measurements", passwordUpdated: true });
    expect(window.location.href).not.toContain("password-change");
  });
  it("does not restart enrollment for an account that already has an authenticator", async () => {
    authMock.completeTemporaryPassword.mockResolvedValue({ ...session, user: { ...session.user, mfaEnabled: true } });
    window.history.replaceState({ from: "/app/measurements" }, "", "/change-temporary-password");
    const view = render(<TemporaryPasswordChange />);
    await enterPasswords();
    await userEvent.click(screen.getByRole("button", { name: "Change password and continue" }));
    authMock.status = "authenticated";
    view.rerender(<TemporaryPasswordChange />);
    await waitFor(() => expect(window.location.pathname).toBe("/app/measurements"));
    expect(window.location.search).toBe("");
  });
  it("blocks an expired challenge and provides a safe route back to sign in", async () => {
    authMock.passwordChangeChallenge!.passwordChangeExpiresAt = new Date(Date.now() - 1_000).toISOString();
    render(<TemporaryPasswordChange />);
    expect(screen.getByRole("alert")).toHaveTextContent("has expired");
    expect(screen.getByRole("button", { name: "Change password and continue" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Return to sign in" }));
    expect(authMock.logout).toHaveBeenCalledTimes(1);
    expect(window.location.pathname).toBe("/login");
    expect(authMock.completeTemporaryPassword).not.toHaveBeenCalled();
  });
  it("keeps duplicate submits out and renders backend password validation safely", async () => {
    let reject!: (error: unknown) => void;
    authMock.completeTemporaryPassword.mockReturnValue(new Promise((_, rejectPromise) => { reject = rejectPromise; }));
    render(<TemporaryPasswordChange />);
    await enterPasswords();
    await userEvent.click(screen.getByRole("button", { name: "Change password and continue" }));
    fireEvent.submit(screen.getByRole("form", { name: "Choose your own password" }));
    expect(authMock.completeTemporaryPassword).toHaveBeenCalledTimes(1);
    reject(new ApiError("Invalid password.", 400, { password: ["Choose a less common password."] }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Choose a less common password.");
    expect(screen.getByRole("button", { name: "Change password and continue" })).toBeEnabled();
  });
  it("requires fresh temporary sign-in after reload loses the memory-only challenge", () => {
    authMock.passwordChangeChallenge = null;
    render(<TemporaryPasswordChange />);
    expect(screen.getByRole("heading", { name: "Sign in to continue" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Return to sign in" })).toHaveAttribute("href", "/login");
    expect(screen.queryByLabelText("New password")).not.toBeInTheDocument();
  });
});
