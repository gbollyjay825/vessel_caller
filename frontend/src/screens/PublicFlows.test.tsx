import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "../lib/api";
import { EmailVerification } from "./EmailVerification";
import { InvitationAccept } from "./InvitationAccept";
import { ForgotPassword, ResetPassword } from "./PasswordRecovery";

const mocks = vi.hoisted(() => ({
  verifyEmail: vi.fn(),
  resendVerification: vi.fn(),
  acceptInvitation: vi.fn(),
  forgotPassword: vi.fn(),
  resetPassword: vi.fn(),
}));

vi.mock("../lib/api", () => {
  class MockApiError extends Error {
    status: number;
    errors: Record<string, string[] | string>;
    requestId: string | null;

    constructor(
      message: string,
      status: number,
      errors: Record<string, string[] | string> = {},
      requestId: string | null = null,
    ) {
      super(message);
      this.status = status;
      this.errors = errors;
      this.requestId = requestId;
    }
  }
  return {
    ApiError: MockApiError,
    api: {
      verifyEmail: mocks.verifyEmail,
      resendVerification: mocks.resendVerification,
      acceptInvitation: mocks.acceptInvitation,
      forgotPassword: mocks.forgotPassword,
      resetPassword: mocks.resetPassword,
    },
  };
});

describe("public account lifecycle flows", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.history.replaceState(null, "", "/");
  });

  it("verifies a valid registration email token", async () => {
    window.history.replaceState(null, "", "/verify-email?token=secure-token");
    mocks.verifyEmail.mockResolvedValue({ detail: "Verification complete." });
    render(<EmailVerification />);

    expect(screen.getByRole("status")).toHaveTextContent("Verifying");
    expect(await screen.findByRole("heading", { name: "Email verified" })).toBeInTheDocument();
    expect(screen.getByText("Verification complete.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Sign in" })).toHaveAttribute("href", "/login");
    expect(mocks.verifyEmail).toHaveBeenCalledWith("secure-token");
  });

  it("recovers from an expired verification token and resends a normalized address", async () => {
    window.history.replaceState(null, "", "/verify-email?token=expired&email=ADA%40EXAMPLE.COM");
    mocks.verifyEmail.mockRejectedValue(new ApiError("This link has expired.", 400));
    mocks.resendVerification.mockResolvedValue({});
    render(<EmailVerification />);

    expect(await screen.findByRole("heading", { name: "Verification link unavailable" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("This link has expired.");
    await userEvent.click(screen.getByRole("button", { name: "Send a new verification email" }));
    await waitFor(() => expect(mocks.resendVerification).toHaveBeenCalledWith("ada@example.com"));
    expect(screen.getByRole("status")).toHaveTextContent("If the account is pending");
  });

  it("shows a generic verification resend failure without exposing account existence", async () => {
    window.history.replaceState(null, "", "/verify-email");
    mocks.resendVerification.mockRejectedValue(new TypeError("network"));
    render(<EmailVerification />);

    await userEvent.type(screen.getByLabelText("Email"), "person@example.com");
    await userEvent.click(screen.getByRole("button", { name: "Send a new verification email" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Could not send a verification email.");
  });

  it("validates and accepts a single-use invitation", async () => {
    window.history.replaceState(null, "", "/invite/accept?token=invite-token");
    mocks.acceptInvitation.mockResolvedValue({});
    render(<InvitationAccept />);

    await userEvent.type(screen.getByLabelText("Full name"), "  Ada Invitee  ");
    await userEvent.type(screen.getByLabelText("Password"), "twelve-chars-1");
    await userEvent.type(screen.getByLabelText("Confirm password"), "different-pass");
    fireEvent.submit(screen.getByRole("button", { name: "Accept invitation" }).closest("form")!);
    expect(screen.getByRole("alert")).toHaveTextContent("passwords do not match");
    expect(mocks.acceptInvitation).not.toHaveBeenCalled();

    await userEvent.clear(screen.getByLabelText("Confirm password"));
    await userEvent.type(screen.getByLabelText("Confirm password"), "twelve-chars-1");
    await userEvent.click(screen.getByRole("button", { name: "Accept invitation" }));
    await waitFor(() => expect(mocks.acceptInvitation).toHaveBeenCalledWith({
      token: "invite-token",
      name: "Ada Invitee",
      password: "twelve-chars-1",
    }));
    expect(screen.getByRole("heading", { name: "Invitation accepted" })).toBeInTheDocument();
  });

  it("blocks missing and weak invitation tokens and reports API rejection", async () => {
    render(<InvitationAccept />);
    expect(screen.getByRole("alert")).toHaveTextContent("missing its secure token");
    expect(screen.getByRole("button", { name: "Accept invitation" })).toBeDisabled();

    window.history.replaceState(null, "", "/invite/accept?token=bad");
    const view = render(<InvitationAccept />);
    await userEvent.type(screen.getAllByLabelText("Full name")[1], "New User");
    await userEvent.type(screen.getAllByLabelText("Password")[1], "short");
    fireEvent.submit(screen.getAllByRole("button", { name: "Accept invitation" })[1].closest("form")!);
    expect(screen.getAllByRole("alert")[1]).toHaveTextContent("at least 12 characters");
    view.unmount();

    document.body.innerHTML = "";
    mocks.acceptInvitation.mockRejectedValue(new ApiError("Invitation was revoked.", 410));
    render(<InvitationAccept />);
    await userEvent.type(screen.getByLabelText("Full name"), "New User");
    await userEvent.type(screen.getByLabelText("Password"), "twelve-chars-1");
    await userEvent.type(screen.getByLabelText("Confirm password"), "twelve-chars-1");
    await userEvent.click(screen.getByRole("button", { name: "Accept invitation" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Invitation was revoked.");
  });

  it("dispatches password recovery without account enumeration", async () => {
    mocks.forgotPassword.mockResolvedValue({});
    render(<ForgotPassword />);
    await userEvent.type(screen.getByLabelText("Email"), "  ADA@EXAMPLE.COM ");
    await userEvent.click(screen.getByRole("button", { name: "Send reset link" }));
    await waitFor(() => expect(mocks.forgotPassword).toHaveBeenCalledWith("ada@example.com"));
    expect(screen.getByRole("status")).toHaveTextContent("If an account exists");
  });

  it("reports password recovery delivery errors", async () => {
    mocks.forgotPassword.mockRejectedValue(new ApiError("Please try later.", 429));
    render(<ForgotPassword />);
    await userEvent.type(screen.getByLabelText("Email"), "ada@example.com");
    await userEvent.click(screen.getByRole("button", { name: "Send reset link" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Please try later.");
  });

  it("validates and completes a password reset token", async () => {
    window.history.replaceState(null, "", "/reset-password?token=reset-token");
    mocks.resetPassword.mockResolvedValue({});
    render(<ResetPassword />);

    await userEvent.type(screen.getByLabelText("New password"), "twelve-chars-1");
    await userEvent.type(screen.getByLabelText("Confirm new password"), "not-the-same-1");
    fireEvent.submit(screen.getByRole("button", { name: "Change password" }).closest("form")!);
    expect(screen.getByRole("alert")).toHaveTextContent("passwords do not match");

    await userEvent.clear(screen.getByLabelText("Confirm new password"));
    await userEvent.type(screen.getByLabelText("Confirm new password"), "twelve-chars-1");
    await userEvent.click(screen.getByRole("button", { name: "Change password" }));
    await waitFor(() => expect(mocks.resetPassword).toHaveBeenCalledWith("reset-token", "twelve-chars-1"));
    expect(screen.getByRole("status")).toHaveTextContent("password has been changed");
  });

  it("blocks a missing reset token and reports a rejected valid token", async () => {
    render(<ResetPassword />);
    expect(screen.getByRole("alert")).toHaveTextContent("missing its secure token");
    expect(screen.getByRole("button", { name: "Change password" })).toBeDisabled();

    document.body.innerHTML = "";
    window.history.replaceState(null, "", "/reset-password?token=expired");
    mocks.resetPassword.mockRejectedValue(new TypeError("network"));
    render(<ResetPassword />);
    await userEvent.type(screen.getByLabelText("New password"), "twelve-chars-1");
    await userEvent.type(screen.getByLabelText("Confirm new password"), "twelve-chars-1");
    await userEvent.click(screen.getByRole("button", { name: "Change password" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Something went wrong");
  });
});
