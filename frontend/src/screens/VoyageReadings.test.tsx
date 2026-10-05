import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { measurementFixture } from "../measurements/fixtures.test-support";
import type { VesselCall } from "../types";
import { VoyageReadings } from "./VoyageReadings";

const mocked = vi.hoisted(() => ({ list: vi.fn(), can: vi.fn(), calls: [] as VesselCall[] }));
vi.mock("../auth/AuthContext", () => ({ useAuth: () => ({ org: { id: "org-1" }, can: mocked.can }) }));
vi.mock("../app/store", () => ({ useStore: () => ({ calls: mocked.calls }) }));
vi.mock("../lib/navigation", async importOriginal => ({ ...await importOriginal<typeof import("../lib/navigation")>(), useParams: () => ({ callId: "call-1" }) }));
vi.mock("../measurements/api", () => ({ measurementApi: { list: mocked.list } }));
const call: VesselCall = { id: "call-1", reference: "VOY-001", vesselName: "MV Atlas", flag: "NG", type: "Bulk", nrt: 12000, eta: "2026-10-01T09:00:00Z", sailingEta: "", berth: "Berth 3", berthDate: null, status: "in-progress", notes: "", version: 1, registered: "2026-09-29" };
function renderScreen() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><VoyageReadings /></QueryClientProvider>);
  return client;
}

describe("voyage readings screen", () => {
  beforeEach(() => {
    mocked.calls = [call];
    mocked.can.mockReturnValue(true);
    mocked.list.mockResolvedValue({ plans: [measurementFixture()] });
  });

  it("requests only the selected voyage and excludes other voyages returned by the server", async () => {
    const other = measurementFixture(); other.id = "other-plan"; other.callId = "call-2"; other.title = "Other voyage cargo"; other.lines[0].description = "Other voyage oil";
    mocked.list.mockResolvedValue({ plans: [measurementFixture(), other] });
    renderScreen();
    const table = await screen.findByRole("table");
    expect(mocked.list).toHaveBeenCalledWith("call-1");
    expect(within(table).getByRole("columnheader", { name: /Owner declaration/ })).toBeInTheDocument();
    expect(within(table).getByText("Wheat")).toBeInTheDocument();
    expect(screen.queryByText("Other voyage oil")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Voyages" })).toHaveAttribute("href", "/app/measurements");
    expect(screen.getByRole("link", { name: "Voyage details" })).toHaveAttribute("href", "/app/vessel-calls/call-1");
    expect(screen.getByRole("link", { name: "Continue agency readings" })).toHaveAttribute("href", "/app/measurements/plan-1");
  });

  it("can display historical voyage identity when its call is not in the loaded store", async () => {
    mocked.calls = [];
    renderScreen();
    await screen.findByRole("table");
    expect(screen.getByText(/CALL-001/)).toBeInTheDocument();
    expect(screen.getByText("MV Atlas", { selector: ".desc strong" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Voyage details" })).not.toBeInTheDocument();
  });

  it("lets a manager start a declaration on an empty active voyage", async () => {
    mocked.list.mockResolvedValue({ plans: [] });
    renderScreen();
    expect(await screen.findByRole("link", { name: "Start owner declaration" })).toHaveAttribute("href", "/app/measurements/new?callId=call-1");
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it.each(["viewer", "cancelled"])("keeps an empty %s voyage read-only", async state => {
    mocked.list.mockResolvedValue({ plans: [] });
    if (state === "viewer") mocked.can.mockReturnValue(false);
    else mocked.calls = [{ ...call, status: "cancelled" }];
    renderScreen();
    await screen.findByText("No cargo sheets recorded for this voyage.");
    expect(screen.queryByRole("link", { name: "Start owner declaration" })).not.toBeInTheDocument();
  });

  it("does not turn an API failure into an empty voyage or advertise a new declaration", async () => {
    mocked.list.mockRejectedValue(new Error("Readings unavailable"));
    renderScreen();
    expect(await screen.findByText("Readings unavailable")).toBeInTheDocument();
    expect(screen.queryByText("No cargo sheets recorded for this voyage.")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Start owner declaration" })).not.toBeInTheDocument();
  });

  it("refreshes the table with a later agency submission and respects read-only access", async () => {
    mocked.can.mockReturnValue(false);
    const client = renderScreen();
    const table = await screen.findByRole("table");
    expect(within(table).getByText("Awaiting")).toBeInTheDocument();
    const plan = measurementFixture();
    plan.submissions.push({ ...plan.submissions[0], id: "terminal-reading", participantId: "party-2", lines: [{ lineId: "line-1", status: "reported", quantity: "19507.000", note: "" }] });
    act(() => client.setQueryData(["measurement-plans", "org-1", "call-1"], { plans: [plan] }));
    expect(await within(table).findByText("19,507")).toBeInTheDocument();
    expect(within(table).queryByText("Awaiting")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Continue agency readings" })).not.toBeInTheDocument();
  });
});
