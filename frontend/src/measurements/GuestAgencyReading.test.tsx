import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { GuestAgencyReading } from "./GuestAgencyReading";
import type { GuestPeerReport, GuestReadingContext, GuestReadingInput } from "./guestTypes";

function contextFixture(): GuestReadingContext {
  return {
    contextId: "guest-context-1", agency: { id: "party-1", name: "Harbour Agency", role: "Agent", representative: "Ada Agent" },
    voyage: { vesselName: "MV Atlas", callReference: "CALL-001", title: "Arrival cargo measurement", location: "Berth 3", scheduledAt: "2026-10-05T10:00:00Z" },
    lines: [{ id: "line-1", description: "Wheat", category: "Bulk", direction: "import", containerSize: "", loadStatus: "", unit: "tonnes", basis: "Net metric tonnes" }], ownReport: null,
    completedPeers: [{ id: "peer-report", participantId: "party-2", agencyName: "Terminal Agency", agencyRole: "Terminal operator", submittedAt: "2026-10-05T11:00:00Z", status: "submitted", lines: [{ lineId: "line-1", status: "reported", quantity: "42.125" }] }],
  };
}
function completed(context = contextFixture(), input: GuestReadingInput = { representative: "Ada Agent", observedAt: "2026-10-05T10:30:00Z", sourceReference: "OWN-REF", notes: "Own report note", lines: [{ lineId: "line-1", status: "reported", quantity: "0", note: "Confirmed NIL" }] }): GuestReadingContext {
  return { ...context, ownReport: { ...input, id: "own-report", participantId: context.agency.id, agencyName: context.agency.name, agencyRole: context.agency.role, submittedAt: "2026-10-05T11:30:00Z", status: "submitted" } };
}
function setup(context = contextFixture()) {
  const onSubmit = vi.fn<(input: GuestReadingInput) => Promise<GuestReadingContext>>().mockImplementation(async input => completed(context, input));
  const onDownloadReport = vi.fn<(id: string) => Promise<void>>().mockResolvedValue(undefined);
  const props = { context, onSubmit, onDownloadReport };
  return { ...render(<GuestAgencyReading {...props} />), props, onSubmit, onDownloadReport, user: userEvent.setup() };
}
const sourceField = () => screen.getByRole("textbox", { name: /^Source document reference/ });
const quantity = (label = "Wheat · import") => screen.getByRole("spinbutton", { name: `Measured quantity · ${label}` });
async function fillRequired(user: ReturnType<typeof userEvent.setup>, value = "0") {
  await user.type(sourceField(), "AGENCY-001");
  fireEvent.change(screen.getByLabelText("Observed at"), { target: { value: "2026-10-05T10:30" } });
  await user.type(quantity(), value);
}

describe("guest agency reading presentation", () => {
  it("fixes the agency and voyage, leaves quantities blank and hides peers before submission without auth or network calls", () => {
    const fetch = vi.spyOn(globalThis, "fetch"); setup();
    expect(screen.getByRole("heading", { name: "Record your agency’s reading" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Harbour Agency" })).toBeInTheDocument();
    expect(screen.getByText("MV Atlas")).toBeInTheDocument(); expect(screen.getByText("CALL-001")).toBeInTheDocument();
    expect(screen.getByText(/no account sign-in is needed/)).toBeInTheDocument();
    expect(quantity()).toHaveValue(null); expect(screen.getByText("Not entered yet")).toBeInTheDocument();
    expect(screen.getByText("0 of 1 entered")).toBeInTheDocument(); expect(screen.getByRole("progressbar", { name: "Lines entered" })).toHaveAttribute("aria-valuenow", "0");
    expect(screen.queryByLabelText("Reporting agency")).not.toBeInTheDocument(); expect(screen.queryByText("Terminal Agency")).not.toBeInTheDocument();
    expect(screen.queryByText(/billing|variation invoice/i)).not.toBeInTheDocument(); expect(fetch).not.toHaveBeenCalled();
  });
  it("submits explicit NIL and representative, then shows receipt, own PDF action and completed peers", async () => {
    const { user, onSubmit, onDownloadReport } = setup(); await fillRequired(user);
    expect(screen.getByText("NIL · counted none")).toBeInTheDocument(); expect(screen.getByText("1 of 1 entered")).toBeInTheDocument();
    await user.clear(screen.getByLabelText("Representative")); await user.type(screen.getByLabelText("Representative"), "  Bola Delegate  ");
    expect(screen.queryByLabelText("Reading note · Wheat · import")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Add a note" }));
    await user.type(screen.getByLabelText("Reading note · Wheat · import"), "Counted zero");
    await user.type(screen.getByLabelText("Additional notes (optional)"), "Independent observation");
    await user.click(screen.getByRole("button", { name: "Submit reading" }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "Your agency report" })).toBeInTheDocument());
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith({ representative: "Bola Delegate", observedAt: new Date("2026-10-05T10:30").toISOString(), sourceReference: "AGENCY-001", notes: "Independent observation", lines: [{ lineId: "line-1", status: "reported", quantity: "0", note: "Counted zero" }] });
    for (const field of ["participantId", "recordedBy", "evidenceIds"]) expect(onSubmit.mock.calls[0][0]).not.toHaveProperty(field);
    expect(screen.getByRole("status")).toHaveTextContent("Reading submitted"); expect(screen.getByRole("status")).toHaveTextContent("Reference own-report");
    expect(screen.getByRole("heading", { name: "Your figures" })).toBeInTheDocument(); expect(screen.getByText("Counted zero")).toBeInTheDocument();
    expect(within(screen.getByRole("table", { name: /compared with other agencies/ })).getByText("Terminal Agency")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Submit reading" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Download your PDF" })); expect(onDownloadReport).toHaveBeenCalledExactlyOnceWith("own-report");
  });
  it("requires a reading or N/A with reason and never turns N/A into zero", async () => {
    const { user, onSubmit } = setup(); await user.type(sourceField(), "DOC-NA");
    await user.click(screen.getByRole("button", { name: "Submit reading" })); expect(onSubmit).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Not applicable?" }));
    expect(screen.queryByRole("spinbutton")).not.toBeInTheDocument();
    expect(screen.getByLabelText("N/A reason · Wheat · import")).toBeRequired(); expect(screen.getByText("0 of 1 entered")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Submit reading" })); expect(onSubmit).not.toHaveBeenCalled();
    await user.type(screen.getByLabelText("N/A reason · Wheat · import"), "Outside this agency’s scope"); expect(screen.getByText("1 of 1 entered")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Submit reading" })); await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
    expect(onSubmit.mock.calls[0][0].lines).toEqual([{ lineId: "line-1", status: "not-applicable", quantity: null, note: "Outside this agency’s scope" }]);
    expect(screen.getByRole("heading", { name: "Your figures" }).closest("section")).toHaveTextContent("N/A");
  });
  it("switching back from N/A clears the reason and asks for a figure again", async () => {
    const { user } = setup();
    await user.click(screen.getByRole("button", { name: "Not applicable?" })); await user.type(screen.getByLabelText("N/A reason · Wheat · import"), "Not counted");
    await user.click(screen.getByRole("button", { name: "Enter a figure" }));
    expect(screen.queryByLabelText("N/A reason · Wheat · import")).not.toBeInTheDocument(); expect(quantity()).toHaveValue(null);
    await user.click(screen.getByRole("button", { name: "Not applicable?" })); expect(screen.getByLabelText("N/A reason · Wheat · import")).toHaveValue("");
  });
  it("keeps cargo scope labels unique and enforces integer counts separately from decimal quantities", async () => {
    const context = contextFixture(); context.lines = [
      { ...context.lines[0], id: "container-1", description: "Containers", category: "Container", containerSize: "20", loadStatus: "laden", unit: "count" },
      { ...context.lines[0], id: "container-2", description: "Containers", category: "Container", containerSize: "40", loadStatus: "empty", unit: "count" },
      { ...context.lines[0], id: "liquid-1", description: "Methanol", category: "Liquid", unit: "m3", basis: "Measured volume" },
    ];
    const { user, onSubmit } = setup(context); await user.type(sourceField(), "MIXED-DOC");
    expect(screen.getByRole("heading", { name: "20 ft · Laden" })).toBeInTheDocument(); expect(screen.getByRole("heading", { name: "40 ft · Empty" })).toBeInTheDocument();
    const count = quantity("Containers · import · 20 ft · laden"); expect(count).toHaveAttribute("step", "1"); expect(count).toHaveAttribute("inputmode", "numeric");
    const volume = quantity("Methanol · import"); expect(volume).toHaveAttribute("step", "0.001"); expect(volume).toHaveAttribute("inputmode", "decimal");
    await user.type(count, "1.5"); await user.type(quantity("Containers · import · 40 ft · empty"), "0"); await user.type(volume, "6.125");
    await user.click(screen.getByRole("button", { name: "Submit reading" })); expect(onSubmit).not.toHaveBeenCalled();
    await user.clear(count); await user.type(count, "1"); await user.click(screen.getByRole("button", { name: "Submit reading" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce()); expect(onSubmit.mock.calls[0][0].lines.map(line => line.quantity)).toEqual(["1", "0", "6.125"]);
    expect(screen.queryByText(/total quantity/i)).not.toBeInTheDocument();
  });
  it("keeps the draft and peers hidden after failure and retries without duplicated in-flight submissions", async () => {
    const { user, onSubmit } = setup(); await fillRequired(user, "3.125"); let reject!: (error: Error) => void;
    onSubmit.mockImplementationOnce(() => new Promise((_resolve, rejectPromise) => { reject = rejectPromise; }));
    await user.click(screen.getByRole("button", { name: "Submit reading" })); expect(screen.getByRole("button", { name: "Submitting…" })).toBeDisabled();
    fireEvent.submit(screen.getByRole("button", { name: "Submitting…" }).closest("form")!); expect(onSubmit).toHaveBeenCalledOnce();
    await act(async () => reject(new Error("Unable to confirm this submission. Please retry.")));
    expect(screen.getByRole("alert")).toHaveTextContent("Unable to confirm this submission"); expect(quantity()).toHaveValue(3.125); expect(screen.queryByText("Terminal Agency")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Submit reading" })); await waitFor(() => expect(screen.getByRole("heading", { name: "Your agency report" })).toBeInTheDocument());
    expect(onSubmit).toHaveBeenCalledTimes(2); expect(onSubmit.mock.calls[1][0]).toEqual(onSubmit.mock.calls[0][0]);
  });
  it("shows only submitted peers and suppresses peer private fields", () => {
    const context = completed(); context.completedPeers.push({ ...context.completedPeers[0], id: "draft-report", participantId: "party-draft", agencyName: "Draft agency", status: "draft" } as unknown as GuestPeerReport);
    context.completedPeers.push({ ...context.completedPeers[0], id: "self-report", participantId: "party-1", agencyName: "Duplicate own report" });
    Object.assign(context.completedPeers[0], { notes: "Private peer notes", sourceReference: "PRIVATE-PEER-SOURCE", representative: "Private peer person", evidenceIds: ["private-evidence"] }); Object.assign(context.completedPeers[0].lines[0], { note: "Private line note" });
    setup(context); expect(screen.getByText("Terminal Agency")).toBeInTheDocument(); expect(screen.queryByText("Draft agency")).not.toBeInTheDocument(); expect(screen.queryByText("Duplicate own report")).not.toBeInTheDocument();
    expect(screen.getByText(/1 other agency has submitted/)).toBeInTheDocument();
    expect(screen.queryByText(/Private|PRIVATE/)).not.toBeInTheDocument(); expect(screen.getAllByRole("button")).toHaveLength(1); expect(screen.getByText("Own report note")).toBeInTheDocument();
    expect(within(screen.getByRole("table", { name: /compared with other agencies/ })).getByText("42.125")).toBeInTheDocument();
  });
  it("marks peer figures that differ from the agency's own reading", () => {
    const context = completed(); context.lines.push({ ...context.lines[0], id: "line-2", description: "Maize" });
    context.ownReport!.lines = [{ lineId: "line-1", status: "reported", quantity: "42.125", note: "" }, { lineId: "line-2", status: "reported", quantity: "10", note: "" }];
    context.completedPeers[0].lines = [{ lineId: "line-1", status: "reported", quantity: "42.125" }, { lineId: "line-2", status: "reported", quantity: "12" }];
    setup(context);
    const table = within(screen.getByRole("table", { name: /compared with other agencies/ }));
    const maize = table.getByRole("row", { name: /Maize/ }), wheat = table.getByRole("row", { name: /Wheat/ });
    expect(maize).toHaveTextContent("12 (differs from yours)"); expect(wheat).not.toHaveTextContent("differs from yours");
  });
  it("retains the receipt when a PDF download fails and retries the same own report", async () => {
    const { user, onDownloadReport } = setup(completed()); onDownloadReport.mockRejectedValueOnce(new Error("PDF is temporarily unavailable"));
    await user.click(screen.getByRole("button", { name: "Download your PDF" })); await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("PDF is temporarily unavailable")); expect(screen.getByRole("heading", { name: "Your agency report" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Download your PDF" })); expect(onDownloadReport.mock.calls).toEqual([["own-report"], ["own-report"]]); expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
  it("does not accept a submitted receipt from another context", async () => {
    const { user, onSubmit } = setup(); await fillRequired(user); onSubmit.mockResolvedValueOnce({ ...completed(), contextId: "different-context" });
    await user.click(screen.getByRole("button", { name: "Submit reading" })); expect(await screen.findByRole("alert")).toHaveTextContent("could not be confirmed for this agency");
    expect(quantity()).toHaveValue(0); expect(screen.queryByText("Terminal Agency")).not.toBeInTheDocument(); expect(screen.queryByRole("button", { name: "Download your PDF" })).not.toBeInTheDocument();
  });
  it("clears unsaved quantities when the fixed agency or cargo scope changes", async () => {
    const { user, rerender, props } = setup(); await fillRequired(user, "7"); const other = { ...contextFixture(), agency: { id: "party-2", name: "Other agency", role: "Surveyor", representative: "Other representative" } };
    rerender(<GuestAgencyReading {...props} context={other} />); expect(screen.getByLabelText("Representative")).toHaveValue("Other representative"); expect(quantity()).toHaveValue(null); expect(sourceField()).toHaveValue("");
    await user.type(quantity(), "8"); rerender(<GuestAgencyReading {...props} context={{ ...other, lines: [{ ...other.lines[0], unit: "m3" }] }} />); expect(quantity()).toHaveValue(null);
  });
  it("blocks whitespace-only attribution and handles an empty cargo context", async () => {
    const { user, onSubmit, rerender, props } = setup(); await fillRequired(user); await user.clear(screen.getByLabelText("Representative")); await user.type(screen.getByLabelText("Representative"), "  ");
    await user.click(screen.getByRole("button", { name: "Submit reading" })); expect(screen.getByRole("alert")).toHaveTextContent("Enter a representative"); expect(onSubmit).not.toHaveBeenCalled();
    rerender(<GuestAgencyReading {...props} context={{ ...contextFixture(), lines: [] }} />); expect(screen.getByRole("button", { name: "Submit reading" })).toBeDisabled(); expect(screen.getByText(/No cargo lines are available/)).toBeInTheDocument();
  });
  it("requires a source document reference before submitting", async () => {
    const { user, onSubmit } = setup(); await user.type(quantity(), "5");
    expect(sourceField()).toBeRequired();
    await user.click(screen.getByRole("button", { name: "Submit reading" })); expect(onSubmit).not.toHaveBeenCalled();
    await user.type(sourceField(), "   "); await user.click(screen.getByRole("button", { name: "Submit reading" }));
    expect(screen.getByRole("alert")).toHaveTextContent("source document reference"); expect(onSubmit).not.toHaveBeenCalled();
  });
  it("shows a waiting state when no completed peers are available", () => {
    setup({ ...completed(), completedPeers: [] }); expect(screen.getByText(/No other agency has submitted yet/)).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });
});
