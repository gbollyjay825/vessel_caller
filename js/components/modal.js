/* ============================================================
   modal.js — modal & slide-over panels (spec §1.10).
   Dismiss on escape + backdrop click (with unsaved-changes guard),
   focus trap, returns focus to the trigger on close.
   Plus confirmDialog() for destructive confirmations (spec §1.11).
   ============================================================ */
import { h } from "../dom.js";
import { icon } from "../icons.js";

const modalRoot = () => document.getElementById("modal-root");

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function trapFocus(container, e) {
  const items = [...container.querySelectorAll(FOCUSABLE)].filter(
    (el) => el.offsetParent !== null || el === document.activeElement
  );
  if (!items.length) return;
  const first = items[0];
  const last = items[items.length - 1];
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}

/**
 * openPanel(opts) -> controller { close(), el, setDirty(bool) }
 *  kind: 'modal' | 'slideover'
 *  title, subtitle
 *  body / footer: Node | (ctl) => Node
 *  isDirty: () => boolean   (guards backdrop/escape close)
 *  onClose: () => void
 */
export function openPanel(opts = {}) {
  const {
    kind = "modal",
    wide = false,
    title,
    subtitle,
    body,
    footer,
    isDirty,
    onClose,
    closeOnBackdrop = true,
  } = opts;

  const prevFocus = document.activeElement;
  let dirtyFlag = false;

  const overlay = h(
    "div.overlay." + (kind === "slideover" ? "overlay--right" : "overlay--center")
  );
  const panelClass =
    (kind === "slideover" ? "div.slideover" : "div.modal") +
    (wide ? (kind === "slideover" ? ".slideover--wide" : ".modal--wide") : "");

  const panel = h(panelClass, {
    role: "dialog",
    "aria-modal": "true",
    "aria-label": title || "Dialog",
  });

  const ctl = {
    el: panel,
    close,
    requestClose,
    setDirty(v) {
      dirtyFlag = !!v;
    },
  };

  const closeBtn = h(
    "button.icon-btn",
    { type: "button", "aria-label": "Close", onClick: requestClose },
    icon("x", { size: 18 })
  );

  const head = h(
    "div.panel__head",
    h(
      "div.panel__title",
      h("h2.h2", title || ""),
      subtitle ? h("div.panel__subtitle", subtitle) : null
    ),
    closeBtn
  );

  const bodyNode = typeof body === "function" ? body(ctl) : body;
  const bodyEl = h("div.panel__body", bodyNode);

  panel.append(head, bodyEl);

  if (footer) {
    const footNode = typeof footer === "function" ? footer(ctl) : footer;
    panel.append(footNode);
  }
  overlay.append(panel);

  function isDirtyNow() {
    return dirtyFlag || (typeof isDirty === "function" && isDirty());
  }

  function requestClose() {
    if (isDirtyNow()) {
      confirmDialog({
        title: "Discard unsaved changes?",
        message: "Any information you entered will be lost.",
        confirmLabel: "Discard",
        danger: true,
      }).then((ok) => ok && close());
    } else {
      close();
    }
  }

  function close() {
    document.removeEventListener("keydown", onKey, true);
    overlay.classList.add("is-leaving");
    overlay.style.animation = "fade-in 120ms reverse forwards";
    setTimeout(() => overlay.remove(), 120);
    if (prevFocus && typeof prevFocus.focus === "function") prevFocus.focus();
    onClose && onClose();
  }

  function onKey(e) {
    if (e.key === "Escape") {
      e.preventDefault();
      requestClose();
    } else if (e.key === "Tab") {
      trapFocus(panel, e);
    }
  }

  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay && closeOnBackdrop) requestClose();
  });

  document.addEventListener("keydown", onKey, true);
  modalRoot().appendChild(overlay);

  // Focus the first sensible control
  requestAnimationFrame(() => {
    const target =
      panel.querySelector("[autofocus]") ||
      panel.querySelector(FOCUSABLE) ||
      panel;
    target.focus();
  });

  return ctl;
}

/**
 * confirmDialog(opts) -> Promise<boolean>
 */
export function confirmDialog(opts = {}) {
  const {
    title = "Are you sure?",
    message = "",
    confirmLabel = "Confirm",
    cancelLabel = "Cancel",
    danger = false,
  } = opts;

  return new Promise((resolve) => {
    const prevFocus = document.activeElement;
    const overlay = h("div.overlay.overlay--center", {
      style: { zIndex: "80" },
    });
    const modal = h("div.modal", {
      role: "alertdialog",
      "aria-modal": "true",
      "aria-label": title,
      style: { maxWidth: "440px" },
    });

    const confirmBtn = h(
      "button.btn." + (danger ? "btn--danger" : "btn--primary"),
      { type: "button", onClick: () => done(true) },
      confirmLabel
    );

    modal.append(
      h(
        "div.panel__body",
        h(
          "div.row",
          { style: { alignItems: "flex-start", gap: "16px" } },
          danger
            ? h("div.confirm__icon", icon("alert-triangle", { size: 22 }))
            : null,
          h(
            "div",
            h("h2.h2", { style: { marginBottom: "6px" } }, title),
            message ? h("p.muted", message) : null
          )
        )
      ),
      h(
        "div.panel__foot",
        h(
          "button.btn.btn--secondary",
          { type: "button", onClick: () => done(false) },
          cancelLabel
        ),
        confirmBtn
      )
    );
    overlay.append(modal);

    function done(val) {
      document.removeEventListener("keydown", onKey, true);
      overlay.remove();
      if (prevFocus && typeof prevFocus.focus === "function") prevFocus.focus();
      resolve(val);
    }
    function onKey(e) {
      if (e.key === "Escape") {
        e.preventDefault();
        done(false);
      } else if (e.key === "Tab") {
        trapFocus(modal, e);
      }
    }

    overlay.addEventListener("mousedown", (e) => {
      if (e.target === overlay) done(false);
    });
    document.addEventListener("keydown", onKey, true);
    modalRoot().appendChild(overlay);
    requestAnimationFrame(() => confirmBtn.focus());
  });
}
