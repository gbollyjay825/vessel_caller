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
}));
vi.mock("../lib/api", () => ({
  api: { profile: mocks.profile, setupMfa: mocks.setupMfa, confirmMfa: mocks.confirmMfa },
  ApiError: class ApiError extends Error {},
}));
vi.mock("../auth/AuthContext", () => ({
  useAuth: () => ({
    user: { id: "u-1", name: "Ada", mfaEnabled: !mocks.enrollmentRequired, mfaEnrollmentRequired: mocks.enrollmentRequired },
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
    view.rerender(account(queryClient));

    expect(screen.getByRole("heading", { name: "MFA is enabled" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Password & MFA" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("test-only-recovery-one")).toBeInTheDocument();
    expect(screen.getByText("test-only-recovery-two")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open workspace" })).toHaveAttribute("href", "/app");
    expect(mocks.profile).not.toHaveBeenCalled();
  });

  it("keeps the regular customer profile reachable without loading the workspace", async () => {
    mocks.enrollmentRequired = false;
    render(account(client()));
    expect(await screen.findByLabelText(/Full name/)).toHaveValue("Ada");
    expect(screen.getByRole("heading", { name: "Your account" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open workspace" })).toHaveAttribute("href", "/app");
  });
});
