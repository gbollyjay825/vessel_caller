import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { Settings } from "./Settings";

const mocks = vi.hoisted(() => ({
  auth: {} as Record<string, unknown>,
  store: {} as Record<string, unknown>,
}));

vi.mock("../auth/AuthContext", () => ({ useAuth: () => mocks.auth }));
vi.mock("../app/store", () => ({ useStore: () => mocks.store }));

function makeStore(overrides: Record<string, unknown> = {}) {
  return {
    org: {
      id: "org-1",
      registered: true,
      name: "Harbour Agency",
      rcNumber: "RC123",
      email: "ops@example.com",
      phone: "+2348000000000",
      address: "1 Marina",
      designatedPort: "Port of Calabar",
      primaryPort: "Port of Calabar",
      ports: ["Port of Calabar", "Port of Calabar", ""],
      logo: null,
      rev: 1,
    },
    settings: {
      commissionRate: 5,
      exchangeRate: 1_500,
      liquidDuesRates: { government: 1.68, private: 2.88, international: 4.23 },
      dryDuesRate: 2.17,
      portName: "Port of Calabar",
      terminals: ["Terminal A", "Terminal B"],
    },
    portLabel: "Port of Calabar",
    toast: vi.fn(),
    updateSettings: vi.fn().mockResolvedValue(undefined),
    updateOrganization: vi.fn().mockResolvedValue(undefined),
    invoiceStatusSteps: [
      { id: "director", code: "pending-director-finance-review", label: "Pending Director of Finance Review", position: 10, active: true, isPaid: false, isTerminal: false, isProtected: false, notifyOnEntry: false, notificationRoles: [] },
      { id: "audit", code: "pending-audit-review", label: "Pending Audit Review", position: 20, active: true, isPaid: false, isTerminal: false, isProtected: false, notifyOnEntry: true, notificationRoles: ["Admin"] },
      { id: "approved", code: "approved", label: "Approved", position: 50, active: true, isPaid: false, isTerminal: false, isProtected: false, notifyOnEntry: true, notificationRoles: ["Operations", "Finance"] },
      { id: "paid", code: "paid", label: "Paid", position: 60, active: true, isPaid: true, isTerminal: true, isProtected: true, notifyOnEntry: true, notificationRoles: ["Finance"] },
      { id: "legacy-draft", code: "draft", label: "Draft", position: 910, active: false, isPaid: false, isTerminal: false, isProtected: false, notifyOnEntry: false, notificationRoles: [] },
    ],
    createInvoiceStatusStep: vi.fn().mockResolvedValue(undefined),
    updateInvoiceStatusStep: vi.fn().mockResolvedValue(undefined),
    reorderInvoiceStatusSteps: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function renderAdmin(overrides: Record<string, unknown> = {}) {
  mocks.auth = {
    user: { id: "admin-1", name: "Ada Admin", role: "Admin" },
    can: vi.fn(() => true),
  };
  mocks.store = makeStore(overrides);
  return render(<Settings />);
}

describe("Settings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("edits and persists organization identity, ports, and primary port", async () => {
    const view = renderAdmin();

    const name = screen.getByLabelText(/Organization name/);
    await userEvent.clear(name);
    await userEvent.type(name, "Vessel Caller Limited");
    await userEvent.click(screen.getByLabelText("Apapa Port, Lagos"));
    await userEvent.selectOptions(screen.getByLabelText("Primary port"), "Apapa Port, Lagos");
    expect(screen.getByText("You have unsaved changes")).toBeInTheDocument();

    const upload = view.container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(upload, {
      target: { files: [new File(["plain text"], "logo.txt", { type: "text/plain" })] },
    });
    await waitFor(() => expect(mocks.store.toast).toHaveBeenCalledWith("Choose a PNG, JPEG, or WebP image no larger than 2 MB.", "error"));

    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(mocks.store.updateOrganization).toHaveBeenCalledWith(expect.objectContaining({
      name: "Vessel Caller Limited",
      ports: ["Port of Calabar", "Apapa Port, Lagos"],
      designatedPort: "Apapa Port, Lagos",
      primaryPort: "Apapa Port, Lagos",
    })));
    expect(mocks.store.toast).toHaveBeenCalledWith("Settings saved", "success");
    expect(screen.getByText("All changes saved")).toBeInTheDocument();
  });

  it("persists charge configuration and port terminals and can discard edits", async () => {
    renderAdmin();

    await userEvent.click(screen.getByRole("tab", { name: "Charge configuration" }));
    const commission = screen.getByLabelText("Commission rate (%)");
    await userEvent.clear(commission);
    await userEvent.type(commission, "7.5");
    const government = screen.getByLabelText("Government jetty");
    await userEvent.clear(government);
    await userEvent.type(government, "2.25");
    const exchangeRate = screen.getByLabelText("USD → ₦ exchange rate");
    await userEvent.clear(exchangeRate);
    await userEvent.type(exchangeRate, "1600");
    const privateJetty = screen.getByLabelText("Private jetty");
    await userEvent.clear(privateJetty);
    await userEvent.type(privateJetty, "3.1");
    const internationalJetty = screen.getByLabelText("International jetty");
    await userEvent.clear(internationalJetty);
    await userEvent.type(internationalJetty, "4.5");
    const dryCargo = screen.getByLabelText("Dry cargo rate (USD per NT ton)");
    await userEvent.clear(dryCargo);
    await userEvent.type(dryCargo, "2.4");
    expect(screen.getByText("Worked example · 50,000 NT vessel").closest(".live-calc")).toHaveTextContent("$112,500.00");
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(mocks.store.updateSettings).toHaveBeenCalledWith(expect.objectContaining({
      commissionRate: 7.5,
      exchangeRate: 1_600,
      liquidDuesRates: {
        government: 2.25,
        private: 3.1,
        international: 4.5,
      },
      dryDuesRate: 2.4,
    })));

    await userEvent.click(screen.getByRole("tab", { name: "Port profile" }));
    const terminals = screen.getByLabelText("Default terminals");
    await userEvent.clear(terminals);
    await userEvent.type(terminals, "New Terminal\nSecond Terminal");
    await userEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(terminals).toHaveValue("Terminal A\nTerminal B");

    const terminalToAdd = screen.getByLabelText("Add terminal");
    await userEvent.type(terminalToAdd, "Third Terminal");
    await userEvent.click(screen.getByRole("button", { name: "Add terminal" }));
    expect(terminals).toHaveValue("Terminal A\nTerminal B\nThird Terminal");

    await userEvent.type(terminalToAdd, "terminal a");
    await userEvent.click(screen.getByRole("button", { name: "Add terminal" }));
    expect(terminals).toHaveValue("Terminal A\nTerminal B\nThird Terminal");
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(mocks.store.updateSettings).toHaveBeenLastCalledWith(expect.objectContaining({
      terminals: ["Terminal A", "Terminal B", "Third Terminal"],
    })));

    await userEvent.click(screen.getByRole("button", { name: "Organization" }));
    expect(screen.getByText(/The registered agency profile\./)).toBeInTheDocument();
  });

  it("routes admins to user management and reports save failures", async () => {
    const updateOrganization = vi.fn().mockRejectedValue(new Error("Write conflict"));
    renderAdmin({ updateOrganization });

    await userEvent.click(screen.getByRole("tab", { name: "Team & roles" }));
    expect(screen.getByRole("link", { name: /Open User Management/ })).toHaveAttribute("href", "/app/users");

    await userEvent.click(screen.getByRole("tab", { name: "Organization" }));
    await userEvent.clear(screen.getByLabelText("RC number"));
    await userEvent.type(screen.getByLabelText("RC number"), "RC999");
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(mocks.store.toast).toHaveBeenCalledWith("Write conflict", "error"));
  });

  it("lets admins configure non-protected invoice workflow steps", async () => {
    vi.spyOn(window, "prompt").mockReturnValue("Prepared");
    renderAdmin();
    await userEvent.click(screen.getByRole("tab", { name: "Invoice workflow" }));
    expect(screen.getByText(/Paid is protected and is set automatically/)).toBeInTheDocument();
    await userEvent.click(screen.getAllByRole("button", { name: "Deactivate" })[0]);
    expect(mocks.store.updateInvoiceStatusStep).toHaveBeenCalledWith("director", { active: false });
    await userEvent.click(screen.getAllByRole("button", { name: "Rename" })[0]);
    expect(mocks.store.updateInvoiceStatusStep).toHaveBeenCalledWith("director", { label: "Prepared" });
    await userEvent.click(screen.getAllByRole("button", { name: "↓" })[0]);
    expect(mocks.store.reorderInvoiceStatusSteps).toHaveBeenCalledWith(["audit", "director", "approved", "paid", "legacy-draft"]);
    expect(screen.getByText("Draft")).toBeInTheDocument();
    expect(screen.getByText(/Historical inactive stages/)).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Add status step"), "Awaiting documents");
    await userEvent.click(screen.getByRole("button", { name: "Add step" }));
    expect(mocks.store.createInvoiceStatusStep).toHaveBeenCalledWith("Awaiting documents");
    expect(screen.getAllByRole("button", { name: "Deactivate" }).length).toBeGreaterThan(0);
  });

  it("lets an admin validate and save role-targeted notification settings", async () => {
    renderAdmin();
    await userEvent.click(screen.getByRole("tab", { name: "Invoice workflow" }));

    const notificationToggle = screen.getByRole("checkbox", {
      name: "Send email when an invoice enters Pending Director of Finance Review",
    });
    const saveButton = screen.getByRole("button", {
      name: "Save notification settings for Pending Director of Finance Review",
    });
    expect(saveButton).toBeDisabled();

    await userEvent.click(notificationToggle);
    expect(screen.getByRole("alert")).toHaveTextContent("Choose at least one recipient role before saving.");
    expect(saveButton).toBeDisabled();
    expect(mocks.store.updateInvoiceStatusStep).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("checkbox", {
      name: "Admin recipients for Pending Director of Finance Review",
    }));
    await userEvent.click(screen.getByRole("checkbox", {
      name: "Finance recipients for Pending Director of Finance Review",
    }));
    expect(saveButton).toBeEnabled();
    await userEvent.click(saveButton);

    await waitFor(() => expect(mocks.store.updateInvoiceStatusStep).toHaveBeenCalledWith("director", {
      notifyOnEntry: true,
      notificationRoles: ["Admin", "Finance"],
    }));
    expect(await screen.findByRole("status")).toHaveTextContent("Notification settings saved.");
    expect(saveButton).toBeDisabled();
  });

  it("allows notification configuration for protected Paid without unlocking its workflow controls", async () => {
    renderAdmin();
    await userEvent.click(screen.getByRole("tab", { name: "Invoice workflow" }));

    const paidHeading = screen.getByText("Paid", { selector: "strong" });
    const paidSection = paidHeading.closest("section");
    expect(paidSection).not.toBeNull();
    const paid = within(paidSection as HTMLElement);
    expect(paid.queryByRole("button", { name: "Rename" })).not.toBeInTheDocument();
    expect(paid.queryByRole("button", { name: "Deactivate" })).not.toBeInTheDocument();
    expect(paid.getByText(/system controlled/)).toBeInTheDocument();

    await userEvent.click(paid.getByRole("checkbox", { name: "Admin recipients for Paid" }));
    await userEvent.click(paid.getByRole("button", { name: "Save notification settings for Paid" }));
    await waitFor(() => expect(mocks.store.updateInvoiceStatusStep).toHaveBeenCalledWith("paid", {
      notifyOnEntry: true,
      notificationRoles: ["Admin", "Finance"],
    }));
  });

  it("shows inline error feedback when notification settings cannot be saved", async () => {
    const updateInvoiceStatusStep = vi.fn().mockRejectedValue(new Error("Notification policy conflict"));
    renderAdmin({ updateInvoiceStatusStep });
    await userEvent.click(screen.getByRole("tab", { name: "Invoice workflow" }));
    await userEvent.click(screen.getByRole("checkbox", { name: "Viewer recipients for Approved" }));
    await userEvent.click(screen.getByRole("button", { name: "Save notification settings for Approved" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Notification policy conflict");
    expect(mocks.store.toast).toHaveBeenCalledWith("Notification policy conflict", "error");
  });

  it("preserves a dirty notification draft when polling returns a newer saved policy", async () => {
    const view = renderAdmin();
    await userEvent.click(screen.getByRole("tab", { name: "Invoice workflow" }));
    await userEvent.click(screen.getByRole("checkbox", {
      name: "Send email when an invoice enters Pending Director of Finance Review",
    }));
    await userEvent.click(screen.getByRole("checkbox", {
      name: "Admin recipients for Pending Director of Finance Review",
    }));

    const serverSteps = (mocks.store.invoiceStatusSteps as Array<Record<string, unknown>>).map((step) => (
      step.id === "director"
        ? { ...step, notifyOnEntry: true, notificationRoles: ["Viewer"] }
        : { ...step, notificationRoles: [...(step.notificationRoles as string[])] }
    ));
    mocks.store = makeStore({ invoiceStatusSteps: serverSteps });
    view.rerender(<Settings />);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Notification settings changed on the server while you were editing. Your choices were preserved.",
    );
    expect(screen.getByRole("checkbox", {
      name: "Admin recipients for Pending Director of Finance Review",
    })).toBeChecked();
    expect(screen.getByRole("checkbox", {
      name: "Viewer recipients for Pending Director of Finance Review",
    })).not.toBeChecked();

    await userEvent.click(screen.getByRole("button", { name: "Use latest saved settings" }));
    expect(screen.getByRole("checkbox", {
      name: "Admin recipients for Pending Director of Finance Review",
    })).not.toBeChecked();
    expect(screen.getByRole("checkbox", {
      name: "Viewer recipients for Pending Director of Finance Review",
    })).toBeChecked();
    expect(screen.queryByText(/Notification settings changed on the server/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", {
      name: "Save notification settings for Pending Director of Finance Review",
    })).toBeDisabled();
  });

  it("does not change a workflow label when rename is cancelled", async () => {
    vi.spyOn(window, "prompt").mockReturnValue(null);
    renderAdmin();
    await userEvent.click(screen.getByRole("tab", { name: "Invoice workflow" }));
    await userEvent.click(screen.getAllByRole("button", { name: "Rename" })[0]);
    expect(mocks.store.updateInvoiceStatusStep).not.toHaveBeenCalled();
    expect(screen.getAllByRole("button", { name: "Deactivate" }).length).toBeGreaterThan(0);
  });

  it("does not persist a blank workflow rename", async () => {
    vi.spyOn(window, "prompt").mockReturnValue("   ");
    renderAdmin();
    await userEvent.click(screen.getByRole("tab", { name: "Invoice workflow" }));
    await userEvent.click(screen.getAllByRole("button", { name: "Rename" })[0]);
    expect(mocks.store.updateInvoiceStatusStep).not.toHaveBeenCalled();
  });

  it("is fully read-only for non-admin users", async () => {
    mocks.auth = {
      user: { id: "viewer-1", name: "Vera Viewer", role: "Viewer" },
      can: vi.fn(() => false),
    };
    mocks.store = makeStore();
    render(<Settings />);

    expect(screen.getByText(/Vera Viewer \(Viewer\).*settings are read-only/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Organization name/)).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();

    await userEvent.click(screen.getByRole("tab", { name: "Team & roles" }));
    expect(screen.getByText("User account details are restricted to organization Admins.")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Open User Management/ })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("tab", { name: "Port profile" }));
    expect(screen.getByLabelText("Default terminals")).toBeDisabled();
    expect(screen.getByLabelText("Add terminal")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Add terminal" })).toBeDisabled();

    await userEvent.click(screen.getByRole("tab", { name: "Invoice workflow" }));
    expect(screen.getByText("Current saved policy: Email notification is on for Finance.")).toBeInTheDocument();
    expect(screen.getByText(/only to active users in this organization/)).toBeInTheDocument();
    expect(screen.getByText(/person applying the status change is excluded/)).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Send email when an invoice enters Paid" })).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: "Finance recipients for Paid" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Save notification settings for Paid" })).not.toBeInTheDocument();
  });
});
