import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "../lib/api";
import { OrganizationJoin, OrganizationJoinVerification } from "./OrganizationJoin";

const mocks = vi.hoisted(() => ({ inspect: vi.fn(), submit: vi.fn(), verify: vi.fn() }));
vi.mock("../lib/organizationJoin", () => ({ organizationJoinApi: mocks }));
function renderJoin() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><OrganizationJoin /></QueryClientProvider>);
}
async function fillJoin() {
  await screen.findByLabelText("Full name");
  await userEvent.type(screen.getByLabelText("Full name"), "  Ada Agency  ");
  await userEvent.type(screen.getByLabelText("Email"), "ADA@EXAMPLE.TEST");
}
async function fillVerification() {
  await userEvent.type(screen.getByLabelText("Password"), "recipient-secure-password");
  await userEvent.type(screen.getByLabelText("Confirm password"), "recipient-secure-password");
}
function renderVerification() {
  window.history.replaceState(null, "", "/join-organization/verify#token=email-token");
  return render(<OrganizationJoinVerification />);
}

describe("public organization joining", () => {
  beforeEach(() => {
    Object.values(mocks).forEach((mock) => mock.mockReset());
    window.history.replaceState(null, "", "/join-organization#token=shared-token");
    mocks.inspect.mockResolvedValue({ organization: { name: "NPA Test Organization" }, expiresAt: "2090-10-19T19:00:00Z" });
    mocks.submit.mockResolvedValue({ detail: "Check your email" });
    mocks.verify.mockResolvedValue({ detail: "Email verified" });
  });
  it("does not submit or resolve a link without its token", async () => {
    window.history.replaceState(null, "", "/join-organization");
    renderJoin();
    expect(screen.getByRole("heading", { name: "Sign-up link unavailable" })).toBeInTheDocument();
    expect(mocks.inspect).not.toHaveBeenCalled();
    expect(mocks.submit).not.toHaveBeenCalled();
  });
  it("does not offer entry for a revoked or expired link", async () => {
    mocks.inspect.mockRejectedValue(new ApiError("Invalid link", 400));
    renderJoin();
    expect(await screen.findByRole("heading", { name: "Sign-up link unavailable" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Request to join" })).not.toBeInTheDocument();
  });
  it("shows the existing organization and explains verification and approval before access", async () => {
    renderJoin();
    expect(await screen.findByRole("heading", { name: "Join NPA Test Organization" })).toBeInTheDocument();
    expect(mocks.inspect).toHaveBeenCalledWith("shared-token");
    expect(screen.getByText(/Admin will review your request/i)).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Joining steps" })).toHaveTextContent("Admin approval");
    expect(screen.queryByLabelText("Organization name")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Password")).not.toBeInTheDocument();
  });
  it("submits normalized identity without password or role, then requires email verification and approval", async () => {
    renderJoin();
    await fillJoin();
    await userEvent.click(screen.getByRole("button", { name: "Request to join" }));
    expect(mocks.submit).toHaveBeenCalledWith({ token: "shared-token", name: "Ada Agency", email: "ada@example.test" });
    expect(await screen.findByRole("heading", { name: "Check your email" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(/If this address is eligible/i);
    expect(screen.getByRole("status")).toHaveTextContent(/choose your password/i);
    expect(screen.getByRole("status")).toHaveTextContent(/before you can sign in/i);
  });
  it("prevents duplicate submissions while the request is pending", async () => {
    let resolve!: (value: { detail: string }) => void;
    mocks.submit.mockReturnValue(new Promise((finish) => { resolve = finish; }));
    renderJoin();
    await fillJoin();
    const form = screen.getByRole("button", { name: "Request to join" }).closest("form")!;
    fireEvent.submit(form); fireEvent.submit(form);
    await waitFor(() => expect(mocks.submit).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("button", { name: "Submitting…" })).toBeDisabled();
    resolve({ detail: "Check email" });
    await screen.findByRole("heading", { name: "Check your email" });
  });
  it("preserves entered identity and displays server rejection without claiming submission", async () => {
    mocks.submit.mockRejectedValue(new ApiError("This link was revoked.", 400));
    renderJoin();
    await fillJoin();
    await userEvent.click(screen.getByRole("button", { name: "Request to join" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("This link was revoked.");
    expect(screen.getByLabelText("Email")).toHaveValue("ADA@EXAMPLE.TEST");
    expect(screen.getByRole("button", { name: "Request to join" })).toBeEnabled();
  });
  it("requires the email recipient to choose the final password and explicitly verify before review", async () => {
    renderVerification();
    expect(mocks.verify).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Password")).toHaveValue("");
    await fillVerification();
    await userEvent.click(screen.getByRole("button", { name: "Verify email" }));
    expect(mocks.verify).toHaveBeenCalledWith("email-token", "recipient-secure-password");
    expect(await screen.findByRole("heading", { name: "Email verified" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("You do not have workspace access yet");
    expect(screen.queryByRole("link", { name: "Sign in" })).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue("recipient-secure-password")).not.toBeInTheDocument();
  });
  it("rejects mismatched verification passwords before calling the API", async () => {
    renderVerification();
    await userEvent.type(screen.getByLabelText("Password"), "recipient-secure-password");
    await userEvent.type(screen.getByLabelText("Confirm password"), "a-different-password");
    await userEvent.click(screen.getByRole("button", { name: "Verify email" }));
    expect(screen.getByRole("alert")).toHaveTextContent("passwords do not match");
    expect(mocks.verify).not.toHaveBeenCalled();
  });
  it("preserves the recipient form for server password validation errors without consuming the token", async () => {
    mocks.verify.mockRejectedValue(new ApiError("Validation failed", 400, { password: ["This password is too common."] }));
    renderVerification();
    await fillVerification();
    await userEvent.click(screen.getByRole("button", { name: "Verify email" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("This password is too common.");
    expect(screen.getByLabelText("Password")).toHaveValue("recipient-secure-password");
    expect(screen.getByRole("button", { name: "Verify email" })).toBeEnabled();
    expect(screen.queryByRole("heading", { name: "Email verified" })).not.toBeInTheDocument();
  });
  it("shows a used verification failure without claiming email verification or access", async () => {
    mocks.verify.mockRejectedValue(new ApiError("This verification link has expired", 400));
    renderVerification();
    await fillVerification();
    await userEvent.click(screen.getByRole("button", { name: "Verify email" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("This verification link has expired");
    expect(screen.queryByRole("heading", { name: "Email verified" })).not.toBeInTheDocument();
  });
});
