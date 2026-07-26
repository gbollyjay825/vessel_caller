import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Invoice } from "../types";
import { Invoices } from "./Invoices";

const storeMock = vi.hoisted(() => ({
  invoices: [] as Invoice[],
  calls: [
    {
      id: "call-1",
      vesselName: "MV Test",
      reference: "ROT-2026-0001",
      type: "Tanker",
      flag: "NG",
      nrt: 10_000,
      eta: "2026-07-26T08:00:00Z",
      sailingEta: "2026-07-27T08:00:00Z",
      berth: "Calabar Port",
      berthDate: "2026-07-26",
      status: "completed",
      notes: "",
      version: 2,
      registered: "2026-07-25T08:00:00Z",
    },
  ],
  inspections: [
    {
      id: "inspection-1",
      reference: "INS-2026-0001",
      callId: "call-1",
      vesselName: "MV Test",
      cargoType: "Liquid",
      product: "PMS",
      reconciledTonnage: 1_000,
      jetty: { type: "International" },
      liquid: {},
      dry: null,
      date: "2026-07-26T09:00:00Z",
      status: "completed",
      version: 2,
    },
  ],
  settings: {
    commissionRate: 5,
    exchangeRate: 1_500,
    liquidDuesRates: { government: 1, private: 2, international: 3 },
    dryDuesRate: 1,
    portName: "Calabar",
    terminals: ["Calabar Port"],
  },
  can: vi.fn(),
  financialsForCall: vi.fn(),
  recordPayment: vi.fn(),
  reversePayment: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("../app/store", () => ({
  useStore: () => storeMock,
}));

function invoice(payment: Invoice["payment"] = null): Invoice {
  return {
    id: "invoice-1",
    invoiceNo: "INV-2026-0001",
    callId: "call-1",
    inspectionId: "inspection-1",
    cargoType: "Liquid",
    issued: "2026-07-26",
    due: "2099-08-09",
    status: payment ? "paid" : "unpaid",
    dues: 30_000,
    rate: 3,
    commissionUsd: 1_500,
    commissionNgn: 2_250_000,
    fx: 1_500,
    payment,
  };
}

describe("Invoices payment workflow", () => {
  beforeEach(() => {
    storeMock.can.mockReset();
    storeMock.can.mockReturnValue(true);
    storeMock.financialsForCall.mockReset();
    storeMock.recordPayment.mockReset();
    storeMock.recordPayment.mockResolvedValue(undefined);
    storeMock.reversePayment.mockReset();
    storeMock.reversePayment.mockResolvedValue(undefined);
    storeMock.toast.mockReset();
    storeMock.invoices = [invoice()];
  });

  it("records a normalized payment with a required external reference", async () => {
    render(<Invoices />);
    await userEvent.click(screen.getByRole("row", { name: /INV-2026-0001/ }));

    const record = screen.getByRole("button", { name: /Record payment/ });
    expect(record).toBeDisabled();
    await userEvent.type(screen.getByLabelText("Payment reference"), "NPA-TRF-88214");
    await userEvent.click(record);

    expect(storeMock.recordPayment).toHaveBeenCalledWith("invoice-1", {
      paidOn: expect.any(String),
      method: "Bank transfer",
      reference: "NPA-TRF-88214",
    });
    expect(storeMock.toast).toHaveBeenCalledWith(
      "Payment recorded for INV-2026-0001",
      "success",
    );
  });

  it("reverses rather than deleting an immutable payment", async () => {
    storeMock.invoices = [invoice({
      id: "payment-1",
      amount: 30_000,
      paidOn: "2026-07-27",
      method: "Bank transfer",
      reference: "NPA-TRF-88214",
      recordedBy: "user-1",
      recordedAt: "2026-07-27T10:00:00Z",
      reversedAt: null,
      reversedBy: null,
      reversalReason: null,
    })];
    render(<Invoices />);
    await userEvent.click(screen.getByRole("row", { name: /INV-2026-0001/ }));
    await userEvent.click(screen.getByRole("button", { name: "Reverse payment" }));

    const confirm = screen.getByRole("button", { name: "Confirm reversal" });
    expect(confirm).toBeDisabled();
    await userEvent.type(screen.getByLabelText(/Reversal reason/), "Duplicate bank entry");
    await userEvent.click(confirm);

    expect(storeMock.reversePayment).toHaveBeenCalledWith("payment-1", "Duplicate bank entry");
    expect(storeMock.toast).toHaveBeenCalledWith(
      "Payment reversed for INV-2026-0001",
      "info",
    );
  });
});
