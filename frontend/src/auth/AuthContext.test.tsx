import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "../lib/api";
import type { AuthSession } from "../types";
import { AuthProvider, useAuth } from "./AuthContext";

const apiMock = vi.hoisted(() => ({
  me: vi.fn(),
  login: vi.fn(),
  verifyMfaChallenge: vi.fn(),
  register: vi.fn(),
  logout: vi.fn(),
}));
const queueMock = vi.hoisted(() => ({
  clearQueuedInspectionsForOwner: vi.fn(),
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

const session: AuthSession = {
  user: {
    id: "user-1",
    name: "Ada Admin",
    email: "ada@example.com",
    role: "Admin",
    status: "active",
    emailVerified: true,
    mfaEnabled: true,
    mfaRequired: true,
  },
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
  permissions: ["users.view", "audit.view"],
};

function Probe() {
  const auth = useAuth();
  return (
    <div>
      <span data-testid="status">{auth.status}</span>
      <span data-testid="name">{auth.user?.name ?? "none"}</span>
      <span data-testid="can-users">{String(auth.can("users.view"))}</span>
      <span data-testid="can-settings">{String(auth.can("settings.manage"))}</span>
      <span data-testid="expired">{String(auth.sessionExpired)}</span>
      <span data-testid="auth-error">{auth.authError ?? "none"}</span>
      <button type="button" onClick={() => void auth.logout()}>Sign out</button>
      <button type="button" onClick={() => void auth.retrySession()}>Retry session</button>
    </div>
  );
}

describe("AuthProvider", () => {
  beforeEach(() => {
    Object.values(apiMock).forEach((mock) => mock.mockReset());
    queueMock.clearQueuedInspectionsForOwner.mockReset();
    queueMock.clearQueuedInspectionsForOwner.mockResolvedValue(undefined);
  });

  it("hydrates a Django session and trusts server permissions", async () => {
    apiMock.me.mockResolvedValue(session);
    render(<AuthProvider><Probe /></AuthProvider>);

    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("authenticated"));
    expect(screen.getByTestId("name")).toHaveTextContent("Ada Admin");
    expect(screen.getByTestId("can-users")).toHaveTextContent("true");
    expect(screen.getByTestId("can-settings")).toHaveTextContent("false");
  });

  it("clears local auth state even if the logout request fails", async () => {
    apiMock.me.mockResolvedValue(session);
    apiMock.logout.mockRejectedValue(new Error("network"));
    render(<AuthProvider><Probe /></AuthProvider>);
    await screen.findByText("Ada Admin");

    await userEvent.click(screen.getByRole("button", { name: "Sign out" }));

    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("anonymous"));
    expect(screen.getByTestId("name")).toHaveTextContent("none");
    expect(queueMock.clearQueuedInspectionsForOwner).toHaveBeenCalledWith("org-1", "user-1");
  });

  it("distinguishes an unavailable session service from an anonymous session", async () => {
    apiMock.me.mockRejectedValueOnce(new Error("network"));
    render(<AuthProvider><Probe /></AuthProvider>);

    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("unavailable"));
    expect(screen.getByTestId("auth-error")).toHaveTextContent("secure session service");

    apiMock.me.mockResolvedValueOnce(session);
    await userEvent.click(screen.getByRole("button", { name: "Retry session" }));
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("authenticated"));
  });

  it("treats an unauthorized session check as anonymous", async () => {
    apiMock.me.mockRejectedValueOnce(new ApiError("Authentication required", 401));
    render(<AuthProvider><Probe /></AuthProvider>);

    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("anonymous"));
    expect(screen.getByTestId("expired")).toHaveTextContent("false");
  });

  it("treats Django REST Framework's anonymous 403 session response as signed out", async () => {
    apiMock.me.mockRejectedValueOnce(
      new ApiError("Authentication credentials were not provided.", 403),
    );
    render(<AuthProvider><Probe /></AuthProvider>);

    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("anonymous"));
    expect(screen.getByTestId("auth-error")).toHaveTextContent("none");
  });

  it("marks an active session as expired after a server rejection", async () => {
    apiMock.me.mockResolvedValue(session);
    render(<AuthProvider><Probe /></AuthProvider>);
    await screen.findByText("Ada Admin");

    window.dispatchEvent(new CustomEvent("auth:expired"));

    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("anonymous"));
    expect(screen.getByTestId("expired")).toHaveTextContent("true");
  });
});
