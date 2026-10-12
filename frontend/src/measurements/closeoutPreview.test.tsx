import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { calculateVariation, closeoutStorageKey, currentReport, reconciliationIssues, useCloseoutPreview, useCloseoutPreviews, voyageInputFingerprint, type PreviewInvoiceInput, type PreviewReport } from "./closeoutPreview";
import { measurementFixture } from "./fixtures.test-support";

const actor = { id: "reviewer", name: "NPA Reviewer" };
const readyPlan = () => {
  const plan = measurementFixture();
  plan.submissions.push({ ...plan.submissions[0], id: "sub-2", participantId: "party-2" });
  return plan;
};
const approval = { reason: "Checked agency figures", lines: [{ planId: "plan-1", lineId: "line-1", quantity: "19508", reason: "Joint survey" }] };
const invoiceInput: PreviewInvoiceInput = { payer: "Vessel Owner", currency: "USD", tariffReference: "Manual rate", originalInvoiceReference: "ORIG-001", paymentStatus: "paid", originalPaidAmount: "195000.00", previousVariationReference: "", lines: [{ planId: "plan-1", lineId: "line-1", rate: "10", previousVariationAmount: "0" }] };
const report = (declared = "19500", final = "19508"): PreviewReport => ({ id: "report-1", callId: "call-1", revision: 1, sourceFingerprint: voyageInputFingerprint([readyPlan()]), approvedAt: "2026-10-12T10:00:00Z", approvedBy: actor, reason: "Verified", lines: [{ planId: "plan-1", lineId: "line-1", description: "Wheat", unit: "tonnes", declaredQuantity: declared, quantity: final, reason: "Joint survey" }], sourcePlans: [readyPlan()] });

describe("closeout preview calculations and isolation", () => {
  beforeEach(() => window.localStorage.clear());

  it("charges only excess over the declaration; original paid invoice is not deducted from variation", () => {
    const result = calculateVariation(report(), invoiceInput.lines);
    expect(result.total).toBe("80.00");
    expect(result.lines[0].variance).toBe("8");
    expect(result.status).toBe("draft");
  });

  it("rounds decimal quantities and rates in cents, and deducts previous variation charges exactly", () => {
    const result = calculateVariation(report("0.100", "0.300"), [{ ...invoiceInput.lines[0], rate: "0.1250", previousVariationAmount: "0.01" }]);
    expect(result.lines[0].entitlement).toBe("0.03");
    expect(result.total).toBe("0.02");
  });

  it("flags a lower quantity for review without credit or netting against other cargo", () => {
    const mixed = report("100", "90");
    mixed.lines.push({ ...mixed.lines[0], lineId: "positive", unit: "count", declaredQuantity: "10", quantity: "20" });
    const result = calculateVariation(mixed, [...invoiceInput.lines, { ...invoiceInput.lines[0], lineId: "positive" }]);
    expect(result.status).toBe("overpayment-review");
    expect(result.total).toBe("0.00");
    expect(result.lines[0].status).toBe("overpayment-review");
    expect(result.lines[1].amount).toBe("100.00");
  });

  it("handles no additional charge and previous variation exceeding entitlement", () => {
    expect(calculateVariation(report("100", "100"), invoiceInput.lines).status).toBe("no-charge");
    const result = calculateVariation(report(), [{ ...invoiceInput.lines[0], previousVariationAmount: "90.00" }]);
    expect(result.status).toBe("held");
    expect(result.total).toBe("0.00");
  });

  it("does not turn a missing baseline or invalid rate into zero", () => {
    const missing = report(); missing.lines[0].declaredQuantity = null;
    expect(calculateVariation(missing, invoiceInput.lines).issues).not.toHaveLength(0);
    expect(calculateVariation(report(), [{ ...invoiceInput.lines[0], rate: "-5" }]).status).toBe("held");
    expect(calculateVariation(report(), [...invoiceInput.lines, invoiceInput.lines[0]]).issues).not.toHaveLength(0);
  });

  it("requires complete required submissions or an explained N/A", () => {
    const plan = measurementFixture();
    expect(reconciliationIssues([plan]).join(" ")).toContain("Terminal One");
    plan.submissions.push({ ...plan.submissions[0], id: "sub-2", participantId: "party-2", lines: [{ lineId: "line-1", status: "not-applicable", quantity: null, note: "No bulk operation" }] });
    expect(reconciliationIssues([plan])).toEqual([]);
  });

  it("preserves approved snapshots, invalidates changed readings and prevents duplicate drafts", () => {
    const plan = readyPlan();
    const { result } = renderHook(() => useCloseoutPreview("org-1", "call-1"));
    let approved: PreviewReport | null = null;
    act(() => { approved = result.current.approveReport([plan], approval, actor); });
    expect(approved).not.toBeNull();
    act(() => { result.current.createInvoice([plan], approved!.id, invoiceInput, actor); });
    act(() => { result.current.createInvoice([plan], approved!.id, invoiceInput, actor); });
    expect(result.current.record.invoices).toHaveLength(1);
    expect(result.current.record.invoices[0].total).toBe("80.00");
    plan.submissions[0].revision++;
    plan.submissions[0].lines[0].quantity = "19512";
    expect(currentReport([plan], result.current.record)).toBeUndefined();
    expect(result.current.record.reports[0].sourcePlans[0].submissions[0].lines[0].quantity).toBe("19508.000");
    act(() => { result.current.createInvoice([plan], approved!.id, invoiceInput, actor); });
    expect(result.current.error).toMatch(/current reconciliation/);
    expect(result.current.record.invoices).toHaveLength(1);
  });

  it("hides records across organisation changes and rejects another voyage's approval", () => {
    const { result, rerender } = renderHook(({ org }) => useCloseoutPreview(org, "call-1"), { initialProps: { org: "org-1" } });
    act(() => { result.current.approveReport([readyPlan()], approval, actor); });
    expect(result.current.record.reports).toHaveLength(1);
    rerender({ org: "org-2" });
    expect(result.current.record.reports).toHaveLength(0);
    const other = readyPlan(); other.callId = "call-2";
    act(() => { result.current.approveReport([other], approval, actor); });
    expect(result.current.error).toContain("another voyage");
  });

  it("makes restoring earlier draft details a new latest version for the dashboard", () => {
    const { result } = renderHook(() => useCloseoutPreview("org-1", "call-1"));
    act(() => { result.current.approveReport([readyPlan()], approval, actor); });
    const id = result.current.record.reports[0].id;
    act(() => { result.current.createInvoice([readyPlan()], id, invoiceInput, actor); });
    act(() => { result.current.createInvoice([readyPlan()], id, { ...invoiceInput, lines: [{ ...invoiceInput.lines[0], rate: "20" }] }, actor); });
    act(() => { result.current.createInvoice([readyPlan()], id, invoiceInput, actor); });
    expect(result.current.record.invoices).toHaveLength(3);
    expect(result.current.record.invoices.at(-1)?.total).toBe("80.00");
  });

  it.each(["invoice-line", "invoice-payer", "event-action"])("preserves malformed nested %s records rather than crashing their UI", (corruption) => {
    const { result, unmount } = renderHook(() => useCloseoutPreview("org-1", "call-1"));
    act(() => { result.current.approveReport([readyPlan()], approval, actor); });
    act(() => { result.current.createInvoice([readyPlan()], result.current.record.reports[0].id, invoiceInput, actor); });
    unmount();
    const key = closeoutStorageKey("org-1")!;
    const stored = JSON.parse(window.localStorage.getItem(key)!);
    if (corruption === "invoice-line") delete stored.records[0].invoices[0].lines[0].rate;
    if (corruption === "invoice-payer") delete stored.records[0].invoices[0].payer;
    if (corruption === "event-action") stored.records[0].events[0].action = "unknown";
    const malformed = JSON.stringify(stored);
    window.localStorage.setItem(key, malformed);
    const reread = renderHook(() => useCloseoutPreview("org-1", "call-1"));
    expect(reread.result.current.error).toContain("preserved");
    expect(reread.result.current.record.invoices).toHaveLength(0);
    expect(window.localStorage.getItem(key)).toBe(malformed);
  });

  it("fails closed on corrupt saved state without overwriting it", () => {
    const key = closeoutStorageKey("org-1")!;
    window.localStorage.setItem(key, "broken");
    const { result } = renderHook(() => useCloseoutPreview("org-1", "call-1"));
    act(() => { result.current.approveReport([readyPlan()], approval, actor); });
    expect(result.current.error).toContain("preserved");
    expect(window.localStorage.getItem(key)).toBe("broken");
  });

  it("publishes preview events to dashboard subscriptions, without requiring original paid amount", () => {
    const dashboard = renderHook(() => useCloseoutPreviews("org-1"));
    const voyage = renderHook(() => useCloseoutPreview("org-1", "call-1"));
    act(() => { voyage.result.current.approveReport([readyPlan()], approval, actor); });
    const id = voyage.result.current.record.reports[0].id;
    act(() => { voyage.result.current.createInvoice([readyPlan()], id, { ...invoiceInput, originalPaidAmount: "" }, actor); });
    expect(dashboard.result.current.records[0].events.map(event => event.action)).toEqual(["report-approved", "invoice-drafted"]);
    expect(dashboard.result.current.records[0].invoices[0].originalPaidAmount).toBe("");
  });
});
