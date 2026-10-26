// Approved quantities flow straight into a variation invoice: payer and paid
// declaration come from the voyage, rates from the variation tariff.
import { quantityDifference } from "./comparison";
import type { PaidDeclaration, PreviewInvoiceInput, PreviewReport } from "./closeoutPreview";
import { tariffKeyFor, type VariationTariff } from "./tariffs";
import type { MeasurementPlan } from "./types";

const aboveDeclaration = (quantity: string, declared: string | null) => {
  const difference = quantityDifference(quantity, declared);
  return difference !== null && difference !== "0" && !difference.startsWith("-");
};

export function invoiceInputFor(report: PreviewReport, plans: MeasurementPlan[], declaration?: PaidDeclaration, tariff?: VariationTariff | null): PreviewInvoiceInput {
  const sources = [...plans, ...report.sourcePlans];
  return {
    payer: declaration?.payer ?? "",
    currency: tariff?.currency ?? declaration?.currency ?? "USD",
    tariffReference: tariff?.reference ?? "",
    originalInvoiceReference: declaration?.invoiceReference ?? "",
    paymentStatus: declaration?.paymentStatus ?? "unconfirmed",
    originalPaidAmount: declaration?.amountPaid ?? "",
    previousVariationReference: "",
    lines: report.lines.map(line => {
      const cargo = sources.find(plan => plan.id === line.planId)?.lines.find(item => item.id === line.lineId);
      const key = cargo ? tariffKeyFor(cargo) : null;
      const rate = (key && tariff?.rates[key]) || "";
      // Lines with no additional load are never charged; their rate is not needed.
      return { planId: line.planId, lineId: line.lineId, rate: rate || (aboveDeclaration(line.quantity, line.declaredQuantity) ? "" : "0"), previousVariationAmount: "0" };
    }),
  };
}

/** What still stops an invoice being drafted automatically, in plain words. */
export function missingInvoiceDetails(input: PreviewInvoiceInput, report: PreviewReport): string[] {
  const missing: string[] = [];
  if (!input.payer.trim()) missing.push("Payer from the paid declaration");
  if (!input.originalInvoiceReference.trim()) missing.push("Declaration invoice number");
  if (input.paymentStatus !== "paid" && report.lines.some(line => aboveDeclaration(line.quantity, line.declaredQuantity))) missing.push("Confirmation that the declaration is paid");
  if (!input.tariffReference.trim()) missing.push("Variation tariff");
  const unrated = report.lines.filter(line => !input.lines.find(item => item.planId === line.planId && item.lineId === line.lineId)?.rate.trim());
  if (unrated.length) missing.push(`Rate for ${unrated.map(line => line.description).join(", ")}`);
  return missing;
}
