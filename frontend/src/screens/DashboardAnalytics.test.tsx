import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Analytics as AnalyticsData, Inspection, Invoice, VesselCall } from "../types";
import { Analytics } from "./Analytics";
import { Dashboard } from "./Dashboard";

const mocks = vi.hoisted(() => ({
  analytics: vi.fn(),
  navigate: vi.fn(),
  store: {} as Record<string, unknown>,
}));

vi.mock("../lib/api", () => ({
  api: {
    analytics: mocks.analytics,
    invoicePdfUrl: (id: string) => `/api/invoices/${encodeURIComponent(id)}/document`,
    inspectionPdfUrl: (id: string) => `/api/inspections/${encodeURIComponent(id)}/document`,
    callPdfUrl: (id: string) => `/api/vessel-calls/${encodeURIComponent(id)}/document`,
  },
}));
vi.mock("../lib/navigation", () => ({ useNavigate: () => mocks.navigate }));
vi.mock("../app/store", () => ({ useStore: () => mocks.store }));

const calls: VesselCall[] = [
  {
    id: "call-complete",
    vesselName: "MV Completed",
    reference: "ROT-2026-0001",
    type: "Tanker",
    flag: "NG",
    nrt: 10_000,
    eta: "2026-07-20T08:00:00Z",
    sailingEta: "",
    berth: "Terminal A",
    berthDate: "2026-07-21T08:00:00Z",
    status: "completed",
    notes: "",
    version: 2,
    registered: "2026-07-22T08:00:00Z",
  },
  {
    id: "call-pending",
    vesselName: "MV Pending",
    reference: "ROT-2026-0002",
    type: "Bulk Carrier",
    flag: "GH",
    nrt: 5_000,
    eta: "2026-07-27T08:00:00Z",
    sailingEta: "",
    berth: "",
    berthDate: null,
    status: "pending",
    notes: "",
    version: 1,
    registered: "2026-07-23T08:00:00Z",
  },
];

const inspections: Inspection[] = [{
  id: "inspection-1",
  reference: "INS-2026-0001",
  callId: "call-complete",
  vesselName: "MV Completed",
  cargoType: "Liquid",
  product: "PMS",
  reconciledTonnage: 10_000,
  jetty: { type: "International" },
  liquid: {},
  dry: null,
  date: new Date().toISOString(),
  status: "completed",
  version: 1,
}];

const invoices: Invoice[] = [{
  id: "invoice-1",
  invoiceNo: "INV-0001",
  callId: "call-complete",
  inspectionId: "inspection-1",
  cargoType: "Liquid",
  issued: "2026-07-22",
  due: "2026-08-22",
  status: "paid",
  dues: 42_300,
  rate: 4.23,
  commissionUsd: 2_115,
  commissionNgn: 3_172_500,
  fx: 1_500,
  payment: null,
}];

const analyticsData: AnalyticsData = {
  series: Array.from({ length: 12 }, (_, index) => ({
    key: `2026-${String(index + 1).padStart(2, "0")}`,
    month: new Date(2026, index, 1).toLocaleDateString("en-GB", { month: "short" }),
    year: "2026",
    liquidT: 100 + index * 10,
    dryT: index === 0 ? 0 : 50 + index,
    revenue: index === 0 ? 0 : 2_000 + index * 100,
    calls: index + 1,
  })),
  products: [
    { key: "PMS", name: "Premium Motor Spirit", tonnage: 900, share: 0.6, revenue: 9_000 },
    { key: "Wheat", name: "Wheat", tonnage: 500, share: 1, revenue: 3_000 },
    { key: "Unknown", name: "Other cargo", tonnage: 100, share: 0.1, revenue: 500 },
  ],
  totals: {
    throughput: 2_400,
    liquidT: 1_800,
    dryT: 600,
    revenue: 28_000,
    liquidR: 22_000,
    dryR: 6_000,
    invoiced: 28_000,
    collected: 20_000,
    outstanding: 8_000,
    calls: 78,
  },
};

function makeStore(overrides: Record<string, unknown> = {}) {
  return {
    rev: 1,
    portLabel: "Port of Calabar",
    settings: {
      commissionRate: 5,
      exchangeRate: 1_500,
      liquidDuesRates: { government: 1.68, private: 2.88, international: 4.23 },
      dryDuesRate: 2.17,
      portName: "Calabar",
      terminals: ["Terminal A"],
    },
    calls,
    inspections,
    invoices,
    can: vi.fn(() => true),
    toast: vi.fn(),
    financialsForCall: vi.fn((call?: VesselCall) => call?.id === "call-complete" ? {
      dues: 42_300,
      rate: 4.23,
      commissionUsd: 2_115,
      commissionNgn: 3_172_500,
      inspection: inspections[0],
    } : null),
    invoiceForCall: vi.fn(() => invoices[0]),
    inspectionsForCall: vi.fn(() => inspections),
    ...overrides,
  };
}

describe("Dashboard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.store = makeStore();
    mocks.analytics.mockResolvedValue(analyticsData);
    vi.spyOn(window, "open").mockImplementation(() => null);
  });

  it("renders real KPIs and analytics and navigates every dashboard entry point", async () => {
    const view = render(<Dashboard />);

    expect(screen.getAllByText("MV Completed").length).toBeGreaterThan(0);
    expect(screen.getAllByText("MV Pending").length).toBeGreaterThan(0);
    expect(screen.getByText("Active Vessel Calls").closest(".stat-card")).toHaveTextContent("1");
    expect(screen.getByText("Harbour Dues Collected").closest(".stat-card")).toHaveTextContent("42,300");
    expect(await screen.findByText("Cargo throughput · last 12 months")).toBeInTheDocument();
    expect(mocks.analytics).toHaveBeenCalledWith(12);

    await userEvent.click(screen.getByRole("button", { name: /Register Vessel Call/ }));
    expect(mocks.navigate).toHaveBeenCalledWith("/app/vessel-calls");
    await userEvent.click(screen.getByRole("button", { name: /Full analytics/ }));
    expect(mocks.navigate).toHaveBeenCalledWith("/app/analytics");
    await userEvent.click(screen.getByRole("button", { name: /View all/ }));
    expect(mocks.navigate).toHaveBeenCalledWith("/app/vessel-calls");

    const pendingRow = screen.getAllByText("MV Pending")[0].closest("tr")!;
    await userEvent.click(within(pendingRow).getByRole("button", { name: /Open/ }));
    expect(mocks.navigate).toHaveBeenCalledWith("/app/vessel-calls/call-pending");
    fireEvent.click(pendingRow);
    expect(mocks.navigate).toHaveBeenCalledWith("/app/vessel-calls/call-pending");

    const completeRow = screen.getAllByText("MV Completed")[0].closest("tr")!;
    await userEvent.click(within(completeRow).getByRole("button", { name: "Invoice PDF" }));
    expect(window.open).toHaveBeenCalledWith("/api/invoices/invoice-1/document", "_blank", "noopener");
    await waitFor(() => expect(view.container.firstElementChild).toHaveClass("charts-in"));
  });

  it("shows an actionable empty state and enforces registration permissions", async () => {
    const can = vi.fn(() => false);
    mocks.store = makeStore({ calls: [], inspections: [], invoices: [], can });
    mocks.analytics.mockRejectedValue(new Error("temporarily unavailable"));
    render(<Dashboard />);

    expect(screen.getByText("No vessel calls yet")).toBeInTheDocument();
    const registerButtons = screen.getAllByRole("button", { name: /Register Vessel Call/ });
    expect(registerButtons[0]).toBeDisabled();
    await userEvent.click(registerButtons[1]);
    expect(mocks.navigate).toHaveBeenCalledWith("/app/vessel-calls");
    expect(can).toHaveBeenCalledWith("registerCall");
  });
});

describe("Analytics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.store = makeStore();
    mocks.analytics.mockResolvedValue(analyticsData);
  });

  it("derives period totals and product rankings from the API response", async () => {
    const view = render(<Analytics />);
    expect(view.container.querySelector(".spin")).toBeInTheDocument();
    expect(await screen.findByText("Cargo throughput over time")).toBeInTheDocument();
    expect(screen.getAllByText("Premium Motor Spirit").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Other cargo").length).toBeGreaterThan(0);
    expect(screen.getByText("Last 12 months · ranked by volume")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "3M" }));
    expect(screen.getAllByText("Last 3 months").length).toBeGreaterThan(0);
    await userEvent.click(screen.getByRole("button", { name: "6M" }));
    expect(screen.getAllByText("Last 6 months").length).toBeGreaterThan(0);
    await userEvent.click(screen.getByRole("button", { name: "12M" }));
    expect(screen.getAllByText("Last 12 months").length).toBeGreaterThan(0);
    await waitFor(() => expect(view.container.firstElementChild).toHaveClass("charts-in"));
  });

  it("reports API failures without inventing analytics", async () => {
    const toast = vi.fn();
    mocks.store = makeStore({ toast, portLabel: "", settings: { ...makeStore().settings as object, portName: "Onne" } });
    mocks.analytics.mockRejectedValue(new Error("Analytics is unavailable"));
    const view = render(<Analytics />);
    await waitFor(() => expect(toast).toHaveBeenCalledWith("Analytics is unavailable", "error"));
    expect(view.container.querySelector(".spin")).toBeInTheDocument();
    expect(screen.getByText(/across Onne/)).toBeInTheDocument();
  });
});
