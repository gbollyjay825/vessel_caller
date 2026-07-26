import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Inspection, VesselCall } from "../types";
import { MobileApp } from "./MobileApp";

const mocks = vi.hoisted(() => ({
  auth: {} as Record<string, unknown>,
  store: {} as Record<string, unknown>,
}));

vi.mock("../auth/AuthContext", () => ({ useAuth: () => mocks.auth }));
vi.mock("../app/store", () => ({ useStore: () => mocks.store }));

const readyCall: VesselCall = {
  id: "call-ready",
  vesselName: "MV Ready",
  reference: "ROT-2026-0001",
  type: "Tanker",
  flag: "NG",
  nrt: 10_000,
  eta: "2026-07-26T08:00:00Z",
  sailingEta: "",
  berth: "Terminal A — Berth 1",
  berthDate: "2026-07-26",
  status: "in-progress",
  notes: "",
  version: 1,
  registered: "2026-07-25T08:00:00Z",
};

const upcomingCall: VesselCall = {
  ...readyCall,
  id: "call-upcoming",
  vesselName: "MV Upcoming",
  reference: "ROT-2026-0002",
  status: "pending",
  berth: "",
  berthDate: null,
};

const completedInspection: Inspection = {
  id: "inspection-1",
  reference: "INS-2026-0001",
  callId: readyCall.id,
  vesselName: readyCall.vesselName,
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

function makeStore(overrides: Record<string, unknown> = {}) {
  return {
    org: {
      id: "org-1",
      registered: true,
      name: "Harbour",
      rcNumber: "",
      email: "ops@example.com",
      phone: "",
      address: "",
      designatedPort: "Port of Calabar",
      primaryPort: "Port of Calabar",
      ports: ["Port of Calabar", "Onne Port, Rivers"],
      logo: null,
      rev: 1,
    },
    calls: [readyCall, upcomingCall],
    inspections: [completedInspection],
    settings: {
      commissionRate: 5,
      exchangeRate: 1_500,
      liquidDuesRates: { government: 1.68, private: 2.88, international: 4.23 },
      dryDuesRate: 2.17,
      portName: "Port of Calabar",
      terminals: ["Terminal A"],
    },
    pendingSync: 2,
    syncing: false,
    syncIssue: true,
    retrySync: vi.fn().mockResolvedValue(undefined),
    addInspection: vi.fn().mockResolvedValue({ invoice: null, queued: false, inspectionId: "inspection-1" }),
    inspectionsForCall: vi.fn(() => [completedInspection]),
    toast: vi.fn(),
    ...overrides,
  };
}

function fieldControl(label: string, selector: "input" | "select" = "input") {
  const labelElement = screen.getAllByText(label, { exact: false })
    .find((element) => element.closest(".mfield"));
  if (!labelElement) throw new Error(`No field found for ${label}`);
  const control = labelElement.closest(".mfield")?.querySelector(selector);
  if (!control) throw new Error(`No ${selector} found for ${label}`);
  return control as HTMLInputElement | HTMLSelectElement;
}

describe("MobileApp", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth = {
      user: { id: "surveyor-1", name: "Sam Surveyor", role: "Operations" },
      logout: vi.fn().mockResolvedValue(undefined),
    };
    mocks.store = makeStore();
  });

  it("shows field tasks, offline attention, captured records, and account controls", async () => {
    render(<MobileApp />);
    expect(screen.getByRole("heading", { name: "Inspections" })).toBeInTheDocument();
    expect(screen.getByText("Port of Calabar +1 more")).toBeInTheDocument();
    expect(screen.getByText(/2 captures need attention/)).toBeInTheDocument();
    expect(screen.getByText("MV Ready")).toBeInTheDocument();
    expect(screen.getByText("MV Upcoming")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(mocks.store.retrySync).toHaveBeenCalledOnce();

    await userEvent.click(screen.getByRole("button", { name: "Captured" }));
    expect(screen.getByRole("heading", { name: "Captured" })).toBeInTheDocument();
    expect(screen.getByText("INS-2026-0001")).toBeInTheDocument();
    expect(screen.getByText("2,500.00 MTS")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Account" }));
    expect(screen.getByText("Sam Surveyor")).toBeInTheDocument();
    expect(screen.getByText("Operations · Port of Calabar +1 more")).toBeInTheDocument();
    expect(screen.getByText("Needs attention")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(mocks.auth.logout).toHaveBeenCalledOnce();
  });

  it("captures a liquid inspection with validated private evidence", async () => {
    const addInspection = vi.fn().mockResolvedValue({
      invoice: { inspectionId: "inspection-1" },
      queued: false,
      inspectionId: "inspection-1",
    });
    mocks.store = makeStore({ addInspection, pendingSync: 0, syncIssue: false });
    const view = render(<MobileApp />);
    await userEvent.click(screen.getByRole("button", { name: /MV Ready/ }));
    expect(screen.getByText("Vessel & cargo")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: /Liquid cargo/ }));
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));

    await userEvent.type(fieldControl("Reconciled surveyor's tonnage"), "2500.55");
    await userEvent.type(fieldControl("Bill of Lading qty"), "2600");
    await userEvent.selectOptions(fieldControl("Jetty type", "select"), "Local");
    expect(screen.getByRole("button", { name: "Review" })).toBeDisabled();
    await userEvent.selectOptions(fieldControl("Jetty category", "select"), "Private");
    await userEvent.type(fieldControl("Jetty name"), "  Marina Jetty ");
    expect(screen.getByText(/Variance vs B\/L: -99.45 MT/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Review" }));
    expect(screen.getByText("Private · Local")).toBeInTheDocument();
    expect(screen.getByText("2,500.55 MTS")).toBeInTheDocument();

    const fileInput = view.container.querySelector('.evidence-picker input[type="file"]') as HTMLInputElement;
    fireEvent.change(fileInput, {
      target: { files: [new File(["bad"], "evidence.gif", { type: "image/gif" })] },
    });
    expect(screen.getByRole("alert")).toHaveTextContent("PNG or JPEG");
    const photo = new File(["photo"], "ullage.png", { type: "image/png", lastModified: 1 });
    fireEvent.change(fileInput, { target: { files: [photo] } });
    expect(screen.getByText("ullage.png")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Remove ullage.png" }));
    expect(screen.queryByText("ullage.png")).not.toBeInTheDocument();
    fireEvent.change(fileInput, { target: { files: [photo] } });

    await userEvent.click(screen.getByRole("button", { name: "Submit inspection" }));
    await waitFor(() => expect(addInspection).toHaveBeenCalledWith(expect.objectContaining({
      callId: readyCall.id,
      cargoType: "Liquid",
      reconciledTonnage: 2_500.55,
      status: "completed",
      jetty: { type: "Local", category: "Private", name: "Marina Jetty" },
    }), { evidenceFiles: [photo] }));
    expect(screen.getByRole("heading", { name: "Inspection captured" })).toBeInTheDocument();
    expect(screen.getByText("Saved")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.getByRole("heading", { name: "Inspections" })).toBeInTheDocument();
  });

  it("calculates dry draft survey tonnage and safely queues a draft offline", async () => {
    const addInspection = vi.fn().mockResolvedValue({ invoice: null, queued: true, inspectionId: null });
    mocks.store = makeStore({ addInspection });
    render(<MobileApp />);
    await userEvent.click(screen.getByRole("button", { name: /MV Upcoming/ }));
    await userEvent.click(screen.getByRole("button", { name: /Dry \/ bulk cargo/ }));
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    await userEvent.type(fieldControl("Displacement before"), "1000");
    await userEvent.type(fieldControl("Displacement after"), "100");
    await userEvent.type(fieldControl("Deductibles"), "10");
    await userEvent.clear(fieldControl("Constant"));
    await userEvent.type(fieldControl("Constant"), "5");
    expect(screen.getByText("895.00", { exact: false })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Review" }));
    await userEvent.click(screen.getByRole("button", { name: "Save as draft" }));

    await waitFor(() => expect(addInspection).toHaveBeenCalledWith(expect.objectContaining({
      callId: upcomingCall.id,
      cargoType: "Dry",
      reconciledTonnage: 895,
      status: "draft",
      dry: expect.objectContaining({ displBefore: "1000", displAfter: "100", deductibles: "10", constant: "5" }),
      jetty: null,
    }), { evidenceFiles: [] }));
    expect(screen.getByRole("heading", { name: "Draft saved" })).toBeInTheDocument();
    expect(screen.getByText("Queued offline")).toBeInTheDocument();
  });

  it("reports submission errors and handles an emptied task queue", async () => {
    const toast = vi.fn();
    const addInspection = vi.fn().mockRejectedValue(new Error("Server rejected measurement"));
    mocks.store = makeStore({ addInspection, toast });
    const view = render(<MobileApp />);
    await userEvent.click(screen.getByRole("button", { name: /MV Ready/ }));
    await userEvent.click(screen.getByRole("button", { name: /Liquid cargo/ }));
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    await userEvent.type(fieldControl("Reconciled surveyor's tonnage"), "100");
    await userEvent.selectOptions(fieldControl("Jetty type", "select"), "International");
    await userEvent.click(screen.getByRole("button", { name: "Review" }));
    await userEvent.click(screen.getByRole("button", { name: "Submit inspection" }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith("Server rejected measurement", "error"));
    expect(screen.getByRole("button", { name: "Submit inspection" })).toBeEnabled();
    view.unmount();

    mocks.store = makeStore({ calls: [], inspections: [], pendingSync: 0, syncIssue: false });
    render(<MobileApp />);
    expect(screen.getByText("All caught up")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Captured" }));
    expect(screen.getByText("Nothing captured yet")).toBeInTheDocument();
  });
});
