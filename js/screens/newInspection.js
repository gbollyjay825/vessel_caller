/* ============================================================
   newInspection.js — New Inspection flow (spec §1.7.2).
   3 steps: link & type → cargo measurement (live reconciled tonnage)
   → review (live charge preview) → success screen with both PDFs.
   Resuming a draft (?draftId=) rehydrates the saved inspection and
   replaces it on submit instead of duplicating it.
   ============================================================ */
import { h } from "../dom.js";
import { icon } from "../icons.js";
import { api, reconcileLiquid, reconcileDry } from "../store.js";
import { money, naira, num, tons, pct } from "../format.js";
import { openPrintable } from "../pdf.js";
import {
  button,
  card,
  stepper,
  liveCalc,
  field,
  loadingBlock,
  emptyState,
  moneyFigure,
} from "../components/ui.js";
import { toastSuccess, toastError } from "../components/toast.js";

const STEPS = ["Link & type", "Cargo measurement", "Review & submit"];

export function renderNewInspection(ctx) {
  const { content, query } = ctx;
  ctx.setTitle("New Inspection");

  const model = {
    draftId: null,
    callId: query.callId || null,
    call: null,
    cargoCategory: null,
    cargoType: "",
    measurement: {},
    reconciledTonnage: 0,
    locked: !!query.callId,
  };
  let step = 0;
  let calls = [];

  content.replaceChildren(loadingBlock("Preparing inspection…"));

  async function prepare() {
    calls = await api.listVesselCalls();

    if (query.draftId) {
      // Resume: rehydrate the saved draft (spec §1.7.1 "Resume on drafts")
      const draft = await api.getInspection(query.draftId);
      if (draft && draft.status === "draft") {
        model.draftId = draft.id;
        model.callId = draft.callId;
        model.cargoCategory = draft.cargoCategory;
        model.cargoType = draft.cargoType || "";
        model.measurement = { ...(draft.measurement || {}) };
        model.reconciledTonnage = draft.reconciledTonnage || 0;
        model.locked = true;
      }
    }
    if (model.callId) {
      model.call = calls.find((c) => c.id === model.callId) || null;
      if (!model.call) {
        model.locked = false;
        model.callId = null;
      }
    }
    // A resumed draft lands back on the measurement step
    if (model.draftId && model.cargoCategory) step = 1;
    render();
  }

  prepare().catch((err) => {
    toastError("Couldn't start inspection", err.message);
    content.replaceChildren(
      emptyState({
        iconName: "alert-circle",
        title: "Couldn't start inspection",
        body: err.message,
        action: h("a.btn.btn--primary", { href: "#/inspections" }, "Back to Inspections"),
      })
    );
  });

  function render() {
    content.replaceChildren(
      h(
        "div",
        h(
          "div.page-head",
          h(
            "div.page-head__text",
            h("h1.h1", "New Inspection"),
            h("p.page-head__desc", "Reconcile cargo tonnage and generate the dues, commission and PDFs.")
          )
        ),
        stepper(STEPS, step),
        stepBody()
      )
    );
  }

  function stepBody() {
    if (step === 0) return step1();
    if (step === 1) return step2();
    return step3();
  }

  /* ============================================================
     Step 1 — Link & type
     ============================================================ */
  function step1() {
    const callError = h("div.field__error", { hidden: true }, icon("alert-circle", { size: 13 }), " Select a vessel call");
    const catError = h("div.field__error", { hidden: true }, icon("alert-circle", { size: 13 }), " Choose a cargo category");

    const commodity = field({
      label: "Cargo / commodity",
      placeholder: "e.g. Crude Oil, Iron Ore, Gasoil",
      value: model.cargoType,
      hint: "Optional — shown on reports and listings.",
      onInput: (e) => (model.cargoType = e.target.value),
    });

    const callBlock =
      model.locked && model.call
        ? h(
            "div.field",
            h("label.field__label", "Vessel call"),
            h(
              "div.linked-call",
              h("span.linked-call__icon", icon("ship", { size: 18 })),
              h(
                "div",
                h("div", { style: { fontWeight: 600 } }, model.call.vesselName),
                h("div.cell-sub", `${model.call.ref} · ${model.call.type}`)
              ),
              h("span.badge.badge--info", { style: { marginLeft: "auto" } }, "Linked")
            ),
            h("div.field__hint", model.draftId ? "Resumed from your saved draft." : "Pre-filled from the vessel call you opened.")
          )
        : comboField(callError);

    const next = button({
      label: "Continue",
      trailingIcon: "chevron-right",
      onClick: () => {
        let ok = true;
        if (!model.callId) {
          callError.hidden = false;
          ok = false;
        }
        if (!model.cargoCategory) {
          catError.hidden = false;
          ok = false;
        }
        if (!ok) return;
        step = 1;
        render();
      },
    });

    return h(
      "div",
      card(
        h(
          "div",
          callBlock,
          callError,
          commodity.el,
          h("div.field__label", { style: { marginTop: "8px" } }, "Cargo category", h("span.field__req", "*")),
          h("p.field__hint", { style: { marginTop: "0", marginBottom: "12px" } }, "This determines the measurement method in the next step."),
          categorySelector(catError)
        )
      ),
      h(
        "div.flow-nav",
        h("a.btn.btn--secondary", { href: "#/inspections" }, "Cancel"),
        h("div.flow-nav__right", next)
      )
    );
  }

  /* Searchable vessel-call combobox — fully keyboard operable (§1.11):
     ArrowDown/Up move through options, Enter/click selects, Escape closes,
     and the menu stays open while focus is anywhere inside the combo. */
  function comboField(callError) {
    const listboxId = "combo-vessel-calls";
    const input = h("input.input", {
      type: "search",
      placeholder: "Search vessel name or reference…",
      "aria-label": "Vessel call",
      autocomplete: "off",
      role: "combobox",
      "aria-expanded": "false",
      "aria-controls": listboxId,
      "aria-autocomplete": "list",
    });
    if (model.call) input.value = `${model.call.vesselName} · ${model.call.ref}`;

    const menu = h("div.combo-menu", { hidden: true, role: "listbox", id: listboxId });
    const combo = h("div.combo", input, menu);
    const wrap = h(
      "div.field",
      h("label.field__label", "Vessel call", h("span.field__req", "*")),
      combo,
      h("div.field__hint", "Inspections must be linked to a registered vessel call.")
    );

    let suppressOpenOnFocus = false;

    function setOpen(open) {
      menu.hidden = !open;
      input.setAttribute("aria-expanded", String(open));
    }

    function options() {
      return [...menu.querySelectorAll('[role="option"]')];
    }

    function select(c) {
      model.callId = c.id;
      model.call = c;
      input.value = `${c.vesselName} · ${c.ref}`;
      setOpen(false);
      callError.hidden = true;
      suppressOpenOnFocus = true; // refocusing must not reopen the menu
      input.focus();
    }

    function filter(q) {
      const ql = (q || "").toLowerCase();
      const items = calls.filter(
        (c) => c.vesselName.toLowerCase().includes(ql) || c.ref.toLowerCase().includes(ql)
      );
      if (!items.length) {
        menu.replaceChildren(h("div.combo-empty", "No matching vessel calls"));
        return;
      }
      menu.replaceChildren(
        ...items.slice(0, 8).map((c) => {
          const it = h(
            "button.menu-item",
            { type: "button", role: "option" },
            icon("ship", { size: 16 }),
            h(
              "div",
              h("div", { style: { fontWeight: 500 } }, c.vesselName),
              h("div.cell-sub", `${c.ref} · ${c.type} · ${c.flag}`)
            )
          );
          it.addEventListener("click", () => select(c));
          it.addEventListener("keydown", (e) => {
            const opts = options();
            const i = opts.indexOf(it);
            if (e.key === "ArrowDown") {
              e.preventDefault();
              (opts[i + 1] || opts[0]).focus();
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              if (i === 0) input.focus();
              else opts[i - 1].focus();
            } else if (e.key === "Escape") {
              e.preventDefault();
              setOpen(false);
              input.focus();
            }
          });
          return it;
        })
      );
    }

    input.addEventListener("focus", () => {
      if (suppressOpenOnFocus) {
        suppressOpenOnFocus = false;
        return;
      }
      filter(input.value);
      setOpen(true);
    });
    input.addEventListener("input", () => {
      model.callId = null;
      model.call = null;
      filter(input.value);
      setOpen(true);
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        if (menu.hidden) {
          filter(input.value);
          setOpen(true);
        }
        const first = options()[0];
        if (first) first.focus();
      } else if (e.key === "Escape") {
        setOpen(false);
      }
    });
    // Keep the menu open while focus stays inside the combo (input OR options)
    combo.addEventListener("focusout", (e) => {
      if (!combo.contains(e.relatedTarget)) setOpen(false);
    });

    return wrap;
  }

  function categorySelector(catError) {
    const opt = (val, title, desc, ic) => {
      const el = h(
        "button",
        { type: "button", class: "segmented__opt" + (model.cargoCategory === val ? " is-selected" : ""), "aria-pressed": String(model.cargoCategory === val) },
        h("span.segmented__icon", icon(ic, { size: 22 })),
        h("div", h("div.segmented__title", title), h("div.segmented__desc", desc))
      );
      el.addEventListener("click", () => {
        model.cargoCategory = val;
        catError.hidden = true;
        render();
      });
      return el;
    };
    return h(
      "div.segmented",
      opt("liquid", "Liquid cargo", "Ullage, volume, density & outturn reconciliation", "droplet"),
      opt("dry", "Dry / bulk cargo", "Draft survey displacement reconciliation", "box")
    );
  }

  /* ============================================================
     Step 2 — Cargo measurement (live reconciled tonnage)
     ============================================================ */
  function step2() {
    const calc = liveCalc({
      label: "Reconciled tonnage",
      value: fmtTonnage(model.reconciledTonnage),
      unit: "MTS",
      hint: "Computed preview · finalised by the NPA tariff engine on submit.",
    });

    function recompute() {
      model.reconciledTonnage =
        model.cargoCategory === "liquid"
          ? reconcileLiquid(model.measurement)
          : reconcileDry(model.measurement);
      calc.set(fmtTonnage(model.reconciledTonnage), undefined);
    }

    const m = model.measurement;
    const fieldRefs = []; // [{ f, key, required, label }]

    const numField = (key, label, opts = {}) => {
      const f = field({
        kind: "number",
        label,
        value: m[key] ?? "",
        inputmode: "decimal",
        step: "any",
        onInput: (e) => {
          model.measurement[key] = e.target.value;
          if (opts.required && e.target.value) f.clearError();
          recompute();
        },
        ...opts,
      });
      // Required fields validate on blur with inline errors (spec §1.11)
      if (opts.required) {
        f.input.addEventListener("blur", () => {
          if (!f.value) f.setError(`${label} is required`);
          else f.clearError();
        });
      }
      fieldRefs.push({ f, key, required: !!opts.required, label });
      return f;
    };

    const fields =
      model.cargoCategory === "liquid"
        ? [
            h(
              "div.field-row",
              numField("ullage", "Ullage / sounding (m)").el,
              numField("observedVolume", "Observed volume (m³)", { required: true }).el
            ),
            h(
              "div.field-row",
              numField("temperature", "Temperature (°C)").el,
              numField("density", "Density @15°C (t/m³)", { required: true, hint: "e.g. 0.852" }).el
            ),
            h(
              "div.field-row",
              numField("blQuantity", "Bill of Lading qty (MT)").el,
              numField("outturnQuantity", "Outturn quantity (MT)").el
            ),
          ]
        : [
            h(
              "div.field-row",
              numField("displacementBefore", "Displacement before (MT)", { required: true }).el,
              numField("displacementAfter", "Displacement after (MT)", { required: true }).el
            ),
            h(
              "div.field-row",
              numField("deductibles", "Deductibles (MT)", { hint: "Ballast, fuel, fresh water" }).el,
              numField("constant", "Ship's constant (MT)").el
            ),
          ];

    const left = card(
      h(
        "div",
        h(
          "div.row",
          { style: { gap: "10px", marginBottom: "16px" } },
          icon(model.cargoCategory === "liquid" ? "droplet" : "box", { size: 18, cls: "muted" }),
          h("h2.card__title", model.cargoCategory === "liquid" ? "Liquid cargo measurement" : "Draft survey measurement")
        ),
        ...fields
      )
    );

    const rail = h(
      "div.measure-rail",
      calc.el,
      card(
        h(
          "div",
          h("div.kv__key", "Inspection"),
          h("div", { style: { fontWeight: 600, marginTop: "2px" } }, model.call?.vesselName || "—"),
          h("div.cell-sub", `${model.call?.ref || ""} · ${model.cargoType || (model.cargoCategory === "liquid" ? "Liquid cargo" : "Dry / bulk cargo")}`)
        ),
        { pad: true, cls: "measure-rail__info" }
      )
    );

    const next = button({
      label: "Review",
      trailingIcon: "chevron-right",
      onClick: () => {
        // Required fields error inline beneath the field (spec §1.11)
        let firstError = null;
        for (const { f, required, label } of fieldRefs) {
          if (required && !f.value) {
            f.setError(`${label} is required`);
            if (!firstError) firstError = f;
          }
        }
        if (firstError) {
          firstError.focus();
          return;
        }
        if (!(model.reconciledTonnage > 0)) {
          toastError("Check the measurements", "Reconciled tonnage must be greater than zero to continue.");
          return;
        }
        step = 2;
        render();
      },
    });

    return h(
      "div",
      h("div.measure-layout", left, rail),
      h(
        "div.flow-nav",
        button({
          label: "Back",
          variant: "secondary",
          leadingIcon: "chevron-left",
          onClick: () => {
            step = 0;
            render();
          },
        }),
        h("div.flow-nav__right", next)
      )
    );
  }

  /* ============================================================
     Step 3 — Review & submit (live charge preview)
     ============================================================ */
  function step3() {
    const charges = api.calcPreview({ reconciledTonnage: model.reconciledTonnage });

    const summary = card(
      h(
        "div",
        h("h2.card__title", { style: { marginBottom: "8px" } }, "Inspection summary"),
        row("Vessel", model.call?.vesselName || "—"),
        row("Call reference", h("span.tnum", model.call?.ref || "—")),
        row("Cargo", h("div.row", { style: { gap: "8px", justifyContent: "flex-end" } },
          h("span.tag", icon(model.cargoCategory === "liquid" ? "droplet" : "box", { size: 14 }), model.cargoCategory === "liquid" ? "Liquid" : "Dry"),
          model.cargoType || (model.cargoCategory === "liquid" ? "Liquid cargo" : "Dry / bulk cargo"))),
        row("Reconciled tonnage", h("span.figure", tons(model.reconciledTonnage)))
      )
    );

    // Live charge preview: harbour dues + commission USD/₦ (spec §1.7.2)
    const preview = card(
      h(
        "div",
        h(
          "div.row",
          { style: { gap: "8px", marginBottom: "4px" } },
          icon("gauge", { size: 16, cls: "muted" }),
          h("h2.card__title", "Calculated charges (preview)")
        ),
        h("p.field__hint", { style: { marginTop: 0, marginBottom: "12px" } }, "Confirmed before submission. Final figures are issued by the server."),
        h(
          "div.breakdown__row",
          h("span.breakdown__key", h("strong", "NPA harbour dues")),
          h("span.money.money--lg", money(charges.harbourDues))
        ),
        h(
          "div.breakdown__row",
          h("span.breakdown__key", h("strong", `Agency commission (${pct(charges.commissionRate)})`)),
          h(
            "div",
            { style: { textAlign: "right" } },
            h("span.money.money--lg", money(charges.commissionUSD)),
            h("div.money__secondary", naira(charges.commissionNGN))
          )
        )
      )
    );

    // Primary Submit + secondary Save draft, each with its own inline
    // spinner so loading shows on the button that was clicked (§1.11).
    const submitIcon = h("span", { style: { display: "inline-flex" } }, icon("check", { size: 20 }));
    const submitBtn = h(
      "button.btn.btn--primary",
      { type: "button", onClick: () => submit("completed") },
      submitIcon,
      h("span", "Submit Inspection")
    );
    const draftIcon = h("span", { style: { display: "inline-flex" } }, icon("file", { size: 20 }));
    const draftBtn = h(
      "button.btn.btn--secondary",
      { type: "button", onClick: () => submit("draft") },
      draftIcon,
      h("span", "Save draft")
    );

    let busy = false;
    function setBusy(v, which) {
      busy = v;
      submitBtn.disabled = v;
      draftBtn.disabled = v;
      submitIcon.replaceChildren(
        v && which === "completed" ? h("span.spinner") : icon("check", { size: 20 })
      );
      draftIcon.replaceChildren(
        v && which === "draft" ? h("span.spinner") : icon("file", { size: 20 })
      );
    }

    async function submit(status) {
      if (busy) return;
      setBusy(true, status);
      try {
        const result = await api.createInspection({
          draftId: model.draftId,
          callId: model.callId,
          cargoCategory: model.cargoCategory,
          cargoType: model.cargoType,
          reconciledTonnage: model.reconciledTonnage,
          measurement: model.measurement,
          status,
        });
        if (status === "draft") {
          toastSuccess("Draft saved", `${result.ref} saved as a draft.`);
          // New row appears in the list with a brief highlight (§1.11)
          ctx.navigate(`/inspections?flash=${result.id}`);
        } else {
          successView(result);
        }
      } catch (err) {
        setBusy(false, status);
        toastError("Submission failed", err.message);
      }
    }

    return h(
      "div",
      h("div.two-col", summary, preview),
      h(
        "div.flow-nav",
        button({
          label: "Back",
          variant: "secondary",
          leadingIcon: "chevron-left",
          onClick: () => {
            step = 1;
            render();
          },
        }),
        h("div.flow-nav__right", draftBtn, submitBtn)
      )
    );

    function row(k, v) {
      return h("div.summary-row", h("span.summary-row__key", k), h("span.summary-row__val", v));
    }
  }

  /* ============================================================
     Success screen
     ============================================================ */
  function successView(result) {
    const c = result.charges;
    function openDoc(kind) {
      const w = window.open("", "_blank");
      if (!openPrintable(kind, api.buildDoc({ inspectionId: result.id }), w))
        toastError("Pop-up blocked", `Allow pop-ups to open the ${kind}.`);
    }

    content.replaceChildren(
      h(
        "div.success-screen",
        h("div.success-screen__check", icon("check", { size: 34 })),
        h("h1.success-screen__title", "Inspection submitted"),
        h("p.success-screen__sub", `${result.ref} for ${model.call?.vesselName || "the vessel"} is complete.`),
        card(
          h(
            "div.result-card",
            h("div.summary-row", h("span.summary-row__key", "Reconciled tonnage"), h("span.summary-row__val.figure", tons(result.reconciledTonnage))),
            h("div.summary-row", h("span.summary-row__key", "NPA harbour dues"), h("span.summary-row__val.money.money--lg", money(c.harbourDues))),
            h(
              "div.summary-row",
              h("span.summary-row__key", `Commission (${pct(c.commissionRate)})`),
              h("span.summary-row__val", moneyFigure(c.commissionUSD, { ngn: c.commissionNGN }))
            ),
            h(
              "div.result-card__pdf-actions",
              { style: { marginTop: "20px" } },
              button({ label: "View & download invoice", variant: "primary", leadingIcon: "download", onClick: () => openDoc("invoice") }),
              button({ label: "View & download inspection report", variant: "secondary", leadingIcon: "file", onClick: () => openDoc("report") })
            )
          )
        ),
        h(
          "div",
          { style: { textAlign: "center", marginTop: "24px" } },
          h("a.link-quiet", { href: "#/dashboard", style: { fontSize: "14px" } }, "Back to dashboard")
        )
      )
    );
  }

  function fmtTonnage(n) {
    return n > 0 ? num(n, 2) : "0.00";
  }
}
