import { describe, expect, it } from "vitest";
import { voyageInputFingerprint, type PaidDeclaration, type PreviewReport } from "./closeoutPreview";
import { measurementFixture } from "./fixtures.test-support";
import { invoiceInputFor, missingInvoiceDetails } from "./invoiceDraft";
import type { VariationTariff } from "./tariffs";

const actor = { id: "reviewer", name: "NPA Reviewer" };
const plan = measurementFixture();
const report = (lines: [string, string, string][]): PreviewReport => ({
  id: "report-1", callId: "call-1", revision: 1, status: "approved", preparedAt: "2026-10-12T08:00:00Z", preparedBy: actor, approvedAt: "2026-10-12T09:00:00Z", approvedBy: actor,
  sourceFingerprint: voyageInputFingerprint([plan]), reason: "Checked", sourcePlans: [plan],
  lines: lines.map(([lineId, declared, final]) => ({ planId: "plan-1", lineId, description: "Wheat", unit: "tonnes", declaredQuantity: declared, quantity: final, reason: "Joint survey" })),
});
const declaration: PaidDeclaration = { payer: "Atlas Owner", agent: "", invoiceReference: "DECL-001", amountPaid: "1000", currency: "NGN", paidOn: "", paymentStatus: "paid", updatedAt: "2026-10-01T00:00:00Z", updatedBy: actor };
const tariff: VariationTariff = { currency: "USD", reference: "Tariff 2026", rates: { "bulk:tonnes": "10" }, updatedAt: "2026-10-01T00:00:00Z", updatedBy: actor };

describe("variation invoice draft input", () => {
  it("takes the payer from the paid declaration and the rate from the tariff", () => {
    const input = invoiceInputFor(report([["line-1", "100", "110"]]), [plan], declaration, tariff);
    expect(input).toMatchObject({ payer: "Atlas Owner", originalInvoiceReference: "DECL-001", paymentStatus: "paid", originalPaidAmount: "1000", tariffReference: "Tariff 2026", currency: "USD" });
    expect(input.lines).toEqual([{ planId: "plan-1", lineId: "line-1", rate: "10", previousVariationAmount: "0" }]);
    expect(missingInvoiceDetails(input, report([["line-1", "100", "110"]]))).toEqual([]);
  });

  it("needs no rate for a line at or below the declaration, but asks for one above it", () => {
    const below = report([["line-1", "100", "90"]]);
    const input = invoiceInputFor(below, [plan], declaration, null);
    expect(input.lines[0].rate).toBe("0");
    expect(input.currency).toBe("NGN");
    expect(missingInvoiceDetails(input, below)).toEqual(["Variation tariff"]);
    const above = report([["line-1", "100", "110"]]);
    expect(invoiceInputFor(above, [plan], declaration, null).lines[0].rate).toBe("");
  });

  it("lists everything missing in plain words when nothing is recorded yet", () => {
    const above = report([["line-1", "100", "110"]]);
    expect(missingInvoiceDetails(invoiceInputFor(above, [plan]), above)).toEqual([
      "Payer from the paid declaration", "Declaration invoice number", "Confirmation that the declaration is paid", "Variation tariff", "Rate for Wheat",
    ]);
  });
});
