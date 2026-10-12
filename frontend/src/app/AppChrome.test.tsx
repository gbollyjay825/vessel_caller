import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AppShell } from "./AppShell";
import { Sidebar, TopBar } from "./Shell";

const mocks = vi.hoisted(() => ({
  auth: {} as Record<string, unknown>,
  store: {} as Record<string, unknown>,
}));

vi.mock("../auth/AuthContext", () => ({ useAuth: () => mocks.auth }));
vi.mock("./store", () => ({ useStore: () => mocks.store }));

function makeStore(overrides: Record<string, unknown> = {}) {
  return {
    org: {
      id: "org-1",
      name: "Harbour Agency",
      primaryPort: "Port of Calabar",
      designatedPort: "Port of Calabar",
      ports: ["Port of Calabar"],
      logo: null,
    },
    portLabel: "Port of Calabar",
    toasts: [
      { id: "success", message: "Saved", type: "success" },
      { id: "error", message: "Failed", type: "error" },
      { id: "info", message: "Queued", type: "info" },
    ],
    dismissToast: vi.fn(),
    ...overrides,
  };
}

describe("application chrome", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.history.replaceState(null, "", "/app/users");
    mocks.auth = {
      user: {
        id: "admin-1",
        name: "Ada Admin",
        role: "Admin",
        mfaEnabled: false,
        mfaEnrollmentRequired: true,
      },
      logout: vi.fn().mockResolvedValue(undefined),
      can: vi.fn((permission: string) => [
        "calls.view", "measurements.view", "settings.view", "inspections.view",
        "invoices.view", "analytics.view", "users.view",
      ].includes(permission)),
    };
    mocks.store = makeStore();
  });

  it("renders simplified permission-filtered navigation, page title, MFA action, and toast controls", async () => {
    const view = render(<AppShell><div>Users content</div></AppShell>);
    expect(screen.getByRole("heading", { name: "User Management" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Vessel Calls/ })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Voyages" })).toHaveAttribute("href", "/app/measurements");
    expect(screen.getByRole("link", { name: "Invoices" })).toHaveAttribute("href", "/app/variation-invoices");
    expect(screen.getByRole("link", { name: /Agencies/ })).toHaveAttribute("href", "/app/settings/agencies");
    expect(screen.queryByRole("link", { name: /Settings/ })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Dashboard" })).toHaveAttribute("href", "/app/dashboard");
    expect(screen.queryByRole("link", { name: /Inspections/ })).not.toBeInTheDocument();
    expect(view.container.querySelector('a[href="/app/invoices"]')).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Analytics/ })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "User Management" })).toHaveAttribute("href", "/app/users");
    expect(screen.getByText(/Authenticator enrollment is required/).closest('[role="status"]')).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Set up MFA" })).toHaveAttribute("href", "/app/account");
    expect(screen.getAllByRole("status")).toHaveLength(4);

    await userEvent.click(screen.getAllByRole("button", { name: "Dismiss" })[1]);
    expect(mocks.store.dismissToast).toHaveBeenCalledWith("error");

    await userEvent.click(screen.getByRole("button", { name: "Open menu" }));
    expect(view.container.querySelector(".sidebar")).toHaveClass("open");
    fireEvent.click(view.container.querySelector(".nav-scrim")!);
    expect(view.container.querySelector(".sidebar")).not.toHaveClass("open");

    mocks.auth.can = vi.fn((permission: string) => permission === "calls.view");
    view.rerender(<AppShell><div>Users content</div></AppShell>);
    expect(screen.getByRole("link", { name: /Vessel Calls/ })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Voyages" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Dashboard" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Agencies/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "User Management" })).not.toBeInTheDocument();
  });

  it("opens account controls and signs out from both desktop entry points", async () => {
    render(<AppShell><div>Workspace</div></AppShell>);
    await userEvent.click(screen.getByRole("button", { name: "User menu" }));
    expect(screen.getByText("Admin · Harbour Agency")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Account and security" })).toHaveAttribute("href", "/app/account");
    expect(screen.getByRole("link", { name: "Manage users" })).toHaveAttribute("href", "/app/users");
    const signOutButtons = screen.getAllByRole("button", { name: "Sign out" });
    await userEvent.click(signOutButtons.at(-1)!);
    expect(mocks.auth.logout).toHaveBeenCalledOnce();
    await userEvent.click(screen.getAllByRole("button", { name: "Sign out" })[0]);
    expect(mocks.auth.logout).toHaveBeenCalledTimes(2);
  });

  it("keeps team management out of the account menu without user access", async () => {
    mocks.auth.can = vi.fn((permission: string) => permission === "measurements.view");
    render(<AppShell><div>Workspace</div></AppShell>);
    await userEvent.click(screen.getByRole("button", { name: "User menu" }));
    expect(screen.queryByRole("link", { name: "Manage users" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "User Management" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Account and security" })).toBeInTheDocument();
  });

  it("renders branded and anonymous shell fallbacks", () => {
    mocks.auth = { user: null, logout: vi.fn(), can: vi.fn(() => true) };
    mocks.store = makeStore({
      org: {
        name: "",
        primaryPort: "",
        designatedPort: "",
        ports: [],
        logo: "data:image/png;base64,abc",
      },
      portLabel: "Onne",
      toasts: [],
    });
    const view = render(
      <>
        <Sidebar />
        <TopBar title="Invoices" />
      </>,
    );
    expect(screen.getByAltText("NPA Vessel Caller logo")).toBeInTheDocument();
    expect(screen.getByText("No user")).toBeInTheDocument();
    expect(screen.getByLabelText("Current port: Onne")).toBeInTheDocument();
    expect(view.container.querySelector(".avatar")).toHaveTextContent("—");
  });

  it("uses the NPA logo for an ordinary organisation without a logo and preserves custom branding", () => {
    const view = render(<Sidebar />);
    expect(screen.getByRole("img", { name: "Nigerian Ports Authority" })).toHaveAttribute("src", "/branding/npa-icon-192.png");
    expect(view.container.querySelector(".sb-brand")).toHaveClass("sb-brand--npa");

    mocks.store = makeStore({ org: { ...(mocks.store.org as Record<string, unknown>), logo: "/custom-harbour-logo.png" } });
    view.rerender(<Sidebar />);
    expect(screen.getByRole("img", { name: "Harbour Agency logo" })).toHaveAttribute("src", "/custom-harbour-logo.png");
    expect(screen.queryByRole("img", { name: "Nigerian Ports Authority" })).not.toBeInTheDocument();
    expect(view.container.querySelector(".sb-brand")).not.toHaveClass("sb-brand--npa");
  });
});
