import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgencyCollection, type AgencyLinkInfo } from "./AgencyCollection";
import { measurementFixture, reconciliationFixture } from "./fixtures.test-support";
import type { MeasurementPlan } from "./types";

vi.mock("./WorkflowForms", () => ({ ReturnForm: ({ initialParticipantId, onCancel, onSave }: { initialParticipantId: string; onCancel: () => void; onSave: (input: unknown) => Promise<void> }) => <div><p>Entry for {initialParticipantId}</p><button onClick={onCancel}>Cancel entry</button><button onClick={() => void onSave({ participantId: initialParticipantId })}>Save entry</button></div> }));

const created = { link: { id: "link-1", participantId: "party-2", expiresAt: "2099-10-12T12:00:00Z", revokedAt: null, submittedAt: null }, url: "https://example.test/agency-reading#token=synthetic-demo-token" };
const renderCollection = (plan: MeasurementPlan = measurementFixture(), props: Partial<React.ComponentProps<typeof AgencyCollection>> = {}) => render(<AgencyCollection plan={plan} canManage onSubmit={vi.fn()} {...props} />);
const row = (name: string) => within(screen.getByRole("row", { name: new RegExp(`^${name}`) }));
const panel = () => within(screen.getByRole("complementary"));
// Row actions append visually hidden context; jsdom joins it without the space a browser keeps.
const sr = (text: string) => (name: string) => name.replace(/\s+/g, "") === text.replace(/\s+/g, "");

describe("agency readings tracker", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("lists each agency with how it reports and its status, and stops before reconciliation", async () => {
    renderCollection(undefined, { declarationHref: "/app/measurements/voyages/call-1/declaration" });
    expect(screen.getByRole("heading", { name: "Agency readings · 1 of 2 submitted" })).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "Agency readings submitted" })).toHaveAttribute("aria-valuenow", "1");
    expect(screen.getByRole("link", { name: "View declaration" })).toHaveAttribute("href", "/app/measurements/voyages/call-1/declaration");
    expect(screen.queryByRole("button", { name: /reconcil|invoice|bill/i })).not.toBeInTheDocument();
    expect(row("Harbour Agent").getByText("Submitted")).toBeInTheDocument();
    expect(row("Harbour Agent").getByText("Entered by NPA staff")).toBeInTheDocument();
    expect(row("Terminal One").getByText("Not invited")).toBeInTheDocument();
    expect(row("Terminal One").getByText("Not chosen yet")).toBeInTheDocument();
    expect(screen.queryByText("19,508")).not.toBeInTheDocument();
    await userEvent.click(row("Harbour Agent").getByRole("button", { name: sr("View Harbour Agent reading") }));
    expect(screen.getByRole("table", { name: "Submitted reading" })).toHaveTextContent("19,508");
    expect(screen.getByText(/entered by Ada Operations · 1 supporting file/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: sr("Hide Harbour Agent reading") }));
    expect(screen.queryByRole("table", { name: "Submitted reading" })).not.toBeInTheDocument();
  });

  it("derives link status from the newest unused link per agency", () => {
    const plan = measurementFixture();
    plan.participants.push(
      { ...plan.participants[1], id: "party-3", name: "Survey Co" },
      { ...plan.participants[1], id: "party-4", name: "Tally Unit" },
      { ...plan.participants[1], id: "party-5", name: "Port Health", requiredSubmission: false },
    );
    const links: AgencyLinkInfo[] = [
      created.link,
      { ...created.link, id: "used", submittedAt: "2026-10-05T12:00:00Z", expiresAt: "2199-01-01T00:00:00Z" },
      { ...created.link, id: "expired", participantId: "party-3", expiresAt: "2000-01-01T00:00:00Z" },
      { ...created.link, id: "revoked", participantId: "party-4", revokedAt: "2026-10-05T12:00:00Z" },
      { ...created.link, id: "other", participantId: "not-this-plan" },
    ];
    renderCollection(plan, { links, onCreateLink: vi.fn() });
    expect(row("Terminal One").getByText(/^Link sent · expires/)).toBeInTheDocument();
    expect(row("Terminal One").getByText("Waiting for the agency")).toBeInTheDocument();
    expect(row("Terminal One").getByRole("button", { name: sr("Link options for Terminal One") })).toBeInTheDocument();
    expect(row("Survey Co").getByText("Link expired")).toBeInTheDocument();
    expect(row("Survey Co").getByRole("button", { name: sr("Send link for Survey Co") })).toBeInTheDocument();
    expect(row("Tally Unit").getByText("Link revoked")).toBeInTheDocument();
    expect(row("Port Health").getByText("Not invited")).toBeInTheDocument();
    expect(row("Port Health").getByText(/optional/)).toBeInTheDocument();
    expect(row("Harbour Agent").queryByRole("button", { name: /Send link|Link options/ })).not.toBeInTheDocument();
  });

  it("flags a link that expires within two days", () => {
    const soon = { ...created.link, expiresAt: new Date(Date.now() + 86_400_000).toISOString() };
    renderCollection(undefined, { links: [soon] });
    expect(row("Terminal One").getByText(/^Link sent · expires/)).toHaveClass("red");
  });

  it("opens the chosen agency inline and saves using the version at form opening", async () => {
    const plan = measurementFixture();
    const submit = vi.fn().mockResolvedValue(undefined);
    const { rerender } = renderCollection(plan, { onSubmit: submit });
    expect(row("Harbour Agent").getByRole("button", { name: sr("Revise reading for Harbour Agent") })).toBeInTheDocument();
    await userEvent.click(row("Terminal One").getByRole("button", { name: sr("Enter reading for Terminal One") }));
    expect(screen.getByRole("heading", { name: "Enter reading · Terminal One" })).toBeInTheDocument();
    expect(screen.getByText("Entry for party-2")).toBeInTheDocument();
    rerender(<AgencyCollection plan={{ ...plan, version: 5 }} canManage onSubmit={submit} />);
    expect(screen.getByRole("alert")).toHaveTextContent("This voyage sheet changed");
    await userEvent.click(screen.getByRole("button", { name: "Save entry" }));
    expect(submit).toHaveBeenCalledWith({ participantId: "party-2" }, 4);
    expect(screen.queryByRole("heading", { name: "Enter reading · Terminal One" })).not.toBeInTheDocument();
  });

  it("closes the inline entry without saving", async () => {
    const submit = vi.fn();
    renderCollection(undefined, { onSubmit: submit });
    await userEvent.click(row("Terminal One").getByRole("button", { name: sr("Enter reading for Terminal One") }));
    await userEvent.click(screen.getByRole("button", { name: "Close reading entry" }));
    expect(screen.queryByText("Entry for party-2")).not.toBeInTheDocument();
    expect(submit).not.toHaveBeenCalled();
  });

  it("creates a link with the chosen expiry, copies it and prepares an email", async () => {
    const create = vi.fn().mockResolvedValue(created);
    const user = userEvent.setup();
    const copy = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    renderCollection(undefined, { onCreateLink: create });
    await user.click(row("Terminal One").getByRole("button", { name: sr("Send link for Terminal One") }));
    expect(panel().getByRole("heading", { name: "Send a secure link" })).toBeInTheDocument();
    await user.selectOptions(panel().getByLabelText("Link expires"), "14");
    await user.click(panel().getByRole("button", { name: "Create link" }));
    expect(create).toHaveBeenCalledExactlyOnceWith("party-2", 14);
    expect(panel().getByRole("heading", { name: "Share the secure link" })).toBeInTheDocument();
    expect(panel().getByLabelText("Link for Terminal One")).toHaveValue(created.url);
    expect(row("Terminal One").getByText(/^Link sent · expires/)).toBeInTheDocument();
    await user.click(panel().getByRole("button", { name: "Copy" }));
    expect(copy).toHaveBeenCalledWith(created.url);
    expect(panel().getByRole("button", { name: "Copied" })).toBeInTheDocument();
    const email = panel().getByText("Email the link").closest("a")!;
    expect(email).toHaveAttribute("aria-disabled", "true");
    expect(email).not.toHaveAttribute("href");
    await user.type(panel().getByRole("textbox", { name: /^Agency email/ }), "tunde@terminal.example");
    expect(email).toHaveAttribute("aria-disabled", "false");
    const href = email.getAttribute("href")!;
    expect(href.startsWith("mailto:tunde%40terminal.example?subject=")).toBe(true);
    expect(decodeURIComponent(href)).toContain(created.url);
    expect(decodeURIComponent(href)).toContain("MV Atlas · CALL-001");
    await user.click(panel().getByRole("button", { name: "Close link panel" }));
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
  });

  it("keeps a link creation failure visible, retries and revokes the generated link", async () => {
    const create = vi.fn().mockRejectedValueOnce(new Error("Unable to issue link")).mockResolvedValue(created);
    const revoke = vi.fn().mockResolvedValue(undefined);
    renderCollection(undefined, { onCreateLink: create, onRevokeLink: revoke });
    await userEvent.click(row("Terminal One").getByRole("button", { name: sr("Send link for Terminal One") }));
    await userEvent.click(panel().getByRole("button", { name: "Create link" }));
    expect(panel().getByRole("alert")).toHaveTextContent("Unable to issue link");
    await userEvent.click(panel().getByRole("button", { name: "Create link" }));
    expect(panel().queryByRole("alert")).not.toBeInTheDocument();
    await userEvent.click(panel().getByText("Link options", { exact: true }));
    await userEvent.click(panel().getByRole("button", { name: "Revoke link" }));
    expect(revoke).toHaveBeenCalledWith("link-1");
    expect(screen.queryByLabelText("Link for Terminal One")).not.toBeInTheDocument();
    expect(row("Terminal One").getByText("Link revoked")).toBeInTheDocument();
  });

  it("offers replace or revoke for an existing link without showing its address", async () => {
    const create = vi.fn().mockResolvedValue({ ...created, link: { ...created.link, id: "link-2" }, url: "https://example.test/agency-reading#token=replacement" });
    const revoke = vi.fn().mockResolvedValue(undefined);
    renderCollection(undefined, { links: [created.link], onCreateLink: create, onRevokeLink: revoke });
    await userEvent.click(row("Terminal One").getByRole("button", { name: sr("Link options for Terminal One") }));
    expect(panel().getByRole("heading", { name: "Link sent" })).toBeInTheDocument();
    expect(panel().getByText(/its address is shown only when it is created/)).toBeInTheDocument();
    expect(panel().queryByRole("textbox")).not.toBeInTheDocument();
    await userEvent.click(panel().getByRole("button", { name: "Replace link" }));
    expect(create).toHaveBeenCalledWith("party-2", 7);
    expect(panel().getByLabelText("Link for Terminal One")).toHaveValue("https://example.test/agency-reading#token=replacement");
    expect(revoke).not.toHaveBeenCalled();
  });

  it("revokes an existing link from the panel", async () => {
    const revoke = vi.fn().mockResolvedValue(undefined);
    renderCollection(undefined, { links: [created.link], onCreateLink: vi.fn(), onRevokeLink: revoke });
    await userEvent.click(row("Terminal One").getByRole("button", { name: sr("Link options for Terminal One") }));
    await userEvent.click(panel().getByRole("button", { name: "Revoke link" }));
    expect(revoke).toHaveBeenCalledExactlyOnceWith("link-1");
    expect(row("Terminal One").getByText("Link revoked")).toBeInTheDocument();
    expect(panel().getByRole("heading", { name: "Send a secure link" })).toBeInTheDocument();
  });

  it("explains when secure links are not enabled", async () => {
    renderCollection();
    await userEvent.click(row("Terminal One").getByRole("button", { name: sr("Send link for Terminal One") }));
    expect(panel().getByText("Secure agency links are not enabled on this server yet.")).toBeInTheDocument();
    expect(panel().queryByRole("button", { name: "Create link" })).not.toBeInTheDocument();
  });

  it("downloads only the selected submitted agency PDF and shows a failure on that row", async () => {
    const download = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("PDF unavailable"));
    renderCollection(undefined, { onDownloadSubmission: download });
    await userEvent.click(row("Harbour Agent").getByRole("button", { name: sr("PDF for Harbour Agent") }));
    expect(download).toHaveBeenCalledWith("sub-1");
    expect(row("Terminal One").queryByRole("button", { name: /PDF/ })).not.toBeInTheDocument();
    await userEvent.click(row("Harbour Agent").getByRole("button", { name: sr("PDF for Harbour Agent") }));
    expect(row("Harbour Agent").getByRole("alert")).toHaveTextContent("PDF unavailable");
  });

  it.each(["cancelled", "final", "viewer"] as const)("prevents collection changes for %s", mode => {
    const plan = measurementFixture();
    if (mode === "cancelled") plan.status = "cancelled";
    if (mode === "final") { const final = reconciliationFixture(); final.status = "final"; plan.reconciliations = [final]; }
    renderCollection(plan, { canManage: mode !== "viewer", onCreateLink: vi.fn(), onDownloadSubmission: vi.fn() });
    expect(screen.queryByRole("button", { name: /Enter reading|Revise reading|Send link|Link options/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: sr("PDF for Harbour Agent") })).toBeInTheDocument();
    if (mode === "cancelled") expect(screen.getByRole("status")).toHaveTextContent("cancelled");
    if (mode === "final") expect(screen.getByRole("status")).toHaveTextContent("final result");
    if (mode === "viewer") expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it.each(["cancelled", "final", "viewer"] as const)("hides an open reading form and link panel when the voyage becomes %s", async mode => {
    const plan = measurementFixture();
    const submit = vi.fn();
    const { rerender } = renderCollection(plan, { onSubmit: submit, onCreateLink: vi.fn() });
    await userEvent.click(row("Terminal One").getByRole("button", { name: sr("Enter reading for Terminal One") }));
    expect(screen.getByRole("button", { name: "Save entry" })).toBeInTheDocument();
    const next = { ...plan };
    if (mode === "cancelled") next.status = "cancelled";
    if (mode === "final") { const final = reconciliationFixture(); final.status = "final"; next.reconciliations = [final]; }
    rerender(<AgencyCollection plan={next} canManage={mode !== "viewer"} onSubmit={submit} onCreateLink={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Save entry" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /^Enter reading/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
    expect(submit).not.toHaveBeenCalled();
  });
});
