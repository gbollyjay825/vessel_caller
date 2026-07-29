import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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

    await userEvent.type(terminals, "\nThird Terminal");
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
  });
});
