import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Invoice } from "../types";
import { Invoices } from "./Invoices";

const apiMock = vi.hoisted(() => ({
  invoiceAttachments: vi.fn(),
  uploadInvoiceAttachment: vi.fn(),
  invoiceAttachment: vi.fn(),
}));

const workflowSteps = vi.hoisted(() => [
  { id: "draft", code: "draft", label: "Draft", position: 10, active: true, isPaid: false, isTerminal: false, isProtected: false, notifyOnEntry: false, notificationRoles: [] },
  { id: "submitted", code: "submitted", label: "Submitted", position: 20, active: true, isPaid: false, isTerminal: false, isProtected: false, notifyOnEntry: false, notificationRoles: [] },
  { id: "paid", code: "paid", label: "Paid", position: 30, active: true, isPaid: true, isTerminal: true, isProtected: true, notifyOnEntry: false, notificationRoles: [] },
]);

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
  transitionInvoice: vi.fn(),
  invoiceStatusSteps: workflowSteps,
  toast: vi.fn(),
}));

vi.mock("../app/store", () => ({
  useStore: () => storeMock,
}));

vi.mock("../lib/api", () => ({ api: apiMock }));

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
    storeMock.transitionInvoice.mockReset();
    storeMock.transitionInvoice.mockResolvedValue(undefined);
    storeMock.toast.mockReset();
    storeMock.invoices = [invoice()];
    storeMock.invoiceStatusSteps = workflowSteps;
    apiMock.invoiceAttachments.mockReset();
    apiMock.invoiceAttachments.mockResolvedValue({ results: [] });
    apiMock.uploadInvoiceAttachment.mockReset();
    apiMock.uploadInvoiceAttachment.mockResolvedValue(undefined);
    apiMock.invoiceAttachment.mockReset();
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

  it("shows workflow history and clearly saves a Finance status transition", async () => {
    storeMock.invoices = [{ ...invoice(), workflowStatus: storeMock.invoiceStatusSteps[0], statusHistory: [{ id: "event-1", toCode: "draft", toLabel: "Draft", source: "created", createdAt: "2026-07-26T10:00:00Z" }] }];
    render(<Invoices />);
    await userEvent.click(screen.getByRole("row", { name: /INV-2026-0001/ }));
    expect(screen.getAllByText("Draft").length).toBeGreaterThan(0);
    const save = screen.getByRole("button", { name: "Apply status change" });
    expect(save).toBeDisabled();
    await userEvent.selectOptions(screen.getByLabelText("Change invoice status"), "submitted");
    await userEvent.click(save);
    expect(storeMock.transitionInvoice).toHaveBeenCalledWith("invoice-1", "submitted");
    expect(await screen.findByRole("status")).toHaveTextContent("Status saved: Submitted");
  });

  it("keeps workflow controls read-only when invoice permissions are absent", async () => {
    storeMock.can.mockReturnValue(false);
    storeMock.invoiceStatusSteps = undefined as unknown as typeof storeMock.invoiceStatusSteps;
    storeMock.invoices = [{ ...invoice(), workflowStatus: undefined, statusHistory: [] }];
    render(<Invoices />);
    await userEvent.click(screen.getByRole("row", { name: /INV-2026-0001/ }));
    expect(screen.queryByLabelText("Change invoice status")).not.toBeInTheDocument();
    expect(screen.getByText(/No payment recorded yet/)).toBeInTheDocument();
  });

  it("lets Finance upload a private invoice attachment and refreshes the visible file list", async () => {
    apiMock.invoiceAttachments
      .mockResolvedValueOnce({ results: [] })
      .mockResolvedValueOnce({
        results: [{
          id: "iat-1", invoiceId: "invoice-1", fileName: "invoice.pdf", contentType: "application/pdf",
          size: 1024, checksum: "sha256:test", uploadedBy: "user-1", createdAt: "2026-07-30T10:00:00Z",
        }],
      });
    render(<Invoices />);
    await userEvent.click(screen.getByRole("row", { name: /INV-2026-0001/ }));
    const file = new File(["invoice"], "invoice.pdf", { type: "application/pdf" });
    await userEvent.upload(screen.getByLabelText("Upload invoice file"), file);
    expect(apiMock.uploadInvoiceAttachment).toHaveBeenCalledWith("invoice-1", file);
    expect(await screen.findByText("invoice.pdf")).toBeInTheDocument();
    expect(storeMock.toast).toHaveBeenCalledWith("Invoice file uploaded securely", "success");
  });

  it("keeps the drawer open and explains a rejected status transition", async () => {
    storeMock.transitionInvoice.mockRejectedValueOnce(new Error("Status is no longer active"));
    render(<Invoices />);
    await userEvent.click(screen.getByRole("row", { name: /INV-2026-0001/ }));
    await userEvent.selectOptions(screen.getByLabelText("Change invoice status"), "submitted");
    await userEvent.click(screen.getByRole("button", { name: "Apply status change" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Status is no longer active");
    expect(screen.getByText("Line-item breakdown")).toBeInTheDocument();
  });

  it("shows private-file load and upload failures without dismissing the invoice", async () => {
    apiMock.invoiceAttachments.mockRejectedValueOnce(new Error("Storage unavailable"));
    apiMock.uploadInvoiceAttachment.mockRejectedValueOnce(new Error("Upload rejected"));
    render(<Invoices />);
    await userEvent.click(screen.getByRole("row", { name: /INV-2026-0001/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not load uploaded invoice files.");
    const file = new File(["invoice"], "invoice.pdf", { type: "application/pdf" });
    await userEvent.upload(screen.getByLabelText("Upload invoice file"), file);
    expect(await screen.findByRole("alert")).toHaveTextContent("Upload rejected");
    expect(screen.getByText("Line-item breakdown")).toBeInTheDocument();
  });

  it("opens an uploaded invoice using a freshly authorized private link", async () => {
    apiMock.invoiceAttachments.mockResolvedValueOnce({
      results: [{
        id: "iat-1", invoiceId: "invoice-1", fileName: "invoice.pdf", contentType: "application/pdf",
        size: 1024, checksum: "sha256:test", uploadedBy: "user-1", createdAt: "2026-07-30T10:00:00Z",
      }],
    });
    apiMock.invoiceAttachment.mockResolvedValue({ downloadUrl: "https://private.example/invoice" });
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    render(<Invoices />);
    await userEvent.click(screen.getByRole("row", { name: /INV-2026-0001/ }));
    await userEvent.click(await screen.findByRole("button", { name: "Open file" }));
    await waitFor(() => expect(apiMock.invoiceAttachment).toHaveBeenCalledWith("iat-1"));
    expect(open).toHaveBeenCalledWith("https://private.example/invoice", "_blank", "noopener");
    open.mockRestore();
  });

  it("keeps void invoices out of receivables and filters overdue invoices", async () => {
    storeMock.invoices = [
      { ...invoice(), id: "invoice-overdue", invoiceNo: "INV-OVERDUE", due: "2020-08-09" },
      { ...invoice(), id: "invoice-void", invoiceNo: "INV-VOID", status: "void", due: "2099-08-09" },
    ];
    render(<Invoices />);
    expect(screen.getByText("1 past due date")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Overdue" }));
    expect(screen.getByText("INV-OVERDUE")).toBeInTheDocument();
    expect(screen.queryByText("INV-VOID")).not.toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Search invoices"), "not-a-vessel");
    expect(screen.getByText("No invoices found")).toBeInTheDocument();
  });

  it("surfaces an invoice payment failure without closing the detail", async () => {
    storeMock.can.mockReturnValue(true);
    storeMock.recordPayment.mockRejectedValueOnce(new Error("Bank declined"));
    storeMock.invoices = [invoice()];
    render(<Invoices />);
    await userEvent.click(screen.getByRole("row", { name: /INV-2026-0001/ }));
    await userEvent.type(screen.getByLabelText("Payment reference"), "NPA-FAILED");
    await userEvent.click(screen.getByRole("button", { name: /Record payment/ }));
    expect(storeMock.toast).toHaveBeenCalledWith("Bank declined", "error");
  });
});
