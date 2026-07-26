import { render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AppLoader } from "./AppLoader";

const mocks = vi.hoisted(() => ({
  state: vi.fn(),
  initial: null as unknown,
}));

vi.mock("../lib/api", () => ({ api: { state: mocks.state } }));
vi.mock("./store", () => ({
  StoreProvider: ({ initial, children }: { initial: unknown; children: ReactNode }) => {
    mocks.initial = initial;
    return <div data-testid="store-provider">{children}</div>;
  },
}));

const state = {
  rev: 1,
  org: { id: "org-1" },
  settings: {},
  calls: [],
  inspections: [],
  invoices: [],
};

describe("AppLoader", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.initial = null;
  });

  it("shows a loading state and mounts the store with server state", async () => {
    let resolveState: (value: unknown) => void = () => {};
    mocks.state.mockReturnValue(new Promise((resolve) => { resolveState = resolve; }));
    render(<AppLoader><div>Workspace ready</div></AppLoader>);
    expect(screen.getByText(/Loading port data/)).toBeInTheDocument();

    resolveState(state);
    expect(await screen.findByText("Workspace ready")).toBeInTheDocument();
    expect(mocks.initial).toBe(state);
  });

  it("renders a useful server error", async () => {
    mocks.state.mockRejectedValue(new Error("State service unavailable"));
    render(<AppLoader><div>Hidden</div></AppLoader>);
    expect(await screen.findByText(/State service unavailable/)).toBeInTheDocument();
    expect(screen.queryByText("Hidden")).not.toBeInTheDocument();
  });

  it("uses a safe fallback for non-standard failures", async () => {
    mocks.state.mockRejectedValue(null);
    render(<AppLoader><div>Hidden</div></AppLoader>);
    await waitFor(() => expect(screen.getByText(/Could not load your data/)).toBeInTheDocument());
  });
});
