import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Landing } from "./LandingFull";

describe("Landing", () => {
  afterEach(() => {
    delete (window as Window & { IntersectionObserver?: typeof IntersectionObserver }).IntersectionObserver;
    document.documentElement.classList.remove("js-reveal");
  });

  it("presents only supported workflows and exposes responsive navigation", async () => {
    render(<Landing />);

    expect(screen.getByRole("heading", { name: /One voyage.*One clear set.*of readings/i })).toBeInTheDocument();
    expect(screen.getByText("The declared load is already paid.")).toBeInTheDocument();
    expect(screen.getByRole("table", { name: "Readings & reconciliation · container counts" })).toBeInTheDocument();
    expect(screen.getByText("Illustrative voyage")).toBeInTheDocument();
    expect(screen.getByText(/An invoice preview is not an issued financial record/i)).toBeInTheDocument();
    expect(screen.getByText(/A lower final quantity is flagged for overpayment review/i)).toBeInTheDocument();
    expect(screen.getByText(/wait for Admin approval/i)).toBeInTheDocument();
    expect(screen.getByText(/Organization data is private/i)).toBeInTheDocument();
    expect(screen.queryByText(/demo credentials/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/live AIS/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Interrupted submissions remain on the device|automated harbour dues/i)).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open workspace" })).toHaveAttribute("href", "/app/dashboard");
    expect(screen.queryByRole("link", { name: /Register an organization/i })).not.toBeInTheDocument();

    const menu = screen.getByRole("button", { name: "Menu" });
    expect(menu).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(menu);
    expect(menu).toHaveAttribute("aria-expanded", "true");
    const flowLinks = screen.getAllByRole("link", { name: "Voyage flow" });
    await userEvent.click(flowLinks[flowLinks.length - 1]);
    expect(menu).toHaveAttribute("aria-expanded", "false");
  });

  it("observes off-screen sections and removes reveal state on unmount", () => {
    const observe = vi.fn();
    const unobserve = vi.fn();
    const disconnect = vi.fn();
    class Observer {
      observe = observe;
      unobserve = unobserve;
      disconnect = disconnect;
    }
    Object.defineProperty(window, "IntersectionObserver", {
      configurable: true,
      value: Observer,
    });
    Object.defineProperty(globalThis, "IntersectionObserver", {
      configurable: true,
      value: Observer,
    });
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
      top: 10_000,
      bottom: 10_100,
      left: 0,
      right: 100,
      width: 100,
      height: 100,
      x: 0,
      y: 10_000,
      toJSON: () => ({}),
    });

    const view = render(<Landing />);
    expect(document.documentElement).toHaveClass("js-reveal");
    expect(observe).toHaveBeenCalled();

    view.unmount();
    expect(disconnect).toHaveBeenCalledOnce();
    expect(document.documentElement).not.toHaveClass("js-reveal");
  });
});
