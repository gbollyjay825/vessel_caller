import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgencyCollection } from "./AgencyCollection";
import { measurementFixture, reconciliationFixture } from "./fixtures.test-support";
import type { MeasurementPlan } from "./types";

vi.mock("./WorkflowForms", () => ({ ReturnForm: ({ initialParticipantId, onCancel, onSave }: { initialParticipantId: string; onCancel: () => void; onSave: (input: unknown) => Promise<void> }) => <div><p>Entry for {initialParticipantId}</p><button onClick={onCancel}>Cancel entry</button><button onClick={() => void onSave({ participantId: initialParticipantId })}>Save entry</button></div> }));

const created = { link: { id: "link-1", participantId: "party-2", expiresAt: "2099-10-12T12:00:00Z", revokedAt: null, submittedAt: null }, url: "https://example.test/agency-reading#token=synthetic-demo-token" };
const renderCollection = (plan: MeasurementPlan = measurementFixture(), props: Partial<React.ComponentProps<typeof AgencyCollection>> = {}) => render(<AgencyCollection plan={plan} canManage onSubmit={vi.fn()} {...props} />);

describe("linear agency collection", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("stops at reporting with separate completed readings and no later workflow actions", async () => {
    renderCollection();
    expect(screen.getByRole("heading", { name: "Report vessel load" })).toBeInTheDocument();
    expect(screen.getByLabelText("Voyage input steps").textContent).toContain("Setup vesselOwner declarationAgencies4Report vessel load");
    expect(screen.queryByRole("button", { name: /reconcil|invoice|bill/i })).not.toBeInTheDocument();
    const agent = within(screen.getByRole("article", { name: "Agency Harbour Agent" }));
    expect(agent.getByText("Submitted", { exact: true })).toBeInTheDocument();
    expect(agent.getByText("19,508")).toBeInTheDocument();
    const terminal = within(screen.getByRole("article", { name: "Agency Terminal One" }));
    expect(terminal.getByText("Awaiting reading")).toBeInTheDocument();
    expect(terminal.queryByText("19,508")).not.toBeInTheDocument();
    await userEvent.click(screen.getByText("View declaration", { exact: true }));
    expect(screen.getByRole("table", { name: "Owner declaration for this voyage" })).toHaveTextContent("19,500");
  });

  it("opens the chosen agency and saves using the version at form opening", async () => {
    const plan = measurementFixture();
    const submit = vi.fn().mockResolvedValue(undefined);
    const { rerender } = renderCollection(plan, { onSubmit: submit });
    await userEvent.click(within(screen.getByRole("article", { name: "Agency Terminal One" })).getByRole("button", { name: "Enter reading" }));
    expect(screen.getByText("Entry for party-2")).toBeInTheDocument();
    rerender(<AgencyCollection plan={{ ...plan, version: 5 }} canManage onSubmit={submit} />);
    expect(screen.getByRole("alert")).toHaveTextContent("This voyage sheet changed");
    await userEvent.click(screen.getByRole("button", { name: "Save entry" }));
    expect(submit).toHaveBeenCalledWith({ participantId: "party-2" }, 4);
    expect(screen.queryByRole("heading", { name: "Enter agency reading" })).not.toBeInTheDocument();
  });

  it("generates and copies an agency-specific link without sending a message", async () => {
    const create = vi.fn().mockResolvedValue(created);
    const user = userEvent.setup();
    const copy = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    renderCollection(undefined, { onCreateLink: create });
    const terminal = within(screen.getByRole("article", { name: "Agency Terminal One" }));
    await user.click(terminal.getByText("Send agency a link", { exact: true }));
    await user.selectOptions(terminal.getByLabelText("Link valid for"), "14");
    await user.click(terminal.getByRole("button", { name: "Generate secure link" }));
    expect(create).toHaveBeenCalledWith("party-2", 14);
    expect(terminal.getByLabelText("Link for Terminal One")).toHaveValue(created.url);
    await user.click(terminal.getByRole("button", { name: "Copy link" }));
    expect(copy).toHaveBeenCalledWith(created.url);
    expect(terminal.getByRole("button", { name: "Copied" })).toBeInTheDocument();
  });

  it("retains and displays a link creation failure and can revoke a generated link", async () => {
    const create = vi.fn().mockRejectedValueOnce(new Error("Unable to issue link")).mockResolvedValue(created);
    const revoke = vi.fn().mockResolvedValue(undefined);
    renderCollection(undefined, { onCreateLink: create, onRevokeLink: revoke });
    const terminal = within(screen.getByRole("article", { name: "Agency Terminal One" }));
    await userEvent.click(terminal.getByText("Send agency a link", { exact: true }));
    await userEvent.click(terminal.getByRole("button", { name: "Generate secure link" }));
    expect(terminal.getByRole("alert")).toHaveTextContent("Unable to issue link");
    await userEvent.click(terminal.getByRole("button", { name: "Generate secure link" }));
    await userEvent.click(terminal.getByRole("button", { name: "Revoke link" }));
    expect(revoke).toHaveBeenCalledWith("link-1");
    expect(terminal.queryByLabelText("Link for Terminal One")).not.toBeInTheDocument();
    expect(terminal.queryByText(/Link active until/)).not.toBeInTheDocument();
  });

  it("shows only active unused links and downloads only the selected submitted agency PDF", async () => {
    const download = vi.fn().mockResolvedValue(undefined);
    renderCollection(undefined, { onDownloadSubmission: download, onCreateLink: vi.fn(), onRevokeLink: vi.fn(), links: [created.link, { ...created.link, id: "expired", expiresAt: "2000-01-01T00:00:00Z" }, { ...created.link, id: "revoked", revokedAt: "2026-10-05T12:00:00Z" }, { ...created.link, id: "used", submittedAt: "2026-10-05T12:00:00Z" }, { ...created.link, id: "other", participantId: "not-this-plan" }] });
    expect(screen.getAllByRole("button", { name: "Revoke link" })).toHaveLength(1);
    const agent = within(screen.getByRole("article", { name: "Agency Harbour Agent" }));
    await userEvent.click(agent.getByRole("button", { name: "Download agency PDF" }));
    expect(download).toHaveBeenCalledWith("sub-1");
    expect(agent.queryByText("Send agency a link", { exact: true })).not.toBeInTheDocument();
  });

  it.each(["cancelled", "final", "viewer"] as const)("prevents collection mutations for %s", mode => {
    const plan = measurementFixture();
    if (mode === "cancelled") plan.status = "cancelled";
    if (mode === "final") { const final = reconciliationFixture(); final.status = "final"; plan.reconciliations = [final]; }
    renderCollection(plan, { canManage: mode !== "viewer", onCreateLink: vi.fn() });
    expect(screen.queryByRole("button", { name: /Enter reading|Revise reading|Generate secure link/ })).not.toBeInTheDocument();
    if (mode === "final") expect(screen.getByRole("link", { name: "View previous reconciliation records" })).toHaveAttribute("href", "/app/measurements/plan-1?workspace=reconciliation");
    if (mode !== "viewer") expect(screen.getByRole("status")).toBeInTheDocument();
  });

  it.each(["cancelled", "final", "viewer"] as const)("hides an open reading form when the voyage becomes %s", async mode => {
    const plan = measurementFixture();
    const submit = vi.fn();
    const { rerender } = renderCollection(plan, { onSubmit: submit });
    await userEvent.click(within(screen.getByRole("article", { name: "Agency Terminal One" })).getByRole("button", { name: "Enter reading" }));
    expect(screen.getByRole("button", { name: "Save entry" })).toBeInTheDocument();
    const next = { ...plan };
    if (mode === "cancelled") next.status = "cancelled";
    if (mode === "final") { const final = reconciliationFixture(); final.status = "final"; next.reconciliations = [final]; }
    rerender(<AgencyCollection plan={next} canManage={mode !== "viewer"} onSubmit={submit} />);
    expect(screen.queryByRole("button", { name: "Save entry" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Enter agency reading" })).not.toBeInTheDocument();
    expect(submit).not.toHaveBeenCalled();
  });
});
