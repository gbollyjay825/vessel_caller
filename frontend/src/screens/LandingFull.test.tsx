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

    expect(screen.getByRole("heading", { name: /Every vessel call/i })).toBeInTheDocument();
    expect(screen.getByText(/Interrupted submissions remain on the device/i)).toBeInTheDocument();
    expect(screen.getByText(/Organization data is private/i)).toBeInTheDocument();
    expect(screen.queryByText(/demo credentials/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/live AIS/i)).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Internal admin sign in/i })).toHaveAttribute("href", "/login");

    const menu = screen.getByRole("button", { name: "Menu" });
    expect(menu).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(menu);
    expect(menu).toHaveAttribute("aria-expanded", "true");
    const platformLinks = screen.getAllByRole("link", { name: "Platform" });
    await userEvent.click(platformLinks[platformLinks.length - 1]);
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
