/* ============================================================
   toast.js — top-right toasts, success/error/info, auto-dismiss
   4s, manual close (spec §1.10).
   ============================================================ */
import { h } from "../dom.js";
import { icon } from "../icons.js";

const root = () => document.getElementById("toast-root");

export function toast({ title, message = "", variant = "info", duration = 4000 }) {
  const iconName =
    variant === "success"
      ? "check-circle"
      : variant === "error"
      ? "alert-circle"
      : "info";

  let timer;
  const el = h(
    `div.toast.toast--${variant}`,
    { role: variant === "error" ? "alert" : "status" },
    h("div.toast__icon", icon(iconName, { size: 18 })),
    h(
      "div.toast__body",
      h("div.toast__title", title),
      message ? h("div.toast__msg", message) : null
    ),
    h(
      "button.toast__close",
      { type: "button", "aria-label": "Dismiss notification", onClick: dismiss },
      icon("x", { size: 16 })
    )
  );

  function dismiss() {
    clearTimeout(timer);
    el.classList.add("is-leaving");
    el.addEventListener("animationend", () => el.remove(), { once: true });
    // Safety net if animationend doesn't fire
    setTimeout(() => el.remove(), 400);
  }

  // Pause auto-dismiss on hover
  el.addEventListener("mouseenter", () => clearTimeout(timer));
  el.addEventListener("mouseleave", () => {
    timer = setTimeout(dismiss, 1500);
  });

  root().appendChild(el);
  if (duration) timer = setTimeout(dismiss, duration);
  return { dismiss };
}

export const toastSuccess = (title, message) =>
  toast({ title, message, variant: "success" });
export const toastError = (title, message) =>
  toast({ title, message, variant: "error", duration: 6000 });
export const toastInfo = (title, message) =>
  toast({ title, message, variant: "info" });
