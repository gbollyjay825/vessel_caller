import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Inspection, Invoice, VesselCall } from "../types";
import { Inspections, NewInspection } from "./Inspections";

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  params: new URLSearchParams(),
  store: {} as Record<string, unknown>,
}));

vi.mock("../lib/navigation", () => ({
  useNavigate: () => mocks.navigate,
  useSearchParams: () => [mocks.params, vi.fn()],
}));
vi.mock("../app/store", () => ({ useStore: () => mocks.store }));
vi.mock("../lib/api", () => ({
  api: {
    invoicePdfUrl: (id: string) => `/api/invoices/${encodeURIComponent(id)}/document`,
    inspectionPdfUrl: (id: string) => `/api/inspections/${encodeURIComponent(id)}/document`,
    callPdfUrl: (id: string) => `/api/vessel-calls/${encodeURIComponent(id)}/document`,
  },
}));

const calls: VesselCall[] = [
  {
    id: "call-ready",
    vesselName: "MV Ready",
    reference: "ROT-2026-0001",
    type: "Tanker",
    flag: "NG",
    nrt: 10_000,
    eta: "2026-07-26T08:00:00Z",
    sailingEta: "",
    berth: "Terminal A",
    berthDate: "2026-07-26",
    status: "in-progress",
    notes: "",
    version: 1,
    registered: "2026-07-25T08:00:00Z",
  },
  {
    id: "call-pending",
    vesselName: "MV Pending",
    reference: "ROT-2026-0002",
    type: "Bulk Carrier",
    flag: "GH",
    nrt: 5_000,
    eta: "2026-07-28T08:00:00Z",
    sailingEta: "",
    berth: "",
    berthDate: null,
    status: "pending",
    notes: "",
    version: 1,
    registered: "2026-07-26T08:00:00Z",
  },
  {
    id: "call-cancelled",
    vesselName: "MV Cancelled",
    reference: "ROT-2026-0003",
    type: "Tanker",
    flag: "NG",
    nrt: 4_000,
    eta: "2026-07-29T08:00:00Z",
    sailingEta: "",
    berth: "",
    berthDate: null,
    status: "cancelled",
    notes: "",
    version: 2,
    registered: "2026-07-24T08:00:00Z",
  },
];

const completed: Inspection = {
  id: "inspection-complete",
  reference: "INS-2026-0001",
  callId: "call-ready",
  vesselName: "MV Ready",
  cargoType: "Liquid",
  product: "PMS",
  reconciledTonnage: 2_500,
  jetty: { type: "International" },
  liquid: {},
  dry: null,
  date: "2026-07-26T10:00:00Z",
  status: "completed",
  version: 1,
};

const draft: Inspection = {
  ...completed,
  id: "inspection-draft",
  reference: "INS-2026-0002",
  callId: "call-pending",
  vesselName: "MV Pending",
  cargoType: "Dry",
  reconciledTonnage: 0,
  jetty: null,
  liquid: null,
  dry: { displBefore: "1000", displAfter: "100", deductibles: "10", constant: "5" },
  date: "2026-07-25T10:00:00Z",
  status: "draft",
};

const invoice: Invoice = {
  id: "invoice-1",
  invoiceNo: "INV-2026-0001",
  callId: "call-ready",
  inspectionId: "inspection-complete",
  cargoType: "Liquid",
  issued: "2026-07-26",
  due: "2026-08-09",
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
    calls,
    inspections: [completed, draft],
    settings: {
      commissionRate: 5,
      exchangeRate: 1_500,
      liquidDuesRates: { government: 1.68, private: 2.88, international: 4.23 },
      dryDuesRate: 2.17,
      portName: "Port of Calabar",
      terminals: ["Terminal A"],
    },
    can: vi.fn(() => true),
    addInspection: vi.fn().mockResolvedValue({
      invoice,
      queued: false,
      inspectionId: completed.id,
    }),
    toast: vi.fn(),
    ...overrides,
  };
}

async function chooseCall(name: string) {
  const input = screen.getByPlaceholderText("Search vessel name or reference…");
  await userEvent.click(input);
  await userEvent.click(screen.getByRole("button", { name: new RegExp(name) }));
}

describe("Inspections list", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.params = new URLSearchParams();
    mocks.store = makeStore();
    vi.spyOn(window, "open").mockImplementation(() => null);
  });

  it("searches and filters records and exposes draft/completed actions", async () => {
    render(<Inspections />);
    expect(screen.getAllByText("INS-2026-0001").length).toBeGreaterThan(0);
    expect(screen.getAllByText("INS-2026-0002").length).toBeGreaterThan(0);

    await userEvent.type(screen.getByLabelText("Search inspections"), "pending");
    expect(screen.queryByText("INS-2026-0001")).not.toBeInTheDocument();
    expect(screen.getAllByText("INS-2026-0002").length).toBeGreaterThan(0);
    await userEvent.clear(screen.getByLabelText("Search inspections"));
    await userEvent.click(screen.getByRole("button", { name: "Liquid" }));
    expect(screen.queryByText("INS-2026-0002")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "All" }));

    const completedRow = screen.getAllByText("INS-2026-0001")[0].closest("tr")!;
    await userEvent.click(within(completedRow).getByRole("button", { name: "Report PDF" }));
    expect(window.open).toHaveBeenCalledWith("/api/inspections/inspection-complete/document", "_blank", "noopener");
    const draftRow = screen.getAllByText("INS-2026-0002")[0].closest("tr")!;
    await userEvent.click(within(draftRow).getByRole("button", { name: /Resume/ }));
    expect(mocks.navigate).toHaveBeenCalledWith("/app/inspections/new?inspectionId=inspection-draft");
    await userEvent.click(screen.getByRole("button", { name: /New Inspection/ }));
    expect(mocks.navigate).toHaveBeenCalledWith("/app/inspections/new");
  });

  it("renders an honest empty and permission-restricted state", async () => {
    const can = vi.fn(() => false);
    mocks.store = makeStore({ inspections: [], can });
    render(<Inspections />);
    expect(screen.getByText("No inspections yet")).toBeInTheDocument();
    const newButtons = screen.getAllByRole("button", { name: /New Inspection/ });
    expect(newButtons.every((button) => button.hasAttribute("disabled"))).toBe(true);
    expect(can).toHaveBeenCalledWith("addInspection");
  });
});

describe("new inspection workflows", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.params = new URLSearchParams();
    mocks.store = makeStore({ inspections: [] });
  });

  it("searches eligible calls and saves a new liquid draft", async () => {
    const addInspection = vi.fn().mockResolvedValue({ invoice: null, queued: false, inspectionId: "new-draft" });
    mocks.store = makeStore({ inspections: [], addInspection });
    render(<NewInspection />);
    const search = screen.getByPlaceholderText("Search vessel name or reference…");
    await userEvent.click(search);
    await userEvent.type(search, "does-not-exist");
    expect(screen.getByText("No open vessel calls match.")).toBeInTheDocument();
    await userEvent.clear(search);
    expect(screen.queryByRole("button", { name: /MV Cancelled/ })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /MV Ready/ }));
    await userEvent.click(screen.getByRole("button", { name: /Liquid cargo/ }));
    await userEvent.click(screen.getByRole("button", { name: /Continue/ }));

    await userEvent.type(screen.getByLabelText(/Bill of Lading quantity/), "2600");
    await userEvent.type(screen.getByLabelText(/Reconciled Surveyor's Tonnage/), "2500");
    await userEvent.selectOptions(screen.getByLabelText(/Jetty type/), "Local");
    expect(screen.getByRole("button", { name: /Review/ })).toBeDisabled();
    await userEvent.selectOptions(screen.getByLabelText(/Jetty category/), "Government");
    await userEvent.type(screen.getByLabelText("Jetty name"), "  NPA Jetty ");
    expect(screen.getByText("Variance vs B/L: -100.00 MT")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Back/ }));
    expect(screen.getByText("Link to a vessel call")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Continue/ }));
    await userEvent.click(screen.getByRole("button", { name: /Review/ }));
    expect(screen.getByText(/Government Jetty · Local/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Save draft" }));

    await waitFor(() => expect(addInspection).toHaveBeenCalledWith(expect.objectContaining({
      callId: "call-ready",
      cargoType: "Liquid",
      reconciledTonnage: 0,
      status: "draft",
      jetty: { type: "Local", category: "Government", name: "NPA Jetty" },
    }), { inspectionId: undefined }));
    expect(mocks.store.toast).toHaveBeenCalledWith("Draft inspection saved", "info");
    expect(mocks.navigate).toHaveBeenCalledWith("/app/inspections");
  });

  it("submits dry measurements and presents a queued-offline receipt", async () => {
    const addInspection = vi.fn().mockResolvedValue({ invoice: null, queued: true, inspectionId: null });
    mocks.store = makeStore({ inspections: [], addInspection });
    render(<NewInspection />);
    await chooseCall("MV Pending");
    await userEvent.click(screen.getByRole("button", { name: /Dry \/ bulk cargo/ }));
    await userEvent.click(screen.getByRole("button", { name: /Continue/ }));
    await userEvent.type(screen.getByLabelText(/Displacement before/), "1000");
    await userEvent.type(screen.getByLabelText(/Displacement after/), "100");
    await userEvent.type(screen.getByLabelText(/Deductibles/), "10");
    await userEvent.clear(screen.getByLabelText(/Constant/));
    await userEvent.type(screen.getByLabelText(/Constant/), "5");
    expect(screen.getByText("895.00")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Review/ }));
    await userEvent.click(screen.getByRole("button", { name: "Submit Inspection" }));

    await waitFor(() => expect(addInspection).toHaveBeenCalledWith(expect.objectContaining({
      cargoType: "Dry",
      reconciledTonnage: 895,
      status: "completed",
      dry: { displBefore: "1000", displAfter: "100", deductibles: "10", constant: "5" },
      jetty: null,
    }), { inspectionId: undefined }));
    expect(screen.getByRole("heading", { name: "Inspection queued" })).toBeInTheDocument();
    expect(screen.getByText(/stored securely on this device/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Invoice PDF" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Back to dashboard" }));
    expect(mocks.navigate).toHaveBeenCalledWith("/app");
  });

  it("locks a call from route context and reports submit conflicts", async () => {
    const toast = vi.fn();
    const addInspection = vi.fn().mockRejectedValue(new Error("Inspection version conflict"));
    mocks.params = new URLSearchParams("callId=call-ready");
    mocks.store = makeStore({ inspections: [], addInspection, toast });
    render(<NewInspection />);
    expect(screen.getByText("Locked")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Back to vessel call/ }));
    expect(mocks.navigate).toHaveBeenCalledWith("/app/vessel-calls/call-ready");
    await userEvent.click(screen.getByRole("button", { name: /Liquid cargo/ }));
    await userEvent.click(screen.getByRole("button", { name: /Continue/ }));
    await userEvent.type(screen.getByLabelText(/Reconciled Surveyor's Tonnage/), "100");
    await userEvent.selectOptions(screen.getByLabelText(/Jetty type/), "International");
    await userEvent.click(screen.getByRole("button", { name: /Review/ }));
    await userEvent.click(screen.getByRole("button", { name: "Submit Inspection" }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith("Inspection version conflict", "error"));
    expect(screen.getByRole("button", { name: "Submit Inspection" })).toBeEnabled();
  });
});
