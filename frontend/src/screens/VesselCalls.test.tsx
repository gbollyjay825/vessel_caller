import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Inspection, Invoice, VesselCall } from "../types";
import { VesselCallDetail, VesselCalls } from "./VesselCalls";

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  params: {} as Record<string, string>,
  searchParams: new URLSearchParams(),
  setSearchParams: vi.fn(),
  store: {} as Record<string, unknown>,
}));

vi.mock("../lib/navigation", () => ({
  useNavigate: () => mocks.navigate,
  useParams: () => mocks.params,
  useSearchParams: () => [mocks.searchParams, mocks.setSearchParams],
}));
vi.mock("../app/store", () => ({ useStore: () => mocks.store }));
vi.mock("../lib/api", () => ({
  api: {
    invoicePdfUrl: (id: string) => `/api/invoices/${encodeURIComponent(id)}/document`,
    inspectionPdfUrl: (id: string) => `/api/inspections/${encodeURIComponent(id)}/document`,
    callPdfUrl: (id: string) => `/api/vessel-calls/${encodeURIComponent(id)}/document`,
  },
}));

const pendingCall: VesselCall = {
  id: "call-pending",
  vesselName: "MV Pending",
  reference: "ROT-2026-0001",
  type: "Tanker",
  flag: "NG",
  nrt: 10_000,
  eta: "2026-07-28T08:30:00Z",
  sailingEta: "",
  berth: "Terminal A",
  berthDate: null,
  status: "pending",
  notes: "Requires pilot",
  version: 1,
  registered: "2026-07-25T10:00:00Z",
};

const completedCall: VesselCall = {
  ...pendingCall,
  id: "call-completed",
  vesselName: "MV Completed",
  reference: "ROT-2026-0002",
  status: "completed",
  berthDate: "2026-07-24T08:00:00Z",
  sailingEta: "2026-07-29T08:00:00Z",
  registered: "2026-07-24T10:00:00Z",
};

const cancelledCall: VesselCall = {
  ...pendingCall,
  id: "call-cancelled",
  vesselName: "MV Cancelled",
  reference: "ROT-2026-0003",
  status: "cancelled",
  cancellationReason: "Charter withdrawn",
  cancelledAt: "2026-07-26T10:00:00Z",
  registered: "2026-07-23T10:00:00Z",
};

const inspection: Inspection = {
  id: "inspection-1",
  reference: "INS-2026-0001",
  callId: completedCall.id,
  vesselName: completedCall.vesselName,
  cargoType: "Liquid",
  product: "PMS",
  reconciledTonnage: 9_500,
  jetty: { type: "International" },
  liquid: {},
  dry: null,
  date: "2026-07-25T08:00:00Z",
  status: "completed",
  version: 1,
};

const invoice: Invoice = {
  id: "invoice-1",
  invoiceNo: "INV-2026-0001",
  callId: completedCall.id,
  inspectionId: inspection.id,
  cargoType: "Liquid",
  issued: "2026-07-25",
  due: "2026-08-25",
  status: "unpaid",
  dues: 42_300,
  rate: 4.23,
  commissionUsd: 2_115,
  commissionNgn: 3_172_500,
  fx: 1_500,
  payment: null,
};

function makeStore(overrides: Record<string, unknown> = {}) {
  return {
    calls: [pendingCall, completedCall, cancelledCall],
    inspections: [inspection],
    invoices: [invoice],
    settings: {
      commissionRate: 5,
      exchangeRate: 1_500,
      liquidDuesRates: { government: 1.68, private: 2.88, international: 4.23 },
      dryDuesRate: 2.17,
      portName: "Port of Calabar",
      terminals: ["Terminal A", "Terminal B"],
    },
    portLabel: "Port of Calabar",
    can: vi.fn(() => true),
    toast: vi.fn(),
    addCall: vi.fn().mockResolvedValue(pendingCall),
    updateCall: vi.fn().mockResolvedValue(pendingCall),
    updateCallStatus: vi.fn().mockResolvedValue({ ...pendingCall, status: "in-progress" }),
    cancelCall: vi.fn().mockResolvedValue(cancelledCall),
    inspectionsForCall: vi.fn((id: string) => id === completedCall.id ? [inspection] : []),
    invoiceForCall: vi.fn((id: string) => id === completedCall.id ? invoice : undefined),
    financialsForCall: vi.fn((call?: VesselCall) => call?.id === completedCall.id ? {
      dues: 42_300,
      rate: 4.23,
      commissionUsd: 2_115,
      commissionNgn: 3_172_500,
      inspection,
    } : null),
    ...overrides,
  };
}

describe("VesselCalls list", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.params = {};
    mocks.searchParams = new URLSearchParams();
    mocks.store = makeStore();
    vi.spyOn(window, "open").mockImplementation(() => null);
  });

  it("searches, filters, opens records, and exposes completed documents", async () => {
    render(<VesselCalls />);
    expect(screen.getAllByText("MV Pending").length).toBeGreaterThan(0);
    expect(screen.getAllByText("MV Completed").length).toBeGreaterThan(0);

    await userEvent.type(screen.getByLabelText("Search vessel calls"), "completed");
    expect(screen.queryByText("MV Pending")).not.toBeInTheDocument();
    expect(screen.getAllByText("MV Completed").length).toBeGreaterThan(0);
    await userEvent.clear(screen.getByLabelText("Search vessel calls"));
    await userEvent.click(screen.getByRole("button", { name: "Cancelled" }));
    expect(screen.getAllByText("MV Cancelled").length).toBeGreaterThan(0);
    expect(screen.queryByText("MV Pending")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "All" }));

    const pendingRow = screen.getAllByText("MV Pending")[0].closest("tr")!;
    await userEvent.click(within(pendingRow).getByRole("button", { name: /Open/ }));
    expect(mocks.navigate).toHaveBeenCalledWith("/app/vessel-calls/call-pending");
    const completedRow = screen.getAllByText("MV Completed")[0].closest("tr")!;
    await userEvent.click(within(completedRow).getByRole("button", { name: "Invoice PDF" }));
    expect(window.open).toHaveBeenCalledWith("/api/invoices/invoice-1/document", "_blank", "noopener");
  });

  it("validates and registers a vessel call, including unique rotation checks", async () => {
    const addCall = vi.fn().mockResolvedValue({ ...pendingCall, id: "call-new" });
    mocks.store = makeStore({ addCall });
    render(<VesselCalls />);
    await userEvent.click(screen.getByRole("button", { name: /Register Vessel Call/ }));
    expect(screen.getByRole("dialog", { name: "Register Vessel Call" })).toBeInTheDocument();

    await new Promise((resolve) => setTimeout(resolve, 700));
    await userEvent.click(screen.getByRole("button", { name: "Register Call" }));
    expect(screen.getByText("Vessel name is required.")).toBeInTheDocument();
    expect(screen.getByText("Net tonnage is required.")).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText(/Vessel name/), " MV New ");
    await userEvent.type(screen.getByLabelText(/Net tonnage/), "12500");
    await userEvent.selectOptions(screen.getByLabelText("Vessel type"), "Bulk Carrier");
    await userEvent.type(screen.getByLabelText("Notes"), "  Handle carefully ");
    await userEvent.clear(screen.getByLabelText(/Rotation number/));
    await userEvent.type(screen.getByLabelText(/Rotation number/), "ROT-2026-0099");
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(screen.getByText("Rotation number is available.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Register Call" }));

    await waitFor(() => expect(addCall).toHaveBeenCalledWith(expect.objectContaining({
      vesselName: "MV New",
      reference: "ROT-2026-0099",
      type: "Bulk Carrier",
      nrt: 12_500,
      berth: "Terminal A",
      status: "pending",
      notes: "Handle carefully",
    })));
    expect(mocks.store.toast).toHaveBeenCalledWith("Vessel call ROT-2026-0099 registered", "success");
  });

  it("detects duplicate rotations and clears register query state on close", async () => {
    mocks.searchParams = new URLSearchParams("register=1");
    render(<VesselCalls />);
    expect(screen.getByRole("dialog", { name: "Register Vessel Call" })).toBeInTheDocument();
    await userEvent.clear(screen.getByLabelText(/Rotation number/));
    await userEvent.type(screen.getByLabelText(/Rotation number/), "rot-2026-0001");
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(screen.getByText("This rotation number is already in use.")).toBeInTheDocument();

    vi.spyOn(window, "confirm").mockReturnValue(true);
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(mocks.setSearchParams).toHaveBeenCalledWith(new URLSearchParams(), { replace: true });
  });
});

describe("VesselCallDetail", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.store = makeStore();
    mocks.params = { id: pendingCall.id };
    vi.spyOn(window, "open").mockImplementation(() => null);
  });

  it("updates, berths, inspects, and cancels a pending call with an audit reason", async () => {
    render(<VesselCallDetail />);
    expect(screen.getByRole("heading", { name: "MV Pending" })).toBeInTheDocument();
    expect(screen.getByText("Requires pilot")).toBeInTheDocument();
    expect(screen.getByText("No inspections logged on this call yet.")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /Mark berthed/ }));
    await waitFor(() => expect(mocks.store.updateCallStatus).toHaveBeenCalledWith(
      pendingCall.id,
      "in-progress",
      expect.objectContaining({ berth: "Terminal A", berthDate: expect.any(String) }),
    ));
    expect(mocks.store.toast).toHaveBeenCalledWith("ROT-2026-0001 marked in progress", "success");

    await userEvent.click(screen.getByRole("button", { name: /Edit call/ }));
    const dialog = screen.getByRole("dialog", { name: "Edit vessel call" });
    const name = within(dialog).getByLabelText(/Vessel name/);
    await userEvent.clear(name);
    await userEvent.type(name, "MV Renamed");
    await userEvent.clear(within(dialog).getByLabelText(/Net tonnage/));
    await userEvent.type(within(dialog).getByLabelText(/Net tonnage/), "11000");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(mocks.store.updateCall).toHaveBeenCalledWith(pendingCall.id, expect.objectContaining({
      vesselName: "MV Renamed",
      nrt: 11_000,
    })));

    const addInspectionButtons = screen.getAllByRole("button", { name: /Add Inspection/ });
    await userEvent.click(addInspectionButtons[0]);
    expect(mocks.navigate).toHaveBeenCalledWith("/app/inspections/new?callId=call-pending");

    await userEvent.click(screen.getByRole("button", { name: /Cancel call/ }));
    const cancelDialog = screen.getByRole("alertdialog", { name: "Cancel this vessel call?" });
    expect(within(cancelDialog).getByRole("button", { name: "Cancel call" })).toBeDisabled();
    await userEvent.type(within(cancelDialog).getByLabelText(/Cancellation reason/), "Charter withdrawn");
    await userEvent.click(within(cancelDialog).getByRole("button", { name: "Cancel call" }));
    await waitFor(() => expect(mocks.store.cancelCall).toHaveBeenCalledWith(pendingCall.id, "Charter withdrawn"));
    expect(mocks.navigate).toHaveBeenCalledWith("/app/vessel-calls");
  });

  it("renders completed financials, inspections, and authenticated documents", async () => {
    mocks.params = { id: completedCall.id };
    render(<VesselCallDetail />);
    expect(screen.getByText("Financials")).toBeInTheDocument();
    expect(screen.getByText("NPA harbour dues").closest(".fin-row")).toHaveTextContent("International jetty");
    expect(screen.getAllByText("INS-2026-0001").length).toBeGreaterThan(0);
    expect(screen.getAllByRole("button", { name: "Add Inspection" })[0]).toBeDisabled();
    await userEvent.click(screen.getAllByRole("button", { name: "Invoice PDF" }).at(-1)!);
    expect(window.open).toHaveBeenCalledWith("/api/invoices/invoice-1/document", "_blank", "noopener");
    fireEvent.click(screen.getAllByText("INS-2026-0001")[0].closest("tr")!);
    expect(mocks.navigate).toHaveBeenCalledWith("/app/inspections?focus=inspection-1");
  });

  it("shows cancellation history and a safe not-found state", () => {
    mocks.params = { id: cancelledCall.id };
    const view = render(<VesselCallDetail />);
    expect(screen.getByRole("status")).toHaveTextContent("Charter withdrawn");
    expect(screen.queryByRole("button", { name: /Cancel call/ })).not.toBeInTheDocument();
    view.unmount();

    mocks.params = { id: "missing" };
    render(<VesselCallDetail />);
    expect(screen.getByText("Vessel call not found.")).toBeInTheDocument();
  });
});
