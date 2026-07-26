import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Inspection, Invoice, VesselCall } from "../types";
import { NewInspection } from "./Inspections";

const navigate = vi.hoisted(() => vi.fn());
const addInspection = vi.hoisted(() => vi.fn());

const call: VesselCall = {
  id: "call-1",
  vesselName: "MV Draft",
  reference: "ROT-2026-0001",
  type: "Tanker",
  flag: "NG",
  nrt: 10_000,
  eta: "2026-07-26T08:00:00Z",
  sailingEta: "",
  berth: "International Jetty",
  berthDate: "2026-07-26",
  status: "in-progress",
  notes: "",
  version: 2,
  registered: "2026-07-25T08:00:00Z",
};

const draft: Inspection = {
  id: "inspection-1",
  reference: "INS-2026-0001",
  callId: "call-1",
  vesselName: "MV Draft",
  cargoType: "Liquid",
  product: "PMS",
  reconciledTonnage: 500,
  jetty: { type: "International", name: "International Jetty" },
  liquid: {
    ullage: "2.5",
    observedVol: "600",
    temp: "15",
    blQty: "510",
    surveyorTonnage: "500",
  },
  dry: null,
  date: "2026-07-26T09:00:00Z",
  status: "draft",
  version: 3,
};

const issuedInvoice: Invoice = {
  id: "invoice-1",
  invoiceNo: "INV-2026-0001",
  callId: "call-1",
  inspectionId: "inspection-1",
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

const store = {
  calls: [call],
  inspections: [draft],
  settings: {
    commissionRate: 5,
    exchangeRate: 1_500,
    liquidDuesRates: { government: 1.68, private: 2.88, international: 4.23 },
    dryDuesRate: 2.17,
    portName: "Calabar",
    terminals: ["International Jetty"],
  },
  addInspection,
  toast: vi.fn(),
};

vi.mock("../app/store", () => ({
  useStore: () => store,
}));

vi.mock("../lib/navigation", () => ({
  useNavigate: () => navigate,
  useSearchParams: () => [new URLSearchParams("inspectionId=inspection-1"), vi.fn()],
}));

describe("inspection draft lifecycle", () => {
  beforeEach(() => {
    navigate.mockReset();
    addInspection.mockReset();
    store.toast.mockReset();
    addInspection.mockResolvedValue({
      invoice: issuedInvoice,
      queued: false,
      inspectionId: "inspection-1",
    });
  });

  it("loads an existing draft and finalizes that record instead of duplicating it", async () => {
    render(<NewInspection />);

    expect(screen.getByRole("heading", { name: "Resume Inspection" })).toBeInTheDocument();
    expect(screen.getByLabelText(/Reconciled Surveyor's Tonnage \(MT\)/)).toHaveValue(500);
    expect(screen.getByLabelText(/Jetty type/)).toHaveValue("International");

    await userEvent.click(screen.getByRole("button", { name: /Review/ }));
    expect(screen.getAllByText("Review & submit")).toHaveLength(2);
    await userEvent.click(screen.getByRole("button", { name: "Submit Inspection" }));

    expect(addInspection).toHaveBeenCalledWith(
      expect.objectContaining({
        callId: "call-1",
        cargoType: "Liquid",
        status: "completed",
        version: 3,
      }),
      { inspectionId: "inspection-1" },
    );
    expect(await screen.findByRole("heading", { name: "Inspection submitted" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Invoice PDF" })).toBeEnabled();
  });
});
