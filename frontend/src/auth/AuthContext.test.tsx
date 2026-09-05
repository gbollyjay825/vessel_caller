import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError, type LoginResult } from "../lib/api";
import {
  advanceAuthSessionEpoch,
  publishAuthSessionBoundary,
  resetAuthSessionEpochForTests,
} from "../lib/authSessionEpoch";
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

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
      <button type="button" onClick={() => void auth.refreshSession().catch(() => undefined)}>
        Refresh session
      </button>
      <button type="button" onClick={() => void auth.login("next@example.com", "password").catch(() => undefined)}>
        Log in next identity
      </button>
    </div>
  );
}

describe("AuthProvider", () => {
  afterEach(() => vi.useRealTimers());
  beforeEach(() => {
    resetAuthSessionEpochForTests();
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

  it("clears identity-bound UI immediately and rehydrates after another tab changes the session", async () => {
    const originalBroadcastChannel = Object.getOwnPropertyDescriptor(globalThis, "BroadcastChannel");
    class FakeBroadcastChannel {
      static instances: FakeBroadcastChannel[] = [];

      readonly postMessage = vi.fn();
      private readonly listeners = new Set<(event: MessageEvent) => void>();

      constructor(_name: string) {
        FakeBroadcastChannel.instances.push(this);
      }

      addEventListener(_type: "message", listener: (event: MessageEvent) => void) {
        this.listeners.add(listener);
      }

      close() {
        this.listeners.clear();
      }

      emitBoundary() {
        this.listeners.forEach((listener) => listener(new MessageEvent("message", {
          data: { type: "auth-boundary-v1", phase: "boundary", nonce: "peer-event" },
        })));
      }
    }
    Object.defineProperty(globalThis, "BroadcastChannel", {
      configurable: true,
      value: FakeBroadcastChannel,
    });
    resetAuthSessionEpochForTests();
    const nextSession: AuthSession = {
      ...platformSession,
      user: { ...platformSession.user, id: "platform-user-2", name: "Grace Operator" },
    };
    const nextHydration = deferred<AuthSession>();
    apiMock.me.mockResolvedValueOnce(session).mockReturnValueOnce(nextHydration.promise);

    try {
      render(<AuthProvider><Probe /></AuthProvider>);
      await screen.findByText("Ada Admin");
      queryClient.setQueryData(["system-organizations"], { results: [{ id: "org-sensitive" }] });

      act(() => FakeBroadcastChannel.instances[0].emitBoundary());
      expect(screen.getByTestId("status")).toHaveTextContent("loading");
      expect(screen.getByTestId("name")).toHaveTextContent("none");
      expect(queryClient.getQueryData(["system-organizations"])).toBeUndefined();

      await act(async () => nextHydration.resolve(nextSession));
      await screen.findByText("Grace Operator");
      expect(apiMock.me).toHaveBeenCalledTimes(2);
      expect(FakeBroadcastChannel.instances[0].postMessage).not.toHaveBeenCalled();
    } finally {
      resetAuthSessionEpochForTests();
      if (originalBroadcastChannel) {
        Object.defineProperty(globalThis, "BroadcastChannel", originalBroadcastChannel);
      } else {
        Reflect.deleteProperty(globalThis, "BroadcastChannel");
      }
    }
  });

  it("keeps peer identity cleared until a cookie transition settles, then rehydrates once", async () => {
    const originalBroadcastChannel = Object.getOwnPropertyDescriptor(globalThis, "BroadcastChannel");
    class FakeBroadcastChannel {
      static instance: FakeBroadcastChannel;

      readonly postMessage = vi.fn();
      private readonly listeners = new Set<(event: MessageEvent) => void>();

      constructor(_name: string) {
        FakeBroadcastChannel.instance = this;
      }

      addEventListener(_type: "message", listener: (event: MessageEvent) => void) {
        this.listeners.add(listener);
      }

      close() {
        this.listeners.clear();
      }

      emitPeerBoundary(phase: "start" | "settled") {
        this.listeners.forEach((listener) => listener(new MessageEvent("message", {
          data: { type: "auth-boundary-v1", phase, transitionId: "other-tab-login" },
        })));
      }
    }
    Object.defineProperty(globalThis, "BroadcastChannel", {
      configurable: true,
      value: FakeBroadcastChannel,
    });
    resetAuthSessionEpochForTests();
    const nextSession: AuthSession = {
      ...platformSession,
      user: { ...platformSession.user, id: "operator-2", name: "Grace Operator" },
    };
    apiMock.me.mockRejectedValueOnce(new ApiError("Authentication required", 401));

    try {
      render(<AuthProvider><Probe /></AuthProvider>);
      await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("anonymous"));
      FakeBroadcastChannel.instance.postMessage.mockClear();
      apiMock.me.mockResolvedValueOnce(nextSession);
      act(() => FakeBroadcastChannel.instance.emitPeerBoundary("start"));
      expect(screen.getByTestId("status")).toHaveTextContent("loading");
      expect(apiMock.me).toHaveBeenCalledOnce();

      act(() => FakeBroadcastChannel.instance.emitPeerBoundary("settled"));
      await waitFor(() => expect(apiMock.me).toHaveBeenCalledTimes(2));
      await screen.findByText("Grace Operator");
      expect(FakeBroadcastChannel.instance.postMessage).not.toHaveBeenCalled();
    } finally {
      resetAuthSessionEpochForTests();
      if (originalBroadcastChannel) {
        Object.defineProperty(globalThis, "BroadcastChannel", originalBroadcastChannel);
      } else {
        Reflect.deleteProperty(globalThis, "BroadcastChannel");
      }
    }
  });

  it("recovers when a source tab disappears before settling its identity transition", async () => {
    vi.useFakeTimers();
    const originalBroadcastChannel = Object.getOwnPropertyDescriptor(globalThis, "BroadcastChannel");
    class FakeBroadcastChannel {
      static instance: FakeBroadcastChannel;
      private readonly listeners = new Set<(event: MessageEvent) => void>();

      constructor(_name: string) {
        FakeBroadcastChannel.instance = this;
      }

      addEventListener(_type: "message", listener: (event: MessageEvent) => void) {
        this.listeners.add(listener);
      }

      postMessage() {}
      close() { this.listeners.clear(); }

      emitStart() {
        this.listeners.forEach((listener) => listener(new MessageEvent("message", {
          data: { type: "auth-boundary-v1", phase: "start", transitionId: "abandoned-tab" },
        })));
      }
    }
    Object.defineProperty(globalThis, "BroadcastChannel", {
      configurable: true,
      value: FakeBroadcastChannel,
    });
    resetAuthSessionEpochForTests();
    apiMock.me.mockResolvedValueOnce(session).mockResolvedValueOnce(platformSession);

    try {
      render(<AuthProvider><Probe /></AuthProvider>);
      await act(async () => { await Promise.resolve(); });
      expect(screen.getByTestId("name")).toHaveTextContent("Ada Admin");

      act(() => FakeBroadcastChannel.instance.emitStart());
      expect(screen.getByTestId("status")).toHaveTextContent("loading");
      expect(apiMock.me).toHaveBeenCalledOnce();

      await act(async () => { await vi.advanceTimersByTimeAsync(17_001); });
      expect(apiMock.me).toHaveBeenCalledTimes(2);
      await act(async () => { await Promise.resolve(); });
      expect(screen.getByTestId("platform-role")).toHaveTextContent("SystemAdmin");
    } finally {
      resetAuthSessionEpochForTests();
      if (originalBroadcastChannel) {
        Object.defineProperty(globalThis, "BroadcastChannel", originalBroadcastChannel);
      } else {
        Reflect.deleteProperty(globalThis, "BroadcastChannel");
      }
    }
  });

  it("rehydrates the current tab after a direct security API changes its session", async () => {
    apiMock.me.mockResolvedValueOnce(session).mockResolvedValueOnce(platformSession);
    render(<AuthProvider><Probe /></AuthProvider>);
    await screen.findByText("Ada Admin");
    queryClient.setQueryData(["profile"], { user: session.user });

    act(() => { publishAuthSessionBoundary(true); });
    expect(screen.getByTestId("status")).toHaveTextContent("loading");
    expect(queryClient.getQueryData(["profile"])).toBeUndefined();
    await waitFor(() => expect(screen.getByTestId("platform-role")).toHaveTextContent("SystemAdmin"));
  });

  it("settles unavailable when a peer invalidates a successful login and both reconciliations fail", async () => {
    const loginResponse = deferred<LoginResult>();
    const peerReconciliation = deferred<AuthSession>();
    apiMock.me
      .mockRejectedValueOnce(new ApiError("Authentication required", 401))
      .mockReturnValueOnce(peerReconciliation.promise)
      .mockRejectedValueOnce(new Error("network"));
    apiMock.login.mockReturnValueOnce(loginResponse.promise);
    render(<AuthProvider><Probe /></AuthProvider>);
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("anonymous"));

    await userEvent.click(screen.getByRole("button", { name: "Log in next identity" }));
    act(() => { publishAuthSessionBoundary(true); });
    await waitFor(() => expect(apiMock.me).toHaveBeenCalledTimes(2));

    await act(async () => loginResponse.resolve(platformSession));
    await waitFor(() => expect(apiMock.me).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("unavailable"));

    await act(async () => peerReconciliation.reject(new Error("peer network")));
    expect(screen.getByTestId("status")).toHaveTextContent("unavailable");
    expect(screen.getByTestId("auth-error")).toHaveTextContent("secure session service");
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

  it("clears cached platform access when a background refresh loses authorization", async () => {
    apiMock.me
      .mockResolvedValueOnce(platformSession)
      .mockRejectedValueOnce(new ApiError("Authentication required", 401));
    render(<AuthProvider><Probe /></AuthProvider>);
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("authenticated"));
    queryClient.setQueryData(["system-organizations"], { results: [{ id: "org-sensitive" }] });

    await userEvent.click(screen.getByRole("button", { name: "Refresh session" }));

    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("anonymous"));
    expect(screen.getByTestId("platform-role")).toHaveTextContent("none");
    expect(screen.getByTestId("expired")).toHaveTextContent("true");
    expect(queryClient.getQueryData(["system-organizations"])).toBeUndefined();
  });

  it("ignores an older successful refresh after a newer refresh loses authorization", async () => {
    const olderRefresh = deferred<AuthSession>();
    apiMock.me
      .mockResolvedValueOnce(platformSession)
      .mockReturnValueOnce(olderRefresh.promise)
      .mockRejectedValueOnce(new ApiError("Authentication required", 401));
    render(<AuthProvider><Probe /></AuthProvider>);
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("authenticated"));

    await userEvent.click(screen.getByRole("button", { name: "Refresh session" }));
    await userEvent.click(screen.getByRole("button", { name: "Refresh session" }));
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("anonymous"));

    await act(async () => olderRefresh.resolve(platformSession));
    expect(screen.getByTestId("status")).toHaveTextContent("anonymous");
    expect(screen.getByTestId("platform-role")).toHaveTextContent("none");
  });

  it("honors an older same-epoch 401 when a newer refresh only fails transiently", async () => {
    const olderRefresh = deferred<AuthSession>();
    const newerRefresh = deferred<AuthSession>();
    apiMock.me
      .mockResolvedValueOnce(platformSession)
      .mockReturnValueOnce(olderRefresh.promise)
      .mockReturnValueOnce(newerRefresh.promise);
    render(<AuthProvider><Probe /></AuthProvider>);
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("authenticated"));

    await userEvent.click(screen.getByRole("button", { name: "Refresh session" }));
    await userEvent.click(screen.getByRole("button", { name: "Refresh session" }));
    await act(async () => olderRefresh.reject(new ApiError("Authentication required", 401)));
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("anonymous"));

    await act(async () => newerRefresh.reject(new Error("network")));
    expect(screen.getByTestId("status")).toHaveTextContent("anonymous");
    expect(screen.getByTestId("platform-role")).toHaveTextContent("none");
  });

  it("does not let an in-flight refresh resurrect a signed-out session", async () => {
    const refresh = deferred<AuthSession>();
    const remoteLogout = deferred<void>();
    apiMock.me.mockResolvedValueOnce(platformSession).mockReturnValueOnce(refresh.promise);
    apiMock.logout.mockReturnValueOnce(remoteLogout.promise);
    render(<AuthProvider><Probe /></AuthProvider>);
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("authenticated"));

    await userEvent.click(screen.getByRole("button", { name: "Refresh session" }));
    await userEvent.click(screen.getByRole("button", { name: "Sign out" }));
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("anonymous"));

    await act(async () => refresh.resolve(platformSession));
    expect(screen.getByTestId("status")).toHaveTextContent("anonymous");
    remoteLogout.resolve();
  });

  it("does not start a new login until an in-flight remote logout settles", async () => {
    const remoteLogout = deferred<void>();
    const offlineCleanup = deferred<void>();
    const nextSession: AuthSession = {
      ...session,
      user: { ...session.user, id: "user-2", name: "Grace Admin", email: "next@example.com" },
    };
    apiMock.me.mockResolvedValueOnce(session);
    apiMock.logout.mockReturnValueOnce(remoteLogout.promise);
    apiMock.login.mockResolvedValueOnce(nextSession);
    queueMock.clearQueuedInspectionsForOwner.mockReturnValueOnce(offlineCleanup.promise);
    render(<AuthProvider><Probe /></AuthProvider>);
    await screen.findByText("Ada Admin");

    await userEvent.click(screen.getByRole("button", { name: "Sign out" }));
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("anonymous"));
    await userEvent.click(screen.getByRole("button", { name: "Log in next identity" }));
    expect(apiMock.login).not.toHaveBeenCalled();

    await act(async () => remoteLogout.resolve());
    await waitFor(() => expect(apiMock.login).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.getByTestId("name")).toHaveTextContent("Grace Admin"));
    // Owner-explicit IndexedDB cleanup is not part of the cookie barrier.
    expect(queueMock.clearQueuedInspectionsForOwner).toHaveBeenCalledOnce();
    offlineCleanup.resolve();
  });

  it("commits a queued login after an earlier cookie mutation advances the shared epoch", async () => {
    const queuedLogin = deferred<LoginResult>();
    const nextSession: AuthSession = {
      ...platformSession,
      user: { ...platformSession.user, id: "operator-2", name: "Grace Operator" },
    };
    apiMock.me.mockRejectedValueOnce(new ApiError("Authentication required", 401));
    apiMock.login.mockReturnValueOnce(queuedLogin.promise);
    render(<AuthProvider><Probe /></AuthProvider>);
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("anonymous"));

    await userEvent.click(screen.getByRole("button", { name: "Log in next identity" }));
    advanceAuthSessionEpoch(); // preceding serialized password response settles
    await act(async () => queuedLogin.resolve(nextSession));

    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("authenticated"));
    expect(screen.getByTestId("name")).toHaveTextContent("Grace Operator");
  });

  it("ignores initial hydration rejection after a login intent is queued", async () => {
    const initialHydration = deferred<AuthSession>();
    const queuedLogin = deferred<LoginResult>();
    const nextSession: AuthSession = {
      ...platformSession,
      user: { ...platformSession.user, id: "operator-3", name: "Queued Operator" },
    };
    apiMock.me.mockReturnValueOnce(initialHydration.promise);
    apiMock.login.mockReturnValueOnce(queuedLogin.promise);
    render(<AuthProvider><Probe /></AuthProvider>);

    await userEvent.click(screen.getByRole("button", { name: "Log in next identity" }));
    await act(async () => initialHydration.reject(new ApiError("Authentication required", 401)));
    expect(screen.getByTestId("status")).toHaveTextContent("loading");

    await act(async () => queuedLogin.resolve(nextSession));
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("authenticated"));
    expect(screen.getByTestId("name")).toHaveTextContent("Queued Operator");
  });

  it("settles anonymous when a queued login fails after superseding hydration", async () => {
    const initialHydration = deferred<AuthSession>();
    const queuedLogin = deferred<LoginResult>();
    apiMock.me.mockReturnValueOnce(initialHydration.promise);
    apiMock.login.mockReturnValueOnce(queuedLogin.promise);
    render(<AuthProvider><Probe /></AuthProvider>);

    await userEvent.click(screen.getByRole("button", { name: "Log in next identity" }));
    await act(async () => initialHydration.reject(new ApiError("Authentication required", 401)));
    await act(async () => queuedLogin.reject(new ApiError("Invalid email or password", 401)));

    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("anonymous"));
  });

  it("settles anonymous while a queued login waits for MFA", async () => {
    const initialHydration = deferred<AuthSession>();
    apiMock.me.mockReturnValueOnce(initialHydration.promise);
    apiMock.login.mockResolvedValueOnce({
      mfaRequired: true,
      challengeId: "challenge-1",
    });
    render(<AuthProvider><Probe /></AuthProvider>);

    await userEvent.click(screen.getByRole("button", { name: "Log in next identity" }));
    await act(async () => initialHydration.reject(new ApiError("Authentication required", 401)));

    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("anonymous"));
  });

  it("keeps the current platform session through a transient background refresh failure", async () => {
    apiMock.me.mockResolvedValueOnce(platformSession).mockRejectedValueOnce(new Error("network"));
    render(<AuthProvider><Probe /></AuthProvider>);
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("authenticated"));

    await userEvent.click(screen.getByRole("button", { name: "Refresh session" }));

    expect(screen.getByTestId("status")).toHaveTextContent("authenticated");
    expect(screen.getByTestId("platform-role")).toHaveTextContent("SystemAdmin");
  });
});
