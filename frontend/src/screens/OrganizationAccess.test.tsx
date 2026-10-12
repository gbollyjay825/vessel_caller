import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { OrganizationAccess } from "./OrganizationAccess";
import { ApiError } from "../lib/api";
import type { OrganizationJoinRequest, OrganizationSignupLink } from "../lib/organizationJoin";

const mocks = vi.hoisted(() => ({ links: vi.fn(), createLink: vi.fn(), revokeLink: vi.fn(), requests: vi.fn(), approve: vi.fn(), reject: vi.fn(), can: vi.fn() }));
vi.mock("../lib/organizationJoin", () => ({ organizationJoinApi: mocks }));
vi.mock("../auth/AuthContext", () => ({ useAuth: () => ({ org: { id: "org-npa", name: "NPA" }, can: mocks.can }) }));

const link: OrganizationSignupLink = { id: "link-1", organizationId: "org-npa", createdAt: "2090-10-12T19:00:00Z", expiresAt: "2090-10-19T19:00:00Z", revokedAt: null, status: "active", createdBy: { id: "admin-1", name: "Admin" } };
const request: OrganizationJoinRequest = { id: "request-1", name: "Ada Agency", email: "ada@example.test", status: "pending", createdAt: "2026-10-12T19:00:00Z", emailVerifiedAt: "2026-10-12T19:05:00Z", reviewedAt: null };
const page = <T,>(results: T[]) => ({ results, count: results.length, page: 1, pageSize: 20 });
function renderAccess() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={client}><OrganizationAccess /></QueryClientProvider>);
}

describe("organization sign-up link and approval", () => {
  beforeEach(() => {
    Object.values(mocks).forEach((mock) => mock.mockReset());
    mocks.can.mockReturnValue(true);
    mocks.links.mockResolvedValue(page([]));
    mocks.requests.mockResolvedValue(page([]));
  });
  it("keeps link management and request approval restricted to Admin access", () => {
    mocks.can.mockReturnValue(false);
    renderAccess();
    expect(screen.getByText("Admin access required")).toBeInTheDocument();
    expect(mocks.links).not.toHaveBeenCalled();
    expect(mocks.requests).not.toHaveBeenCalled();
  });
  it("creates an expiring link, displays it once and copies it", async () => {
    mocks.createLink.mockImplementation(async () => { mocks.links.mockResolvedValue(page([link])); return { link, signupUrl: "https://staging.vesselcalls.com/join-organization#token=example" }; });
    const user = userEvent.setup();
    renderAccess();
    await screen.findByRole("button", { name: "Create sign-up link" });
    await user.selectOptions(screen.getByLabelText("Link valid for"), "14");
    await user.click(screen.getByRole("button", { name: "Create sign-up link" }));
    expect(mocks.createLink).toHaveBeenCalledWith(14);
    const url = await screen.findByLabelText("Shareable sign-up link");
    expect(url).toHaveValue("https://staging.vesselcalls.com/join-organization#token=example");
    const clipboard = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    await user.click(screen.getByRole("button", { name: "Copy link" }));
    expect(clipboard).toHaveBeenCalledWith("https://staging.vesselcalls.com/join-organization#token=example");
    expect(await screen.findByText("Link copied.")).toBeInTheDocument();
  });
  it("requires confirmation before rotating an existing link", async () => {
    mocks.links.mockResolvedValue(page([link]));
    mocks.createLink.mockResolvedValue({ link, signupUrl: "https://example.test/join-organization#token=new" });
    renderAccess();
    await userEvent.click(await screen.findByRole("button", { name: "Create replacement link" }));
    expect(screen.getByRole("alertdialog", { name: "Replace sign-up link?" })).toBeInTheDocument();
    expect(mocks.createLink).not.toHaveBeenCalled();
    expect(screen.getByText(/Verified requests remain available/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Replace link" }));
    await waitFor(() => expect(mocks.createLink).toHaveBeenCalledWith(7));
  });
  it("requires confirmation to revoke and preserves review of submitted requests", async () => {
    mocks.links.mockResolvedValue(page([link]));
    mocks.revokeLink.mockImplementation(async () => { mocks.links.mockResolvedValue(page([])); });
    renderAccess();
    await userEvent.click(await screen.findByRole("button", { name: "Revoke link" }));
    expect(mocks.revokeLink).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Confirm revoke" }));
    await waitFor(() => expect(mocks.revokeLink).toHaveBeenCalledWith("link-1"));
    expect(await screen.findByText(/no active sign-up link/i)).toBeInTheDocument();
  });
  it("preserves controls and errors when link creation fails", async () => {
    mocks.createLink.mockRejectedValue(new ApiError("Try again later", 429));
    renderAccess();
    await userEvent.click(await screen.findByRole("button", { name: "Create sign-up link" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Try again later");
    expect(screen.getByRole("button", { name: "Create sign-up link" })).toBeEnabled();
  });
  it("defaults to verified pending requests and approves the explicitly selected role", async () => {
    mocks.requests.mockResolvedValue(page([request]));
    mocks.approve.mockImplementation(async () => { mocks.requests.mockResolvedValue(page([])); return {}; });
    renderAccess();
    await userEvent.click(await screen.findByRole("button", { name: "Review Ada Agency" }));
    expect(mocks.requests).toHaveBeenCalledWith({ status: "pending", page: 1 });
    expect(screen.getByRole("combobox", { name: /^Role/ })).toHaveValue("Operations");
    await userEvent.selectOptions(screen.getByRole("combobox", { name: /^Role/ }), "Finance");
    await userEvent.click(screen.getByRole("button", { name: "Approve access" }));
    expect(mocks.approve).toHaveBeenCalledWith("request-1", "Finance");
    expect(await screen.findByText(/Ada Agency has been approved/)).toBeInTheDocument();
  });
  it("does not grant Admin unless explicitly selected and confirmed", async () => {
    mocks.requests.mockResolvedValue(page([request]));
    mocks.approve.mockResolvedValue({});
    renderAccess();
    await userEvent.click(await screen.findByRole("button", { name: "Review Ada Agency" }));
    await userEvent.selectOptions(screen.getByRole("combobox", { name: /^Role/ }), "Admin");
    expect(screen.getByRole("button", { name: "Approve access" })).toBeDisabled();
    fireEvent.submit(screen.getByRole("button", { name: "Approve access" }).closest("aside")!.querySelector("form")!);
    expect(mocks.approve).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("checkbox", { name: /full Admin access/i }));
    await userEvent.click(screen.getByRole("button", { name: "Approve access" }));
    expect(mocks.approve).toHaveBeenCalledWith("request-1", "Admin");
  });
  it("keeps the review open on approval failure without claiming access", async () => {
    mocks.requests.mockResolvedValue(page([request]));
    mocks.approve.mockRejectedValue(new ApiError("Request was already reviewed", 409));
    renderAccess();
    await userEvent.click(await screen.findByRole("button", { name: "Review Ada Agency" }));
    await userEvent.click(screen.getByRole("button", { name: "Approve access" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Request was already reviewed");
    expect(screen.getByRole("dialog", { name: "Review join request" })).toBeInTheDocument();
    expect(screen.queryByText(/has been approved/)).not.toBeInTheDocument();
  });
  it("requires a second action to reject and never grants access", async () => {
    mocks.requests.mockResolvedValue(page([request]));
    mocks.reject.mockImplementation(async () => { mocks.requests.mockResolvedValue(page([])); return {}; });
    renderAccess();
    await userEvent.click(await screen.findByRole("button", { name: "Review Ada Agency" }));
    await userEvent.click(screen.getByRole("button", { name: "Reject request" }));
    expect(mocks.reject).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Approve access" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Confirm rejection" }));
    expect(mocks.reject).toHaveBeenCalledWith("request-1");
    expect(mocks.approve).not.toHaveBeenCalled();
    expect(await screen.findByText(/Workspace access was not granted/)).toBeInTheDocument();
  });
  it("does not offer approval for unverified requests and requests all statuses on demand", async () => {
    mocks.requests.mockResolvedValue(page([{ ...request, status: "unverified", emailVerifiedAt: null }]));
    renderAccess();
    await screen.findByText("Ada Agency");
    expect(screen.queryByRole("button", { name: /Review Ada/ })).not.toBeInTheDocument();
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Request status" }), "all");
    await waitFor(() => expect(mocks.requests).toHaveBeenCalledWith({ status: "all", page: 1 }));
  });
});
