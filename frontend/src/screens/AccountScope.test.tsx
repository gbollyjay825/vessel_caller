import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { EmailVerification } from "./EmailVerification";
import { InvitationAccept } from "./InvitationAccept";
import { ForgotPassword, ResetPassword } from "./PasswordRecovery";

const apiMock = vi.hoisted(() => ({
  forgotPassword: vi.fn(), resetPassword: vi.fn(), resendVerification: vi.fn(),
  verifyEmail: vi.fn(), acceptInvitation: vi.fn(),
}));
vi.mock("../lib/api", () => ({ api: apiMock, ApiError: class extends Error {} }));

describe("organization-specific account recovery", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    window.history.replaceState(null, "", "/login");
  });

  it("requests password recovery for the organization selected by the sign-in link", async () => {
    window.history.replaceState(null, "", "/forgot-password?organizationId=org-target");
    apiMock.forgotPassword.mockResolvedValue({ detail: "If an account exists, instructions were sent." });
    render(<ForgotPassword />);
    await userEvent.type(screen.getByLabelText("Email"), "SAME@EXAMPLE.COM");
    await userEvent.click(screen.getByRole("button", { name: "Send reset link" }));
    expect(await screen.findByRole("status")).toHaveTextContent("If an account exists");
    expect(apiMock.forgotPassword).toHaveBeenCalledExactlyOnceWith("same@example.com", "org-target");
    expect(screen.getByRole("link", { name: "Return to sign in" })).toHaveAttribute("href", "/login?organizationId=org-target");
  });

  it("keeps resend verification scoped without exposing any organization name", async () => {
    window.history.replaceState(null, "", "/verify-email?organizationId=org-target&email=same%40example.com");
    apiMock.resendVerification.mockResolvedValue({ detail: "If the account is pending, instructions were sent." });
    render(<EmailVerification />);
    await userEvent.click(screen.getByRole("button", { name: "Send a new verification email" }));
    expect(apiMock.resendVerification).toHaveBeenCalledExactlyOnceWith("same@example.com", "org-target");
    expect(screen.getByRole("link", { name: "Return to sign in" })).toHaveAttribute("href", "/login?organizationId=org-target");
  });

  it("uses the verified token organization rather than a different query parameter after email verification", async () => {
    window.history.replaceState(null, "", "/verify-email?token=fixture-token&organizationId=wrong-org");
    apiMock.verifyEmail.mockResolvedValue({ detail: "Your email is verified.", approvalPending: false, organizationId: "verified-org" });
    render(<EmailVerification />);
    expect(await screen.findByRole("link", { name: "Sign in" })).toHaveAttribute("href", "/login?organizationId=verified-org");
    expect(apiMock.verifyEmail).toHaveBeenCalledExactlyOnceWith("fixture-token");
  });

  it("returns an older password reset link to the token-bound organization", async () => {
    window.history.replaceState(null, "", "/reset-password?token=fixture-reset-token");
    apiMock.resetPassword.mockResolvedValue({ detail: "Your password has been changed.", organizationId: "reset-org" });
    render(<ResetPassword />);
    await userEvent.type(screen.getByLabelText("New password"), "fixture unique password");
    await userEvent.type(screen.getByLabelText("Confirm new password"), "fixture unique password");
    await userEvent.click(screen.getByRole("button", { name: "Change password" }));
    expect(await screen.findByRole("link", { name: "Sign in" })).toHaveAttribute("href", "/login?organizationId=reset-org");
    expect(apiMock.resetPassword).toHaveBeenCalledExactlyOnceWith("fixture-reset-token", "fixture unique password");
  });

  it("sends an accepted invitation to its own organization-specific sign-in page", async () => {
    window.history.replaceState(null, "", "/accept-invitation?token=fixture-invite-token");
    apiMock.acceptInvitation.mockResolvedValue({ detail: "Account created.", organizationId: "invited-org" });
    render(<InvitationAccept />);
    await userEvent.type(screen.getByLabelText("Full name"), "Sam Harbour");
    await userEvent.type(screen.getByLabelText("Password", { exact: true }), "fixture invitation password");
    await userEvent.type(screen.getByLabelText("Confirm password"), "fixture invitation password");
    await userEvent.click(screen.getByRole("button", { name: "Accept invitation" }));
    expect(await screen.findByRole("link", { name: "Sign in" })).toHaveAttribute("href", "/login?organizationId=invited-org");
  });
});
