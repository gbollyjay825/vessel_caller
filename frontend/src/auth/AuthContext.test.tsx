import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "../lib/api";
import { queryClient } from "../lib/queryClient";
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

const platformSession: AuthSession = {
  ...session,
  org: null,
  permissions: [],
  platformAccess: {
    role: "SystemAdmin",
    permissions: ["platform.organizations.view", "platform.audit.view"],
    mfaEnrollmentRequired: false,
  },
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
      <span data-testid="platform-role">{auth.platformAccess?.role ?? "none"}</span>
      <span data-testid="platform-home">{auth.homePath}</span>
      <span data-testid="can-platform">{String(auth.can("platform.organizations.view"))}</span>
      <span data-testid="step-up">{String(auth.platformAccess?.stepUpRequired ?? false)}</span>
      <button type="button" onClick={() => void auth.logout()}>Sign out</button>
      <button type="button" onClick={() => void auth.retrySession()}>Retry session</button>
    </div>
  );
}

describe("AuthProvider", () => {
  afterEach(() => vi.useRealTimers());
  beforeEach(() => {
    queryClient.clear();
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

  it("hydrates an isolated platform session and trusts platform permissions", async () => {
    apiMock.me.mockResolvedValue(platformSession);
    render(<AuthProvider><Probe /></AuthProvider>);

    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("authenticated"));
    expect(screen.getByTestId("platform-role")).toHaveTextContent("SystemAdmin");
    expect(screen.getByTestId("platform-home")).toHaveTextContent("/system");
    expect(screen.getByTestId("can-platform")).toHaveTextContent("true");
    expect(screen.getByTestId("can-users")).toHaveTextContent("false");
  });

  it("routes a platform identity with zero permissions to MFA enrollment", async () => {
    apiMock.me.mockResolvedValue({
      ...platformSession,
      platformAccess: {
        role: "SystemAdmin",
        permissions: [],
        mfaEnrollmentRequired: true,
      },
    });
    render(<AuthProvider><Probe /></AuthProvider>);

    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("authenticated"));
    expect(screen.getByTestId("platform-home")).toHaveTextContent("/system/account");
    expect(screen.getByTestId("can-platform")).toHaveTextContent("false");
  });

  it("marks recent platform assurance stale when its bounded timer expires", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-10T23:00:00Z"));
    apiMock.me.mockResolvedValue({
      ...platformSession,
      platformAccess: {
        ...platformSession.platformAccess!,
        assuranceExpiresAt: "2026-08-10T23:00:01Z",
        stepUpRequired: false,
      },
    });
    render(<AuthProvider><Probe /></AuthProvider>);
    await act(async () => { await Promise.resolve(); });

    expect(screen.getByTestId("step-up")).toHaveTextContent("false");
    await act(async () => { vi.advanceTimersByTime(1_001); });
    expect(screen.getByTestId("step-up")).toHaveTextContent("true");
  });

  it("clears local auth state even if the logout request fails", async () => {
    apiMock.me.mockResolvedValue(session);
    apiMock.logout.mockRejectedValue(new Error("network"));
    render(<AuthProvider><Probe /></AuthProvider>);
    await screen.findByText("Ada Admin");
    queryClient.setQueryData(["profile"], { user: session.user });

    await userEvent.click(screen.getByRole("button", { name: "Sign out" }));

    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("anonymous"));
    expect(screen.getByTestId("name")).toHaveTextContent("none");
    expect(queueMock.clearQueuedInspectionsForOwner).toHaveBeenCalledWith("org-1", "user-1");
    expect(queryClient.getQueryData(["profile"])).toBeUndefined();
  });

  it("clears user-scoped queries when the authenticated identity changes", async () => {
    const nextSession: AuthSession = {
      ...platformSession,
      user: { ...platformSession.user, id: "platform-user-2", email: "operator@example.com" },
    };
    apiMock.me.mockResolvedValueOnce(session).mockResolvedValueOnce(nextSession);
    render(<AuthProvider><Probe /></AuthProvider>);
    await screen.findByText("Ada Admin");
    queryClient.setQueryData(["sessions"], { results: [{ id: "opaque-session-a" }] });

    await userEvent.click(screen.getByRole("button", { name: "Retry session" }));

    await screen.findByText("Ada Admin");
    await waitFor(() => expect(screen.getByTestId("platform-role")).toHaveTextContent("SystemAdmin"));
    expect(queryClient.getQueryData(["sessions"])).toBeUndefined();
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
