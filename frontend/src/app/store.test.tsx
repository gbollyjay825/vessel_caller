import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AppState, Inspection, InvoiceWorkflowStatus } from "../types";
import { StoreProvider, useStore } from "./store";

const apiMock = vi.hoisted(() => ({
  poll: vi.fn(),
  createInspection: vi.fn(),
  updateInspection: vi.fn(),
  finalizeInspection: vi.fn(),
  createCall: vi.fn(),
  updateCall: vi.fn(),
  updateCallStatus: vi.fn(),
  cancelCall: vi.fn(),
  recordPayment: vi.fn(),
  reversePayment: vi.fn(),
  updateInvoiceStatusStep: vi.fn(),
  updateSettings: vi.fn(),
  updateOrganization: vi.fn(),
}));
const queueMock = vi.hoisted(() => ({
  createIdempotencyKey: vi.fn(() => "idempotency-1"),
  listQueuedInspectionsForOwner: vi.fn(),
  markQueuedInspectionAttempt: vi.fn(),
  queueInspection: vi.fn(),
  removeQueuedInspection: vi.fn(),
}));

vi.mock("../lib/api", () => ({
  api: apiMock,
  ApiError: class ApiError extends Error {
    status: number;

    constructor(message: string, status: number) {
      super(message);
      this.status = status;
    }
  },
}));

vi.mock("../lib/offlineQueue", () => queueMock);

vi.mock("../auth/AuthContext", () => ({
  useAuth: () => ({
    can: () => true,
    user: { id: "user-1", role: "Operations" },
    org: null,
    setOrg: vi.fn(),
  }),
}));

const initial: AppState = {
  rev: 1,
  org: {
    id: "org-1",
    registered: true,
    name: "Ada Marine",
    rcNumber: "",
    email: "ada@example.com",
    phone: "",
    address: "",
    designatedPort: "Port of Calabar",
    primaryPort: "Port of Calabar",
    ports: ["Port of Calabar"],
    logo: null,
    rev: 1,
  },
  settings: {
    commissionRate: 5,
    exchangeRate: 1_500,
    liquidDuesRates: { government: 1, private: 2, international: 3 },
    dryDuesRate: 1,
    portName: "Calabar",
    terminals: ["Calabar Port"],
  },
  calls: [
    {
      id: "call-1",
      vesselName: "MV Test",
      reference: "ROT-2026-0001",
      type: "Tanker",
      flag: "NG",
      nrt: 10_000,
      eta: "2026-07-26T08:00:00Z",
      sailingEta: "",
      berth: "Calabar Port",
      berthDate: null,
      status: "in-progress",
      notes: "",
      version: 1,
      registered: "2026-07-25T08:00:00Z",
    },
  ],
  inspections: [],
  invoices: [],
};

const inspection: Inspection = {
  id: "inspection-1",
  reference: "INS-2026-0001",
  callId: "call-1",
  vesselName: "MV Test",
  cargoType: "Liquid",
  product: "PMS",
  reconciledTonnage: 500,
  jetty: { type: "International" },
  liquid: {},
  dry: null,
  date: "2026-07-26T09:00:00Z",
  status: "draft",
  version: 1,
};

function Probe() {
  const store = useStore();
  return (
    <div>
      <span data-testid="pending">{store.pendingSync}</span>
      <span data-testid="issue">{String(store.syncIssue)}</span>
      <span data-testid="inspections">{store.inspections.length}</span>
      <button
        type="button"
        onClick={() => void store.addInspection({
          callId: "call-1",
          cargoType: "Liquid",
          status: "draft",
        })}
      >
        Save inspection
      </button>
    </div>
  );
}

function renderStore(state: AppState = initial, child = <Probe />) {
  return render(
    <StoreProvider initial={state}>
      {child}
    </StoreProvider>,
  );
}

function OperationsProbe() {
  const store = useStore();
  const call = store.calls.find((item) => item.id === "call-1");
  return (
    <div>
      <span data-testid="call-count">{store.calls.length}</span>
      <span data-testid="call-name">{call?.vesselName}</span>
      <span data-testid="call-status">{call?.status}</span>
      <span data-testid="invoice-status">{store.invoices[0]?.status}</span>
      <span data-testid="commission">{store.settings.commissionRate}</span>
      <span data-testid="org-name">{store.org.name}</span>
      <span data-testid="dues">{store.financialsForCall(call)?.dues ?? 0}</span>
      <button onClick={() => void store.addCall({ vesselName: "MV Added" })}>Add call</button>
      <button onClick={() => void store.updateCall("call-1", { vesselName: "MV Updated" })}>Update call</button>
      <button onClick={() => void store.updateCallStatus("call-1", "in-progress", { berth: "Terminal B" })}>Update status</button>
      <button onClick={() => void store.cancelCall("call-1", "Charter withdrawn")}>Cancel call</button>
      <button onClick={() => void store.recordPayment("invoice-1", {
        paidOn: "2026-07-26",
        method: "Bank transfer",
        reference: "PAY-1",
      })}>Record payment</button>
      <button onClick={() => void store.reversePayment("payment-1", "Duplicate")}>Reverse payment</button>
      <button onClick={() => void store.updateSettings({ commissionRate: 7 })}>Update settings</button>
      <button onClick={() => void store.updateOrganization({ name: "New Agency" })}>Update organization</button>
      <button onClick={() => void store.addInspection({
        callId: "call-1",
        cargoType: "Liquid",
        status: "completed",
      }, { inspectionId: "inspection-1" })}>Finalize draft</button>
      <button onClick={() => store.toast("Manual toast", "info")}>Toast</button>
      <button onClick={() => store.dismissToast(store.toasts[0]?.id ?? "")}>Dismiss toast</button>
      <span data-testid="toast-count">{store.toasts.length}</span>
    </div>
  );
}

function WorkflowNotificationProbe() {
  const store = useStore();
  const step = store.invoiceStatusSteps[0];
  return (
    <div>
      <span data-testid="notification-enabled">{String(step?.notifyOnEntry)}</span>
      <span data-testid="notification-roles">{step?.notificationRoles.join(",")}</span>
      <button
        type="button"
        onClick={() => void store.updateInvoiceStatusStep("paid", {
          notifyOnEntry: true,
          notificationRoles: ["Admin", "Finance"],
        })}
      >
        Update notification policy
      </button>
    </div>
  );
}

describe("StoreProvider offline synchronization", () => {
  beforeEach(() => {
    Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
    Object.values(apiMock).forEach((mock) => mock.mockReset());
    Object.values(queueMock).forEach((mock) => mock.mockReset());
    queueMock.createIdempotencyKey.mockReturnValue("idempotency-1");
    queueMock.queueInspection.mockResolvedValue(undefined);
    queueMock.removeQueuedInspection.mockResolvedValue(undefined);
    queueMock.markQueuedInspectionAttempt.mockResolvedValue(undefined);
    queueMock.listQueuedInspectionsForOwner.mockResolvedValue([]);
    apiMock.poll.mockResolvedValue({ changed: false, rev: 1 });
  });

  it("stores an offline draft with a stable idempotency key", async () => {
    Object.defineProperty(navigator, "onLine", { configurable: true, value: false });
    const queued = {
      id: "idempotency-1",
      organizationId: "org-1",
      userId: "user-1",
      data: { callId: "call-1", cargoType: "Liquid", status: "draft" },
      evidenceFiles: [],
      createdAt: "2026-07-26T10:00:00Z",
      attempts: 0,
      operation: "create" as const,
      finalize: false,
    };
    queueMock.listQueuedInspectionsForOwner
      .mockResolvedValueOnce([])
      .mockResolvedValue([queued]);
    renderStore();

    await userEvent.click(screen.getByRole("button", { name: "Save inspection" }));

    expect(queueMock.queueInspection).toHaveBeenCalledWith(expect.objectContaining({
      id: "idempotency-1",
      organizationId: "org-1",
      userId: "user-1",
      operation: "create",
      finalize: false,
    }));
    await waitFor(() => expect(screen.getByTestId("pending")).toHaveTextContent("1"));
    expect(apiMock.createInspection).not.toHaveBeenCalled();
  });

  it("replays queued work and removes it only after the server confirms success", async () => {
    const queued = {
      id: "idempotency-1",
      organizationId: "org-1",
      userId: "user-1",
      data: { callId: "call-1", cargoType: "Liquid", status: "draft" },
      evidenceFiles: [],
      createdAt: "2026-07-26T10:00:00Z",
      attempts: 0,
      operation: "create" as const,
      finalize: false,
    };
    queueMock.listQueuedInspectionsForOwner
      .mockResolvedValueOnce([queued])
      .mockResolvedValueOnce([queued])
      .mockResolvedValue([]);
    apiMock.createInspection.mockResolvedValue({
      inspection,
      invoice: null,
      call: null,
      rev: 2,
    });
    renderStore();

    await waitFor(() => expect(apiMock.createInspection).toHaveBeenCalledWith(
      queued.data,
      expect.objectContaining({ idempotencyKey: "idempotency-1" }),
    ));
    expect(queueMock.removeQueuedInspection).toHaveBeenCalledWith(
      "idempotency-1",
      "org-1",
      "user-1",
    );
    await waitFor(() => expect(screen.getByTestId("inspections")).toHaveTextContent("1"));
    expect(screen.getByTestId("pending")).toHaveTextContent("0");
  });

  it("applies every durable domain mutation returned by Django", async () => {
    const completedInspection: Inspection = {
      ...inspection,
      status: "completed",
      reconciledTonnage: 1_000,
      jetty: { type: "International" },
    };
    const invoice = {
      id: "invoice-1",
      invoiceNo: "INV-1",
      callId: "call-1",
      inspectionId: "inspection-1",
      cargoType: "Liquid",
      issued: "2026-07-26",
      due: "2026-08-09",
      status: "unpaid" as const,
      dues: 30_000,
      rate: 3,
      commissionUsd: 1_500,
      commissionNgn: 2_250_000,
      fx: 1_500,
      payment: null,
    };
    const richState: AppState = {
      ...initial,
      inspections: [completedInspection],
      invoices: [invoice],
    };
    apiMock.createCall.mockResolvedValue({
      call: { ...initial.calls[0], id: "call-2", vesselName: "MV Added" },
      rev: 2,
    });
    apiMock.updateCall.mockResolvedValue({
      call: { ...initial.calls[0], vesselName: "MV Updated", version: 2 },
      rev: 3,
    });
    apiMock.updateCallStatus.mockResolvedValue({
      call: { ...initial.calls[0], status: "in-progress", berth: "Terminal B", version: 2 },
      rev: 4,
    });
    apiMock.cancelCall.mockResolvedValue({
      call: { ...initial.calls[0], status: "cancelled", cancellationReason: "Charter withdrawn", version: 2 },
      rev: 5,
    });
    apiMock.recordPayment.mockResolvedValue({
      invoice: { ...invoice, status: "paid", payment: { id: "payment-1" } },
      rev: 6,
    });
    apiMock.reversePayment.mockResolvedValue({
      invoice: { ...invoice, status: "unpaid", payment: null },
      rev: 7,
    });
    apiMock.updateSettings.mockResolvedValue({
      settings: { ...initial.settings, commissionRate: 7 },
      rev: 8,
    });
    apiMock.updateOrganization.mockResolvedValue({
      org: { ...initial.org, name: "New Agency" },
      rev: 9,
    });
    apiMock.updateInspection.mockResolvedValue({
      inspection: { ...inspection, version: 2 },
      rev: 10,
    });
    apiMock.finalizeInspection.mockResolvedValue({
      inspection: { ...completedInspection, version: 3 },
      invoice,
      call: { ...initial.calls[0], status: "completed", version: 3 },
      rev: 11,
    });

    renderStore(richState, <OperationsProbe />);
    expect(screen.getByTestId("dues")).toHaveTextContent("30000");

    await userEvent.click(screen.getByRole("button", { name: "Add call" }));
    await waitFor(() => expect(screen.getByTestId("call-count")).toHaveTextContent("2"));
    await userEvent.click(screen.getByRole("button", { name: "Update call" }));
    await waitFor(() => expect(screen.getByTestId("call-name")).toHaveTextContent("MV Updated"));
    expect(apiMock.updateCall).toHaveBeenCalledWith("call-1", expect.objectContaining({ version: 1 }));
    await userEvent.click(screen.getByRole("button", { name: "Update status" }));
    await waitFor(() => expect(screen.getByTestId("call-status")).toHaveTextContent("in-progress"));
    await userEvent.click(screen.getByRole("button", { name: "Cancel call" }));
    await waitFor(() => expect(screen.getByTestId("call-status")).toHaveTextContent("cancelled"));

    await userEvent.click(screen.getByRole("button", { name: "Record payment" }));
    await waitFor(() => expect(screen.getByTestId("invoice-status")).toHaveTextContent("paid"));
    await userEvent.click(screen.getByRole("button", { name: "Reverse payment" }));
    await waitFor(() => expect(screen.getByTestId("invoice-status")).toHaveTextContent("unpaid"));
    await userEvent.click(screen.getByRole("button", { name: "Update settings" }));
    await waitFor(() => expect(screen.getByTestId("commission")).toHaveTextContent("7"));
    await userEvent.click(screen.getByRole("button", { name: "Update organization" }));
    await waitFor(() => expect(screen.getByTestId("org-name")).toHaveTextContent("New Agency"));

    await userEvent.click(screen.getByRole("button", { name: "Finalize draft" }));
    await waitFor(() => expect(apiMock.finalizeInspection).toHaveBeenCalledWith("inspection-1", 2));
    expect(apiMock.updateInspection).toHaveBeenCalledWith(
      "inspection-1",
      expect.objectContaining({ callId: "call-1", cargoType: "Liquid" }),
      undefined,
    );

    await userEvent.click(screen.getByRole("button", { name: "Toast" }));
    expect(screen.getByTestId("toast-count")).toHaveTextContent("1");
    await userEvent.click(screen.getByRole("button", { name: "Dismiss toast" }));
    expect(screen.getByTestId("toast-count")).toHaveTextContent("0");
  });

  it("replaces a workflow step with the saved email notification policy", async () => {
    const paidStep = {
      id: "paid",
      code: "paid",
      label: "Paid",
      position: 50,
      active: true,
      isPaid: true,
      isTerminal: true,
      isProtected: true,
      notifyOnEntry: false,
      notificationRoles: [],
    };
    apiMock.updateInvoiceStatusStep.mockResolvedValue({
      step: {
        ...paidStep,
        notifyOnEntry: true,
        notificationRoles: ["Admin", "Finance"],
      },
      rev: 14,
    });

    renderStore({ ...initial, invoiceStatusSteps: [paidStep] }, <WorkflowNotificationProbe />);
    expect(screen.getByTestId("notification-enabled")).toHaveTextContent("false");

    await userEvent.click(screen.getByRole("button", { name: "Update notification policy" }));

    expect(apiMock.updateInvoiceStatusStep).toHaveBeenCalledWith("paid", {
      notifyOnEntry: true,
      notificationRoles: ["Admin", "Finance"],
    });
    await waitFor(() => expect(screen.getByTestId("notification-enabled")).toHaveTextContent("true"));
    expect(screen.getByTestId("notification-roles")).toHaveTextContent("Admin,Finance");
  });

  it("normalizes notification defaults from a rollback-slot response", () => {
    const legacyStep = {
      id: "legacy-approved",
      code: "approved",
      label: "Approved",
      position: 40,
      active: true,
      isPaid: false,
      isTerminal: false,
      isProtected: false,
    } as InvoiceWorkflowStatus;

    renderStore({ ...initial, invoiceStatusSteps: [legacyStep] }, <WorkflowNotificationProbe />);

    expect(screen.getByTestId("notification-enabled")).toHaveTextContent("false");
    expect(screen.getByTestId("notification-roles")).toBeEmptyDOMElement();
  });
});
