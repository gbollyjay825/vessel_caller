import { useState } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AgencyLinkPanel } from "./AgencyLinkPanel";
import type { CreatedAgencyLink } from "./AgencyCollection";

const first: CreatedAgencyLink = { link: { id: "link-1", participantId: "party-1", expiresAt: "2099-10-12T12:00:00Z", revokedAt: null, submittedAt: null }, url: "https://example.test/agency-reading#token=synthetic-first" };
const second: CreatedAgencyLink = { link: { ...first.link, id: "link-2" }, url: "https://example.test/agency-reading#token=synthetic-second" };

describe("compact agency link panel", () => {
  it("shows the readonly URL, copy and validity with no default expiry selector or advanced actions", async () => {
    const user = userEvent.setup();
    const copy = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    render(<AgencyLinkPanel agencyName="Harbour Agency" link={first} onReplace={vi.fn()} onRevoke={vi.fn()} />);
    expect(screen.getByLabelText("Link for Harbour Agency")).toHaveAttribute("readonly");
    expect(screen.getByLabelText("Link for Harbour Agency")).toHaveValue(first.url);
    expect(screen.getByText(/Valid until/)).toHaveTextContent("2099");
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Replace link" })).not.toBeVisible();
    expect(screen.queryByRole("button", { name: "Revoke link" })).not.toBeVisible();
    await user.click(screen.getByRole("button", { name: "Copy" }));
    expect(copy).toHaveBeenCalledExactlyOnceWith(first.url);
    expect(screen.getByRole("button", { name: "Copied" })).toBeInTheDocument();
  });

  it("shows copy errors and allows retry without changing the link", async () => {
    const user = userEvent.setup();
    const copy = vi.spyOn(navigator.clipboard, "writeText").mockRejectedValueOnce(new Error("Clipboard unavailable")).mockResolvedValue();
    render(<AgencyLinkPanel agencyName="Harbour Agency" link={first} />);
    await user.click(screen.getByRole("button", { name: "Copy" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Clipboard unavailable");
    expect(screen.getByLabelText("Link for Harbour Agency")).toHaveValue(first.url);
    await user.click(screen.getByRole("button", { name: "Copy" }));
    expect(copy).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByText("Link options")).not.toBeInTheDocument();
  });

  it("replaces explicitly, resets copy feedback and revokes the displayed replacement", async () => {
    const user = userEvent.setup();
    vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    const replace = vi.fn().mockResolvedValue(second);
    const revoke = vi.fn().mockResolvedValue(undefined);
    function ControlledPanel() {
      const [link, setLink] = useState(first);
      return <AgencyLinkPanel agencyName="Harbour Agency" link={link} onReplace={async () => { const next = await replace(); setLink(next); return next; }} onRevoke={() => revoke(link.link.id)} />;
    }
    render(<ControlledPanel />);
    await user.click(screen.getByRole("button", { name: "Copy" }));
    await user.click(screen.getByText("Link options"));
    await user.click(screen.getByRole("button", { name: "Replace link" }));
    expect(replace).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText("Link for Harbour Agency")).toHaveValue(second.url);
    expect(screen.getByRole("button", { name: "Copy" })).toBeInTheDocument();
    await user.click(screen.getByText("Link options"));
    await user.click(screen.getByRole("button", { name: "Revoke link" }));
    expect(revoke).toHaveBeenCalledExactlyOnceWith("link-2");
    expect(screen.getByRole("status")).toHaveTextContent("Link revoked");
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("preserves the URL after failed revoke and prevents duplicate pending actions", async () => {
    const user = userEvent.setup();
    let reject: (error: Error) => void = () => {};
    const revoke = vi.fn().mockImplementation(() => new Promise((_resolve, fail) => { reject = fail; }));
    render(<AgencyLinkPanel agencyName="Harbour Agency" link={first} onRevoke={revoke} />);
    await user.click(screen.getByText("Link options"));
    await user.dblClick(screen.getByRole("button", { name: "Revoke link" }));
    expect(revoke).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Copy" })).toBeDisabled();
    reject(new Error("Revocation unavailable"));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Revocation unavailable"));
    expect(screen.getByLabelText("Link for Harbour Agency")).toHaveValue(first.url);
    expect(screen.getByRole("button", { name: "Revoke link" })).toBeEnabled();
  });

  it("does not expose an already revoked URL", () => {
    render(<AgencyLinkPanel agencyName="Harbour Agency" link={{ ...first, link: { ...first.link, revokedAt: "2026-10-05T12:00:00Z" } }} />);
    expect(screen.getByRole("status")).toHaveTextContent("Link revoked");
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });
});
