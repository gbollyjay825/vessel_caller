import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "../lib/api";
import { SystemAccount } from "./SystemAccount";

const apiMock = vi.hoisted(() => ({ systemStepUp: vi.fn() }));
const authMock = vi.hoisted(() => ({
  platformAccess: {
    role: "SystemAdmin",
    permissions: ["platform.organizations.manage"],
    mfaEnrollmentRequired: false,
    stepUpRequired: true,
    assuranceExpiresAt: null as string | null,
  },
  refreshSession: vi.fn(),
}));

vi.mock("../lib/api", () => ({
  api: apiMock,
  ApiError: class ApiError extends Error {
    status: number;
    errors: Record<string, string | string[]>;
    requestId: string | null;
    constructor(message: string, status: number, errors = {}, requestId: string | null = null) {
      super(message);
      this.status = status;
      this.errors = errors;
      this.requestId = requestId;
    }
  },
}));
vi.mock("../auth/AuthContext", () => ({ useAuth: () => authMock }));
vi.mock("../screens/AccountSecurity", () => ({
  AccountSecurity: ({
    initialTab,
    prioritizeMfa,
  }: {
    initialTab?: string;
    prioritizeMfa?: boolean;
  }) => (
    <div
      data-testid="shared-account-security"
      data-initial-tab={initialTab}
      data-prioritize-mfa={String(Boolean(prioritizeMfa))}
    >
      Shared account security settings
    </div>
  ),
}));

function renderAccount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(<QueryClientProvider client={client}><SystemAccount /></QueryClientProvider>);
}

describe("SystemAccount", () => {
  beforeEach(() => {
    apiMock.systemStepUp.mockReset();
    authMock.refreshSession.mockReset();
    authMock.refreshSession.mockResolvedValue(undefined);
    authMock.platformAccess.mfaEnrollmentRequired = false;
    authMock.platformAccess.stepUpRequired = true;
    authMock.platformAccess.assuranceExpiresAt = null;
  });

  it("submits by keyboard, gives generic invalid-code feedback, and refreshes assurance", async () => {
    apiMock.systemStepUp
      .mockRejectedValueOnce(new ApiError("Invalid authentication code", 400))
      .mockResolvedValueOnce({
        detail: "System Administrator verification refreshed",
        platformAccess: { ...authMock.platformAccess, stepUpRequired: false },
      });
    renderAccount();

    const input = screen.getByLabelText("Authenticator or recovery code");
    expect(input).toHaveAttribute("autocomplete", "one-time-code");
    expect(input).toHaveAccessibleDescription(/never displayed or stored/i);
    expect(screen.getByRole("button", { name: "Verify platform changes" })).toBeDisabled();

    await userEvent.type(input, "000000{Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent("Invalid authentication code");
    expect(apiMock.systemStepUp).toHaveBeenCalledWith("000000");

    await userEvent.clear(input);
    await userEvent.type(input, "123456{Enter}");
    expect(await screen.findByText("System Administrator verification refreshed.")).toBeInTheDocument();
    expect(apiMock.systemStepUp).toHaveBeenLastCalledWith("123456");
    expect(authMock.refreshSession).toHaveBeenCalledOnce();
  });

  it("directs an unenrolled operator to complete MFA before step-up", () => {
    authMock.platformAccess.mfaEnrollmentRequired = true;
    renderAccount();

    expect(screen.getByText("Secure your System Administrator account")).toBeInTheDocument();
    expect(screen.getByText(/unlock the platform overview, organization directory, and audit trail/i)).toBeInTheDocument();
    expect(screen.getByText("Open the control plane")).toBeInTheDocument();
    expect(screen.queryByLabelText("Authenticator or recovery code")).not.toBeInTheDocument();
    expect(screen.getByTestId("shared-account-security")).toHaveAttribute("data-initial-tab", "security");
    expect(screen.getByTestId("shared-account-security")).toHaveAttribute("data-prioritize-mfa", "true");
  });

  it("shows the assurance expiry while still allowing deliberate reverification", () => {
    authMock.platformAccess.stepUpRequired = false;
    authMock.platformAccess.assuranceExpiresAt = "2026-08-10T23:30:00Z";
    renderAccount();

    expect(screen.getByText("Recently verified")).toBeInTheDocument();
    expect(screen.getByText(/High-impact controls are available until/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Verify again" })).toBeDisabled();
  });
});
