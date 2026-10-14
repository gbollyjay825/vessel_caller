import { StrictMode } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgencyReadingPage } from "./AgencyReadingPage";
import { GuestPortalError } from "./guestApi";
import { guestContext, guestReceipt } from "./guest.test-support";
const api = vi.hoisted(() => ({ exchange: vi.fn(), context: vi.fn(), submit: vi.fn(), receipt: vi.fn() }));
vi.mock("./guestApi", async original => ({ ...await original<typeof import("./guestApi")>(), guestAgencyApi: api }));
beforeEach(() => {
  vi.clearAllMocks(); window.history.replaceState(null, "", "/agency-reading");
  api.exchange.mockResolvedValue("context-1"); api.context.mockResolvedValue(guestContext()); api.submit.mockImplementation(async (_context, _requestId, input) => guestReceipt(input));
});
afterEach(() => window.history.replaceState(null, "", "/"));

describe("public agency reading page", () => {
  it("clears the fragment before exchanging once, including StrictMode replay", async () => {
    window.history.replaceState(null, "", "/agency-reading#token=secret-once");
    api.exchange.mockImplementation(async () => { expect(window.location.hash).toBe(""); expect(window.location.href).not.toContain("secret-once"); return "context-1"; });
    render(<StrictMode><AgencyReadingPage /></StrictMode>); await screen.findByRole("heading", { name: "Harbour Agency" });
    expect(api.exchange).toHaveBeenCalledExactlyOnceWith("secret-once"); expect(api.context).toHaveBeenCalledExactlyOnceWith("context-1"); expect(window.location.search).toBe("?contextId=context-1");
  });
  it("reloads the non-secret context without another token exchange", async () => {
    window.history.replaceState(null, "", "/agency-reading?contextId=context-1"); render(<AgencyReadingPage />);
    await screen.findByRole("heading", { name: "Harbour Agency" }); expect(api.exchange).not.toHaveBeenCalled(); expect(api.context).toHaveBeenCalledWith("context-1");
  });
  it("shows an unavailable real backend without a fake form or login prompt", async () => {
    api.context.mockRejectedValue(new GuestPortalError("Agency reading links are not available on this environment yet.", 404)); render(<AgencyReadingPage />);
    expect(await screen.findByRole("alert")).toHaveTextContent("not available on this environment"); expect(screen.queryByRole("button", { name: "Submit reading" })).not.toBeInTheDocument(); expect(screen.queryByLabelText(/password/i)).not.toBeInTheDocument();
  });
  it("preserves requestId and fixed context through a failed submission retry", async () => {
    api.submit.mockRejectedValueOnce(new GuestPortalError("Wrong agency session. Reopen your link.", 403)); render(<AgencyReadingPage />);
    await screen.findByRole("heading", { name: "Record your agency’s reading" }); const user = userEvent.setup();
    await user.type(screen.getByLabelText("Source document reference"), "SOURCE-1"); await user.type(screen.getByRole("spinbutton"), "0");
    await user.click(screen.getByRole("button", { name: "Submit reading" })); expect(await screen.findByRole("alert")).toHaveTextContent("Wrong agency session");
    expect(api.context).toHaveBeenCalledTimes(1); expect(screen.getByRole("spinbutton")).toHaveValue(0);
    await user.click(screen.getByRole("button", { name: "Submit reading" })); await screen.findByRole("heading", { name: "Your agency report" });
    expect(api.submit.mock.calls[1][1]).toBe(api.submit.mock.calls[0][1]); expect(api.submit.mock.calls[1][0].contextId).toBe("context-1");
  });
  it("labels preview data and shows the existing receipt without another submission", async () => {
    api.context.mockResolvedValue({ ...guestReceipt(), uiPreview: true }); render(<AgencyReadingPage />); await screen.findByRole("heading", { name: "Your agency report" });
    expect(screen.getByRole("note")).toHaveTextContent("sample data only"); expect(screen.getByRole("note")).toHaveTextContent("not connected"); expect(screen.queryByRole("button", { name: "Submit reading" })).not.toBeInTheDocument(); expect(api.submit).not.toHaveBeenCalled();
  });
  it("downloads the own report through its fixed context and revokes the temporary URL", async () => {
    api.context.mockResolvedValue(guestReceipt()); api.receipt.mockResolvedValue(new Blob(["%PDF"], { type: "application/pdf" }));
    const createDescriptor = Object.getOwnPropertyDescriptor(URL, "createObjectURL"), revokeDescriptor = Object.getOwnPropertyDescriptor(URL, "revokeObjectURL");
    const create = vi.fn(() => "blob:own-report"), revoke = vi.fn();
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: create }); Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revoke });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    try {
      render(<AgencyReadingPage />); await screen.findByRole("button", { name: "Download your PDF" }); await userEvent.click(screen.getByRole("button", { name: "Download your PDF" }));
      await waitFor(() => expect(api.receipt).toHaveBeenCalledExactlyOnceWith("context-1")); expect(click).toHaveBeenCalledOnce(); expect(create).toHaveBeenCalledOnce();
      await waitFor(() => expect(revoke).toHaveBeenCalledWith("blob:own-report"), { timeout: 2000 });
    } finally {
      if (createDescriptor) Object.defineProperty(URL, "createObjectURL", createDescriptor); else Reflect.deleteProperty(URL, "createObjectURL");
      if (revokeDescriptor) Object.defineProperty(URL, "revokeObjectURL", revokeDescriptor); else Reflect.deleteProperty(URL, "revokeObjectURL");
    }
  });
});
