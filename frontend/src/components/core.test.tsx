import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  AreaTrend,
  MiniSpark,
  MixDonut,
  RevenueBars,
} from "./charts";
import {
  CargoTag,
  ConfirmModal,
  DataTable,
  Drawer,
  Field,
  LiveCalc,
  Money,
  PdfButton,
  StatCard,
  StatusBadge,
  Stepper,
  type Column,
} from "./ui";
import {
  calcCommission,
  calcDues,
  calcPreview,
  rateForInspection,
} from "../lib/calc";
import {
  effectiveInvoiceStatus,
  fmtCompactMT,
  fmtCompactUSD,
  fmtDate,
  fmtDateTime,
  fmtNGN,
  fmtNum,
  fmtTons,
  fmtUSD,
  orgPorts,
  orgPortsLabel,
  userInitials,
} from "../lib/format";
import {
  Link,
  NavLink,
  Navigate,
  useLocation,
  useNavigate,
  useSearchParams,
} from "../lib/navigation";
import type { Settings } from "../types";

const settings: Settings = {
  commissionRate: 5,
  exchangeRate: 1_500,
  liquidDuesRates: { government: 1.68, private: 2.88, international: 4.23 },
  dryDuesRate: 2.17,
  portName: "Port of Calabar",
  terminals: ["Terminal A"],
};

describe("domain calculations and formatting", () => {
  it("selects every tariff path and produces deterministic money", () => {
    expect(rateForInspection(null, settings)).toBeNull();
    expect(rateForInspection({ cargoType: "Dry", jetty: null }, settings)).toBe(2.17);
    expect(rateForInspection({ cargoType: "Liquid", jetty: { type: "International" } }, settings)).toBe(4.23);
    expect(rateForInspection({
      cargoType: "Liquid",
      jetty: { type: "Local", category: "Government" },
    }, settings)).toBe(1.68);
    expect(rateForInspection({
      cargoType: "Liquid",
      jetty: { type: "Local", category: "Private" },
    }, settings)).toBe(2.88);
    expect(rateForInspection({ cargoType: "Liquid", jetty: { type: "Local" } }, settings)).toBeNull();

    expect(calcDues(10_000, 4.23)).toBe(42_300);
    expect(calcDues(Number.NaN, 4.23)).toBe(0);
    expect(calcDues(10_000, 0)).toBe(0);
    expect(calcCommission(42_300, settings)).toEqual({ usd: 2_115, ngn: 3_172_500 });
    expect(calcPreview(10_000, 4.23, settings)).toEqual({
      dues: 42_300,
      rate: 4.23,
      commissionUsd: 2_115,
      commissionNgn: 3_172_500,
    });
  });

  it("formats nulls, ranges, identities, ports, and invoice states", () => {
    expect(fmtUSD(null)).toBe("—");
    expect(fmtUSD(12.5, 1)).toBe("$12.5");
    expect(fmtNGN(Number.NaN)).toBe("—");
    expect(fmtNGN(1_234.6)).toBe("₦1,235");
    expect(fmtNum(undefined)).toBe("—");
    expect(fmtNum(1_234.56, 2)).toBe("1,234.56");
    expect(fmtTons(12)).toBe("12.00 MTS");
    expect(fmtTons(null)).toBe("—");
    expect(fmtDate(null)).toBe("—");
    expect(fmtDate("2026-07-26T10:00:00Z")).toContain("2026");
    expect(fmtDateTime(null)).toBe("—");
    expect(fmtDateTime("2026-07-26T10:00:00Z")).toContain("·");
    expect(fmtCompactMT(2_500_000)).toBe("2.50M");
    expect(fmtCompactMT(2_500)).toBe("3K");
    expect(fmtCompactMT(250)).toBe("250");
    expect(fmtCompactUSD(2_500_000)).toBe("$2.50M");
    expect(fmtCompactUSD(2_500)).toBe("$3K");
    expect(fmtCompactUSD(250)).toBe("$250");
    expect(userInitials("Ada Lovelace Byron")).toBe("AL");
    expect(userInitials("")).toBe("?");

    const org = {
      id: "org-1",
      registered: true,
      name: "Harbour",
      rcNumber: "",
      email: "ops@example.com",
      phone: "",
      address: "",
      designatedPort: "Calabar",
      primaryPort: "Calabar",
      ports: ["Calabar", "Onne"],
      logo: null,
      rev: 1,
    };
    expect(orgPorts(org)).toEqual(["Calabar", "Onne"]);
    expect(orgPortsLabel(org)).toBe("Calabar +1 more");
    expect(orgPorts(undefined, "Onne")).toEqual(["Onne"]);
    expect(orgPortsLabel({ ...org, ports: ["Calabar"] })).toBe("Calabar");

    expect(effectiveInvoiceStatus(null)).toBe("unpaid");
    expect(effectiveInvoiceStatus({ status: "void" } as never)).toBe("void");
    expect(effectiveInvoiceStatus({ status: "paid" } as never)).toBe("paid");
    expect(effectiveInvoiceStatus({ status: "unpaid", due: "2000-01-01" } as never)).toBe("overdue");
    expect(effectiveInvoiceStatus({ status: "unpaid", due: "2999-01-01" } as never)).toBe("unpaid");
  });
});

describe("chart primitives", () => {
  const series = [
    { key: "2026-05", month: "May", year: "2026", liquidT: 100, dryT: 40, revenue: 1_000, calls: 2 },
    { key: "2026-06", month: "Jun", year: "2026", liquidT: 180, dryT: 50, revenue: 1_500, calls: 3 },
    { key: "2026-07", month: "Jul", year: "2026", liquidT: 140, dryT: 80, revenue: 1_300, calls: 4 },
  ];

  it("renders and explores area, revenue, donut, and spark charts", () => {
    const area = render(<AreaTrend series={series} />);
    const wrap = area.container.querySelector(".chart-wrap") as HTMLDivElement;
    vi.spyOn(wrap, "getBoundingClientRect").mockReturnValue({
      x: 0, y: 0, top: 0, left: 0, right: 300, bottom: 200, width: 300, height: 200,
      toJSON: () => ({}),
    });
    fireEvent.mouseMove(wrap, { clientX: 150 });
    expect(screen.getByText("Jun 2026")).toBeInTheDocument();
    fireEvent.mouseLeave(wrap);
    expect(screen.queryByText("Jun 2026")).not.toBeInTheDocument();
    area.unmount();
    expect(render(<AreaTrend series={[]} />).container).toBeEmptyDOMElement();

    const revenue = render(<RevenueBars series={[
      { month: "May", liquidR: 500, dryR: 200 },
      { month: "Jun", liquidR: 700, dryR: 300 },
    ]} />);
    const bars = revenue.container.querySelectorAll("svg > g");
    fireEvent.mouseEnter(bars[1]);
    expect(revenue.container).toHaveTextContent("$1K");
    fireEvent.mouseLeave(revenue.container.querySelector(".chart-wrap")!);
    revenue.unmount();
    expect(render(<RevenueBars series={[]} />).container).toBeEmptyDOMElement();

    const donut = render(<MixDonut products={[
      { key: "PMS", label: "Premium Motor Spirit", tonnage: 75, color: "#123456" },
      { key: "Dry", name: "Dry cargo", tonnage: 25 },
    ]} total={100} />);
    fireEvent.mouseEnter(screen.getByText("Premium Motor Spirit").closest(".leg-row")!);
    expect(donut.container).toHaveTextContent("75%");
    fireEvent.mouseLeave(screen.getByText("Premium Motor Spirit").closest(".leg-row")!);
    expect(donut.container).toHaveTextContent("100 MT");
    donut.unmount();
    expect(render(<MixDonut products={[]} total={0} />).container).toBeEmptyDOMElement();

    expect(render(<MiniSpark values={[]} />).container).toBeEmptyDOMElement();
    const spark = render(<MiniSpark values={[5, 5, 5]} color="#fff" w={80} h={20} />);
    expect(spark.container.querySelectorAll("path")).toHaveLength(2);
  });
});

describe("shared UI and navigation", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/app?tab=one");
  });

  it("sorts, activates, and keyboard-opens responsive table records", async () => {
    type Row = { id: string; name: string | null; amount: number };
    const rows: Row[] = [
      { id: "b", name: "Beta", amount: 20 },
      { id: "a", name: "Alpha", amount: 10 },
      { id: "n", name: null, amount: 30 },
    ];
    const columns: Column<Row>[] = [
      { key: "name", label: "Name", sortable: true, render: (row) => row.name ?? "None" },
      { key: "amount", label: "Amount", num: true, sortable: true, render: (row) => row.amount },
    ];
    const open = vi.fn();
    render(<DataTable columns={columns} rows={rows} getKey={(row) => row.id} onRowClick={open} flashId="a" />);

    const table = screen.getByRole("table");
    await userEvent.click(within(table).getByRole("button", { name: "Name" }));
    expect(within(table).getAllByRole("row")[1]).toHaveTextContent("Alpha");
    await userEvent.click(within(table).getByRole("button", { name: "Name" }));
    expect(within(table).getAllByRole("row")[1]).toHaveTextContent("Beta");
    await userEvent.click(within(table).getByRole("button", { name: "Amount" }));
    expect(within(table).getAllByRole("row")[1]).toHaveTextContent("10");

    const dataRows = within(table).getAllByRole("row").slice(1);
    fireEvent.keyDown(dataRows[0], { key: "Escape" });
    fireEvent.keyDown(dataRows[0], { key: "Enter" });
    expect(open).toHaveBeenCalled();
    const mobileCards = screen.getAllByRole("button").filter((button) => button.classList.contains("data-mobile-card"));
    fireEvent.click(mobileCards[0]);
    expect(open).toHaveBeenCalledTimes(2);
  });

  it("renders table loading/empty states and shared visual components", () => {
    const columns: Column<{ id: string }>[] = [{ key: "id", label: "ID", render: (row) => row.id }];
    const loading = render(<DataTable columns={columns} rows={[]} getKey={(row) => row.id} loading skeletonRows={4} />);
    expect(loading.container.querySelectorAll("tbody tr")).toHaveLength(4);
    loading.unmount();
    render(<DataTable columns={columns} rows={[]} getKey={(row) => row.id} emptyState={<div>No records</div>} />);
    expect(screen.getByText("No records")).toBeInTheDocument();

    render(
      <>
        <StatusBadge status="cancelled" />
        <StatusBadge status="custom" />
        <CargoTag type="Liquid" />
        <CargoTag type="Dry" />
        <Money usd={12.5} ngn={18_750} block />
        <StatCard label="Collected" value="42" cur="$" ngn="₦1" sub="today" delta={{ dir: "down", text: "-1" }} />
        <Stepper steps={["One", "Two", "Three"]} current={1} />
        <LiveCalc label="Dues" value="42,300" unit="USD" foot="locked" flashKey={1} />
      </>,
    );
    expect(screen.getByText("Cancelled")).toBeInTheDocument();
    expect(screen.getByText("custom")).toBeInTheDocument();
    expect(screen.getByText("42,300")).toHaveClass("lc-num");
  });

  it("wires document buttons, fields, drawers, and confirmation behavior", async () => {
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    const view = render(
      <>
        <PdfButton kind="invoice" id="invoice/1" />
        <PdfButton kind="report" id="inspection 1" />
        <PdfButton kind="call" id="call?1" />
        <PdfButton kind="invoice" disabled />
        <Field label="Email" required hint="Verified address"><input aria-describedby="existing" /></Field>
        <Field label="Code" checking="Checking"><input /></Field>
        <Field label="Name" error="Required"><input /></Field>
        <Field label="Reference" ok="Available"><input /></Field>
        <Field label="Custom"><div>Custom control</div></Field>
      </>,
    );
    const invoiceButtons = screen.getAllByRole("button", { name: "Invoice PDF" });
    await userEvent.click(invoiceButtons[0]);
    const reportButtons = screen.getAllByRole("button", { name: "Report PDF" });
    await userEvent.click(reportButtons[0]);
    await userEvent.click(reportButtons[1]);
    expect(open).toHaveBeenCalledWith("/api/invoices/invoice%2F1/document", "_blank", "noopener");
    expect(open).toHaveBeenCalledWith("/api/inspections/inspection%201/document", "_blank", "noopener");
    expect(open).toHaveBeenCalledWith("/api/vessel-calls/call%3F1/document", "_blank", "noopener");
    expect(screen.getByLabelText(/Email/)).toHaveAttribute("aria-describedby", expect.stringContaining("existing"));
    expect(screen.getByLabelText(/Name/)).toHaveAttribute("aria-invalid", "true");
    view.unmount();

    const close = vi.fn();
    const guarded = render(
      <Drawer title="Editor" sub="Details" onClose={close} guard={() => true} footer={<button>Save</button>}>
        <input aria-label="First field" />
      </Drawer>,
    );
    const closeButton = screen.getByRole("button", { name: "Close" });
    expect(closeButton).toHaveFocus();
    await userEvent.click(closeButton);
    expect(close).not.toHaveBeenCalled();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(close).not.toHaveBeenCalled();
    guarded.unmount();

    const confirm = vi.fn();
    render(<ConfirmModal title="Reverse?" body="This is audited." danger onConfirm={confirm} onClose={close} />);
    await userEvent.click(screen.getByRole("button", { name: "Confirm" }));
    expect(confirm).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  it("exercises links, active links, imperative navigation, queries, and redirects", async () => {
    function NavigationProbe() {
      const location = useLocation();
      const navigate = useNavigate();
      const [params, setParams] = useSearchParams();
      return (
        <>
          <span data-testid="path">{location.pathname}</span>
          <span data-testid="search">{location.search}</span>
          <span data-testid="state">{JSON.stringify(location.state)}</span>
          <span data-testid="tab">{params.get("tab")}</span>
          <Link to="/app/account">Account</Link>
          <NavLink to="/app" end className={({ isActive }) => isActive ? "active" : "idle"}>Home</NavLink>
          <NavLink to="/app" className={({ isActive }) => isActive ? "active" : "idle"}>Workspace</NavLink>
          <button onClick={() => navigate("/app/users", { state: { from: "probe" } })}>Users</button>
          <button onClick={() => setParams(new URLSearchParams("tab=two"), { replace: true })}>Query</button>
        </>
      );
    }
    const view = render(<NavigationProbe />);
    expect(screen.getByTestId("path")).toHaveTextContent("/app");
    expect(screen.getByTestId("tab")).toHaveTextContent("one");
    expect(screen.getByRole("link", { name: "Home" })).toHaveClass("active");
    expect(screen.getByRole("link", { name: "Workspace" })).toHaveClass("active");
    await userEvent.click(screen.getByRole("button", { name: "Query" }));
    expect(window.location.search).toBe("?tab=two");
    await userEvent.click(screen.getByRole("button", { name: "Users" }));
    expect(window.location.pathname).toBe("/app/users");
    view.unmount();

    render(<Navigate to="/login" replace state={{ reason: "expired" }} />);
    await vi.waitFor(() => expect(window.location.pathname).toBe("/login"));
  });
});
