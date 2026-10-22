import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CustomerAccount } from "./CustomerAccount";

const mocks = vi.hoisted(() => ({
  profile: vi.fn(),
  setupMfa: vi.fn(),
  confirmMfa: vi.fn(),
  refreshSession: vi.fn(),
  logout: vi.fn(),
  enrollmentRequired: true,
  mfaEnabled: false,
}));
vi.mock("../lib/api", () => ({
  api: { profile: mocks.profile, setupMfa: mocks.setupMfa, confirmMfa: mocks.confirmMfa },
  ApiError: class ApiError extends Error {},
}));
vi.mock("../auth/AuthContext", () => ({
  useAuth: () => ({
    user: { id: "u-1", name: "Ada", mfaEnabled: mocks.mfaEnabled, mfaEnrollmentRequired: mocks.enrollmentRequired },
    org: { name: "Ada Marine" },
    can: () => !mocks.enrollmentRequired,
    logout: mocks.logout,
    refreshSession: mocks.refreshSession,
  }),
}));

function account(client: QueryClient) {
  return <QueryClientProvider client={client}><CustomerAccount /></QueryClientProvider>;
}
function client() {
  return new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
}

describe("Customer account recovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.enrollmentRequired = true;
    mocks.mfaEnabled = false;
    window.history.replaceState(null, "", "/app/account");
    mocks.refreshSession.mockResolvedValue(undefined);
    mocks.profile.mockResolvedValue({ user: { id: "u-1", name: "Ada", email: "ada@example.com", role: "Admin" } });
    mocks.setupMfa.mockResolvedValue({ secret: "test-only-secret", provisioningUri: "otpauth://test-only" });
    mocks.confirmMfa.mockResolvedValue({ recoveryCodes: ["test-only-recovery-one", "test-only-recovery-two"] });
  });

  it("opens authenticator enrollment without workspace data and keeps sign out available", async () => {
    render(account(client()));
    expect(screen.getByRole("heading", { name: "Set up MFA to open your workspace" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Password & MFA" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("button", { name: "Set up authenticator" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Open workspace" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Manage users" })).not.toBeInTheDocument();
    expect(mocks.profile).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(mocks.logout).toHaveBeenCalledOnce();
  });

  it("preserves recovery codes and the security tab after enrollment refresh unlocks the workspace", async () => {
    const queryClient = client();
    const view = render(account(queryClient));
    const authenticator = within(screen.getByRole("region", { name: "Authenticator app" }));
    await userEvent.type(authenticator.getByLabelText(/Current password/), "test password");
    await userEvent.click(authenticator.getByRole("button", { name: "Set up authenticator" }));
    await userEvent.type(await authenticator.findByLabelText(/Authenticator code/), "123456");
    await userEvent.click(authenticator.getByRole("button", { name: "Enable MFA" }));
    expect(await screen.findByText("test-only-recovery-one")).toBeInTheDocument();
    await waitFor(() => expect(mocks.refreshSession).toHaveBeenCalledOnce());

    mocks.enrollmentRequired = false;
    mocks.mfaEnabled = true;
    view.rerender(account(queryClient));

    expect(screen.getByRole("heading", { name: "MFA is enabled" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Password & MFA" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("test-only-recovery-one")).toBeInTheDocument();
    expect(screen.getByText("test-only-recovery-two")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open workspace" })).toHaveAttribute("href", "/app");
    expect(screen.getByRole("link", { name: "Manage users" })).toHaveAttribute("href", "/app/users");
    expect(mocks.profile).not.toHaveBeenCalled();
  });

  it("keeps the regular customer profile reachable without loading the workspace", async () => {
    mocks.enrollmentRequired = false;
    mocks.mfaEnabled = true;
    render(account(client()));
    expect(await screen.findByLabelText(/Full name/)).toHaveValue("Ada");
    expect(screen.getByRole("heading", { name: "Your account" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open workspace" })).toHaveAttribute("href", "/app");
    expect(screen.getByRole("link", { name: "Manage users" })).toHaveAttribute("href", "/app/users");
  });

  it("guides a new user during the grace period and waits for saved recovery codes before returning to their task", async () => {
    mocks.enrollmentRequired = false;
    window.history.replaceState({ from: "/app/measurements", passwordUpdated: true }, "", "/app/account?setup=authenticator");
    const queryClient = client();
    const view = render(account(queryClient));
    expect(screen.getByRole("heading", { name: "Secure your account" })).toBeInTheDocument();
    expect(screen.getByText("Password updated")).toBeInTheDocument();
    expect(screen.getByAltText("Nigerian Ports Authority")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Open workspace" })).not.toBeInTheDocument();
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
    expect(mocks.profile).not.toHaveBeenCalled();

    await userEvent.type(screen.getByLabelText(/Current password/), "test password");
    await userEvent.click(screen.getByRole("button", { name: "Set up authenticator" }));
    await userEvent.type(await screen.findByLabelText(/Authenticator code/), "123456");
    await userEvent.click(screen.getByRole("button", { name: "Enable MFA" }));
    expect(await screen.findByText("test-only-recovery-one")).toBeInTheDocument();
    mocks.mfaEnabled = true;
    view.rerender(account(queryClient));
    expect(screen.getByText("test-only-recovery-two")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Continue to workspace" })).toBeDisabled();
    expect(window.location.pathname).toBe("/app/account");
    await userEvent.click(screen.getByRole("checkbox", { name: /saved my recovery codes/ }));
    await userEvent.click(screen.getByRole("button", { name: "Continue to workspace" }));
    await waitFor(() => expect(window.location.pathname).toBe("/app/measurements"));
  });

  it("provides a safe continuation if the guide is revisited after MFA is already enabled", async () => {
    mocks.enrollmentRequired = false;
    mocks.mfaEnabled = true;
    window.history.replaceState({ from: "https://untrusted.example" }, "", "/app/account?setup=authenticator");
    render(account(client()));
    expect(screen.queryByText("Password updated")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Set up authenticator" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Continue to workspace" }));
    await waitFor(() => expect(window.location.pathname).toBe("/app"));
  });
});
