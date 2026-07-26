import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ProtectedRoute } from "./ProtectedRoute";

const authMock = vi.hoisted(() => ({
  status: "authenticated",
  authError: null as string | null,
  sessionExpired: false,
  can: vi.fn<(permission: string) => boolean>(),
  retrySession: vi.fn(),
}));

vi.mock("../auth/AuthContext", () => ({
  useAuth: () => authMock,
}));

vi.mock("../lib/navigation", () => ({
  useLocation: () => ({ pathname: "/app/users", search: "?page=2" }),
  Navigate: ({ to, state }: { to: string; state?: unknown }) => (
    <div data-testid="navigate" data-to={to}>{JSON.stringify(state)}</div>
  ),
}));

describe("ProtectedRoute", () => {
  beforeEach(() => {
    authMock.status = "authenticated";
    authMock.authError = null;
    authMock.sessionExpired = false;
    authMock.can.mockReset();
    authMock.can.mockReturnValue(true);
    authMock.retrySession.mockReset();
    authMock.retrySession.mockResolvedValue(undefined);
  });

  it("shows a retryable service error instead of misreporting an outage as logout", async () => {
    authMock.status = "unavailable";
    authMock.authError = "Session service unavailable.";
    render(<ProtectedRoute>Private content</ProtectedRoute>);

    expect(screen.getByRole("alert")).toHaveTextContent("Session service unavailable.");
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(authMock.retrySession).toHaveBeenCalledOnce();
  });

  it("preserves the requested URL and expiry reason for reauthentication", () => {
    authMock.status = "anonymous";
    authMock.sessionExpired = true;
    render(<ProtectedRoute>Private content</ProtectedRoute>);

    const navigation = screen.getByTestId("navigate");
    expect(navigation).toHaveAttribute("data-to", "/login");
    expect(navigation).toHaveTextContent('"from":"/app/users?page=2"');
    expect(navigation).toHaveTextContent('"reason":"session-expired"');
  });

  it("redirects denied permissions and renders authorized content", () => {
    authMock.can.mockReturnValue(false);
    const denied = render(
      <ProtectedRoute permission="users.manage">Private content</ProtectedRoute>,
    );
    expect(screen.getByTestId("navigate")).toHaveAttribute("data-to", "/app");

    denied.unmount();
    authMock.can.mockReturnValue(true);
    render(<ProtectedRoute permission="users.manage">Private content</ProtectedRoute>);
    expect(screen.getByText("Private content")).toBeInTheDocument();
  });
});
