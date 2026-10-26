import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AppShell } from "./AppShell";
import { useBreadcrumbs } from "./breadcrumbs";
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

  it("renders grouped permission-filtered navigation, breadcrumb title, MFA action, and toast controls", async () => {
    const view = render(<AppShell><div>Users content</div></AppShell>);
    const trail = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(within(trail).getByText("Users")).toHaveAttribute("aria-current", "page");
    expect(screen.queryByRole("heading", { name: "Users" })).not.toBeInTheDocument();
    const nav = screen.getByRole("navigation", { name: "Primary" });
    expect([...nav.querySelectorAll(".sb-nav-label")].map(label => label.textContent)).toEqual(["Work", "Directory", "Admin"]);
    expect(screen.queryByRole("link", { name: /Vessel Calls/ })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Dashboard" })).toHaveAttribute("href", "/app/dashboard");
    expect(screen.getByRole("link", { name: "Voyages" })).toHaveAttribute("href", "/app/measurements");
    expect(screen.getByRole("link", { name: "Vessels" })).toHaveAttribute("href", "/app/vessels");
    expect(screen.getByRole("link", { name: "Invoices" })).toHaveAttribute("href", "/app/variation-invoices");
    expect(screen.getByRole("link", { name: "Agencies" })).toHaveAttribute("href", "/app/settings/agencies");
    expect(screen.getByRole("link", { name: "Users" })).toHaveAttribute("href", "/app/users");
    expect(screen.queryByRole("link", { name: "Variation tariff" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Settings/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Inspections/ })).not.toBeInTheDocument();
    expect(view.container.querySelector('a[href="/app/invoices"]')).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Analytics/ })).not.toBeInTheDocument();
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
    expect(screen.getByRole("link", { name: "Vessels" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Voyages" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Dashboard" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Agencies" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Users" })).not.toBeInTheDocument();
    expect([...view.container.querySelectorAll(".sb-nav-label")].map(label => label.textContent)).toEqual(["Work"]);
  });

  it("shows billing setup only to users who can bill", () => {
    mocks.auth.can = vi.fn((permission: string) => ["measurements.view", "measurements.bill"].includes(permission));
    render(<Sidebar />);
    expect(screen.getByRole("link", { name: "Variation tariff" })).toHaveAttribute("href", "/app/settings/tariffs");
    expect(screen.queryByRole("link", { name: "Users" })).not.toBeInTheDocument();
  });

  it("replaces the section title with the trail a page registers and links every crumb but the last", () => {
    window.history.replaceState(null, "", "/app/measurements/voyages/call-1/readings");
    function Page() {
      useBreadcrumbs([{ label: "Voyages", to: "/app/measurements" }, { label: "MV Atlas", to: "/app/vessels/mv-atlas--ng" }, { label: "VOY-001" }]);
      return <h1>MV Atlas</h1>;
    }
    render(<AppShell><Page /></AppShell>);
    const trail = within(screen.getByRole("navigation", { name: "Breadcrumb" }));
    expect(trail.getByRole("link", { name: "Voyages" })).toHaveAttribute("href", "/app/measurements");
    expect(trail.getByRole("link", { name: "MV Atlas" })).toHaveAttribute("href", "/app/vessels/mv-atlas--ng");
    expect(trail.getByText("VOY-001")).toHaveAttribute("aria-current", "page");
    expect(trail.queryByRole("link", { name: "VOY-001" })).not.toBeInTheDocument();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
  });

  it("falls back to the section name when no page registers a trail", () => {
    window.history.replaceState(null, "", "/app/settings/tariffs");
    render(<AppShell><div>Tariff</div></AppShell>);
    expect(within(screen.getByRole("navigation", { name: "Breadcrumb" })).getByText("Variation tariff")).toHaveAttribute("aria-current", "page");
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
    expect(screen.queryByRole("link", { name: "Users" })).not.toBeInTheDocument();
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
