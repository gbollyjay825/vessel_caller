/* ============================================================
   ui.js — small reusable builders (spec §1.10).
   ============================================================ */
import { h } from "../dom.js";
import { icon } from "../icons.js";
import { money, naira, statusLabel } from "../format.js";
import { openPrintable } from "../pdf.js";
import { toastError } from "./toast.js";

let seq = 0;
const nextId = () => `f${++seq}`;

/* ---------------- Buttons ---------------- */

export function button(opts = {}) {
  const {
    label,
    variant = "primary",
    size,
    leadingIcon,
    trailingIcon,
    onClick,
    href,
    type = "button",
    disabled = false,
    block = false,
    loading = false,
    ariaLabel,
    title,
  } = opts;

  const cls = [
    "btn",
    `btn--${variant}`,
    size ? `btn--${size}` : "",
    block ? "btn--block" : "",
  ]
    .filter(Boolean)
    .join(" ");

  const kids = [
    loading
      ? h("span.spinner")
      : leadingIcon
      ? icon(leadingIcon, { size: 20 }) // button leading icons are 20px (spec §1.3)
      : null,
    label ? h("span", label) : null,
    trailingIcon ? icon(trailingIcon, { size: 16 }) : null,
  ];

  const props = {
    class: cls,
    onClick,
    ...(ariaLabel ? { "aria-label": ariaLabel } : {}),
    ...(title ? { title } : {}),
  };

  if (href) return h("a", { ...props, href }, kids);
  return h("button", { ...props, type, disabled: disabled || loading }, kids);
}

export function iconButton({ iconName, ariaLabel, onClick, dot = false, title }) {
  return h(
    "button.icon-btn",
    {
      type: "button",
      "aria-label": ariaLabel,
      title: title || ariaLabel,
      onClick,
    },
    icon(iconName, { size: 20 }),
    dot ? h("span.icon-btn__dot") : null
  );
}

/**
 * PDF action button (spec §1.10). Compact, leading document icon,
 * label "Invoice" or "Report". Disabled + tooltip when no PDF exists.
 * Shows a spinner on the icon while the link resolves, then opens in
 * a new tab. `resolve` returns the document model lazily at click time.
 */
export function pdfButton({ kind, available = true, resolve }) {
  const label = kind === "invoice" ? "Invoice" : "Report";

  if (!available || typeof resolve !== "function") {
    return h(
      "button.btn.btn--pdf",
      {
        type: "button",
        disabled: true,
        title: "Not yet generated",
        "aria-label": `${label} — not yet generated`,
      },
      icon("file", { size: 20 }),
      label
    );
  }

  const iconSlot = h("span", { style: { display: "inline-flex" } }, icon("file", { size: 20 }));
  const btn = h(
    "button.btn.btn--pdf",
    { type: "button", "aria-label": `Open ${label} PDF in a new tab` },
    iconSlot,
    label
  );

  btn.addEventListener("click", (e) => {
    e.stopPropagation(); // never trigger an underlying row click
    if (btn.disabled) return;
    // Open the tab synchronously inside the gesture (pop-up safe),
    // then write once the "link resolves".
    const win = window.open("", "_blank");
    btn.disabled = true; // async work: spinner AND disable (spec §1.11)
    iconSlot.replaceChildren(h("span.spinner", { style: { color: "var(--accent)" } }));
    btn.setAttribute("aria-busy", "true");
    setTimeout(() => {
      const ok = openPrintable(kind, resolve(), win);
      iconSlot.replaceChildren(icon("file", { size: 20 }));
      btn.removeAttribute("aria-busy");
      btn.disabled = false;
      if (!ok)
        toastError("Pop-up blocked", `Allow pop-ups to open the ${label} PDF.`);
    }, 280);
  });

  return btn;
}

/** The two PDF buttons that recur across screens (spec §1.5/1.8). */
export function pdfActions({ available = true, resolveInvoice, resolveReport }) {
  return h(
    "span.cell-actions",
    pdfButton({ kind: "invoice", available, resolve: resolveInvoice }),
    pdfButton({ kind: "report", available, resolve: resolveReport })
  );
}

/* ---------------- Status & tags ---------------- */

export function badge(status, labelOverride) {
  // Leading dot per the approved dashboard design (status is still
  // conveyed by the text label, satisfying §1.11).
  return h(
    `span.badge.badge--${status}`,
    { role: "status" },
    h("span.badge__dot"),
    labelOverride || statusLabel(status)
  );
}

export function cargoTag(category) {
  const liquid = category === "liquid";
  return h(
    "span.tag",
    icon(liquid ? "droplet" : "box", { size: 14 }),
    liquid ? "Liquid" : "Dry"
  );
}

/* ---------------- Money figure ---------------- */

export function moneyFigure(usd, { ngn = null, size = "", inline = false } = {}) {
  const cls = ["money", size ? `money--${size}` : "", inline ? "money--inline" : ""]
    .filter(Boolean)
    .join(" ");
  return h(
    "span",
    { class: cls },
    money(usd),
    ngn != null ? h("span.money__secondary", naira(ngn)) : null
  );
}

/* ---------------- Stat card ---------------- */

export function statCard({ label, value, valueNode, delta, deltaDir = "up", foot }) {
  return h(
    "div.stat-card",
    h("div.stat-card__label", label),
    h("div.stat-card__value", valueNode || value),
    delta || foot
      ? h(
          "div.stat-card__foot",
          delta
            ? h(
                `span.delta.delta--${deltaDir}`,
                icon(deltaDir === "down" ? "arrow-down" : "arrow-up", { size: 13 }),
                delta
              )
            : null,
          foot ? h("span", foot) : null
        )
      : null
  );
}

/* ---------------- Cards / layout ---------------- */

export function card(children, { pad = true, cls = "" } = {}) {
  return h("div", { class: `card${pad ? " card--pad" : ""}${cls ? " " + cls : ""}` }, children);
}

export function pageHead({ title, desc, actions }) {
  return h(
    "div.page-head",
    h(
      "div.page-head__text",
      h("h1.h1", title),
      desc ? h("p.page-head__desc", desc) : null
    ),
    actions ? h("div.page-head__actions", actions) : null
  );
}

export function sectionHead(title, ...actions) {
  return h("div.section__head", h("h2.h2", title), ...actions);
}

export function kvGrid(pairs) {
  return h(
    "div.kv-grid",
    pairs.map(([k, v]) => h("div", h("div.kv__key", k), h("div.kv__val", v)))
  );
}

export function emptyState({ iconName = "ship", title, body, action }) {
  return h(
    "div.empty",
    h("div.empty__icon", icon(iconName, { size: 20 })),
    h("div.empty__title", title),
    body ? h("p.empty__body", body) : null,
    action || null
  );
}

export function loadingBlock(label = "Loading…") {
  return h(
    "div.empty",
    h("span.spinner", { style: { width: "22px", height: "22px", color: "var(--accent)" } }),
    h("p.muted", { style: { marginTop: "12px" } }, label)
  );
}

/* ---------------- Stepper ---------------- */

export function stepper(steps, current) {
  const kids = [];
  steps.forEach((label, i) => {
    const state = i < current ? "is-done" : i === current ? "is-current" : "";
    kids.push(
      h(
        "div",
        { class: `step${state ? " " + state : ""}`, role: "listitem" },
        h("div.step__num", i < current ? icon("check", { size: 16 }) : String(i + 1)),
        h("div.step__label", label)
      )
    );
    if (i < steps.length - 1)
      kids.push(h("div", { class: `step__line${i < current ? " is-done" : ""}` }));
  });
  return h("div.stepper", { role: "list", "aria-label": "Progress" }, kids);
}

/* ---------------- Live calc display ---------------- */

export function liveCalc({ label, value = "—", unit, hint }) {
  const valueEl = h("div.live-calc__value");
  const hintEl = hint ? h("div.live-calc__hint", hint) : null;

  const render = (v) => {
    const kids = [document.createTextNode(v)];
    if (unit) kids.push(h("span.live-calc__unit", unit));
    valueEl.replaceChildren(...kids);
  };
  render(value);

  const el = h(
    "div.live-calc",
    { role: "status", "aria-live": "polite" },
    h("div.live-calc__label", icon("gauge", { size: 14 }), label),
    valueEl,
    hintEl
  );

  return {
    el,
    set(v, newHint) {
      render(v);
      if (newHint != null && hintEl) hintEl.textContent = newHint;
    },
  };
}

/* ---------------- Field factory ---------------- */

/**
 * field(opts) -> { el, input, value (get/set), focus, setError, clearError, setStatus }
 * kind: text | number | datetime-local | email | password | tel | select | textarea
 */
export function field(opts = {}) {
  const {
    kind = "text",
    id,
    label,
    value = "",
    placeholder = "",
    required = false,
    hint,
    options = [],
    rows = 3,
    min,
    max,
    step,
    inputmode,
    autofocus = false,
    disabled = false,
    onInput,
    onChange,
    onBlur,
  } = opts;

  const fid = id || nextId();
  let control;

  if (kind === "select") {
    control = h(
      "select.select",
      { id: fid, disabled },
      options.map((o) => {
        const v = typeof o === "string" ? o : o.value;
        const l = typeof o === "string" ? o : o.label;
        return h("option", { value: v, selected: String(v) === String(value) }, l);
      })
    );
  } else if (kind === "textarea") {
    control = h("textarea.input", { id: fid, placeholder, rows, disabled });
    control.value = value;
  } else {
    control = h("input.input", {
      id: fid,
      type: kind,
      placeholder,
      value,
      disabled,
      ...(min != null ? { min } : {}),
      ...(max != null ? { max } : {}),
      ...(step != null ? { step } : {}),
      ...(inputmode ? { inputmode } : {}),
    });
  }

  if (autofocus) control.setAttribute("autofocus", "");
  if (required) control.setAttribute("aria-required", "true");
  if (onInput) control.addEventListener("input", onInput);
  if (onChange) control.addEventListener("change", onChange);
  if (onBlur) control.addEventListener("blur", onBlur);

  const errorSlot = h("div.field__error", { hidden: true, id: `${fid}-err` });
  const statusSlot = h("div.field__status", { hidden: true });

  const wrap = h(
    "div.field",
    label
      ? h(
          "label.field__label",
          { for: fid },
          label,
          required ? h("span.field__req", "*") : null
        )
      : null,
    control,
    hint ? h("div.field__hint", hint) : null,
    statusSlot,
    errorSlot
  );

  const apiObj = {
    el: wrap,
    input: control,
    get value() {
      return (control.value || "").trim();
    },
    set value(v) {
      control.value = v;
    },
    focus() {
      control.focus();
    },
    setError(msg) {
      if (msg) {
        wrap.classList.add("has-error");
        errorSlot.replaceChildren(
          icon("alert-circle", { size: 13 }),
          document.createTextNode(" " + msg)
        );
        errorSlot.hidden = false;
        control.setAttribute("aria-invalid", "true");
        control.setAttribute("aria-describedby", `${fid}-err`);
      } else {
        wrap.classList.remove("has-error");
        errorSlot.hidden = true;
        control.removeAttribute("aria-invalid");
      }
    },
    clearError() {
      apiObj.setError(null);
    },
    setStatus(state, msg = "") {
      statusSlot.className =
        "field__status" + (state ? ` field__status--${state}` : "");
      if (!state) {
        statusSlot.hidden = true;
        statusSlot.replaceChildren();
        return;
      }
      const ind =
        state === "checking"
          ? h("span.spinner", { style: { width: "12px", height: "12px" } })
          : state === "ok"
          ? icon("check", { size: 13 })
          : icon("alert-circle", { size: 13 });
      statusSlot.replaceChildren(ind, document.createTextNode(" " + msg));
      statusSlot.hidden = false;
    },
  };

  return apiObj;
}
