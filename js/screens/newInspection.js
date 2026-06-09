/* ============================================================
   newInspection.js — New Inspection flow (spec §1.7.2).
   3 steps: link & type → cargo measurement (live reconciled tonnage)
   → review (live charge preview) → success screen with both PDFs.
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
  badge,
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

  api
    .listVesselCalls()
    .then((rows) => {
      calls = rows;
      if (model.callId) {
        model.call = rows.find((c) => c.id === model.callId) || null;
        if (!model.call) {
          model.locked = false;
          model.callId = null;
        }
      }
      render();
    })
    .catch((err) =>
      content.replaceChildren(
        emptyState({
          iconName: "alert-circle",
          title: "Couldn't start inspection",
          body: err.message,
          action: h("a.btn.btn--primary", { href: "#/inspections" }, "Back to Inspections"),
        })
      )
    );

  function render() {
    content.replaceChildren(
      h(
        "div",
        h(
          "a.btn.btn--ghost.btn--sm",
          { href: "#/inspections", style: { marginBottom: "16px", paddingLeft: "6px" } },
          icon("arrow-left", { size: 16 }),
          "Inspections"
        ),
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
      required: true,
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
              h("span.badge.badge--info", { style: { marginLeft: "auto" } }, h("span.badge__dot"), "Linked")
            ),
            h("div.field__hint", "Pre-filled from the vessel call you opened.")
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
        if (!model.cargoType.trim()) {
          commodity.setError("Enter the commodity");
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

  function comboField(callError) {
    const input = h("input.input", {
      type: "search",
      placeholder: "Search vessel name or reference…",
      "aria-label": "Vessel call",
      autocomplete: "off",
    });
    if (model.call) input.value = `${model.call.vesselName} · ${model.call.ref}`;

    const menu = h("div.combo-menu", { hidden: true, role: "listbox" });
    const wrap = h(
      "div.field",
      h("label.field__label", "Vessel call", h("span.field__req", "*")),
      h("div.combo", input, menu),
      h("div.field__hint", "Inspections must be linked to a registered vessel call.")
    );

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
          it.addEventListener("mousedown", (e) => {
            e.preventDefault();
            model.callId = c.id;
            model.call = c;
            input.value = `${c.vesselName} · ${c.ref}`;
            menu.hidden = true;
            callError.hidden = true;
          });
          return it;
        })
      );
    }

    input.addEventListener("focus", () => {
      filter(input.value);
      menu.hidden = false;
    });
    input.addEventListener("input", () => {
      model.callId = null;
      model.call = null;
      filter(input.value);
      menu.hidden = false;
    });
    input.addEventListener("blur", () => setTimeout(() => (menu.hidden = true), 150));

    return wrap;
  }

  function categorySelector(catError) {
    const opt = (val, title, desc, ic) => {
      const el = h(
        "button",
        { type: "button", class: "segmented__opt" + (model.cargoCategory === val ? " is-selected" : "") },
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
      unit: "MT",
      hint: "Computed preview · finalised by the NPA tariff engine on submit.",
    });

    function recompute() {
      model.reconciledTonnage =
        model.cargoCategory === "liquid"
          ? reconcileLiquid(model.measurement)
          : reconcileDry(model.measurement);
      calc.set(fmtTonnage(model.reconciledTonnage), undefined);
    }

    const bind = (key) => (e) => {
      model.measurement[key] = e.target.value;
      recompute();
    };

    const m = model.measurement;
    const numField = (key, label, opts = {}) =>
      field({
        kind: "number",
        label,
        value: m[key] ?? "",
        inputmode: "decimal",
        step: "any",
        onInput: bind(key),
        ...opts,
      });

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
          h("div.cell-sub", `${model.call?.ref || ""} · ${model.cargoType || "—"}`)
        ),
        { pad: true }
      )
    );

    const next = button({
      label: "Review",
      trailingIcon: "chevron-right",
      onClick: () => {
        if (!(model.reconciledTonnage > 0)) {
          toastError("Enter measurements", "Reconciled tonnage must be greater than zero to continue.");
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
          model.cargoType)),
        row("Reconciled tonnage", h("span.tnum", tons(model.reconciledTonnage)))
      )
    );

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
        ),
        h(
          "div.breakdown__row.breakdown__row--total",
          h("span.breakdown__key", h("strong", "Total due")),
          h("span.money.money--lg", money(charges.harbourDues + charges.commissionUSD))
        )
      )
    );

    // submit + save draft buttons (manual to manage loading)
    const submitIcon = h("span", { style: { display: "inline-flex" } }, icon("check", { size: 16 }));
    const submitBtn = h(
      "button.btn.btn--primary",
      { type: "button", onClick: () => submit("completed") },
      submitIcon,
      h("span", "Submit Inspection")
    );
    const draftBtn = button({ label: "Save draft", variant: "secondary", onClick: () => submit("draft") });

    let busy = false;
    function setBusy(v) {
      busy = v;
      submitBtn.disabled = v;
      draftBtn.disabled = v;
      submitIcon.replaceChildren(v ? h("span.spinner") : icon("check", { size: 16 }));
    }

    async function submit(status) {
      if (busy) return;
      setBusy(true);
      try {
        const result = await api.createInspection({
          callId: model.callId,
          cargoCategory: model.cargoCategory,
          cargoType: model.cargoType,
          reconciledTonnage: model.reconciledTonnage,
          measurement: model.measurement,
          status,
        });
        if (status === "draft") {
          toastSuccess("Draft saved", `${result.ref} saved as a draft.`);
          ctx.navigate("/inspections");
        } else {
          successView(result);
        }
      } catch (err) {
        setBusy(false);
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
            h("div.summary-row", h("span.summary-row__key", "Reconciled tonnage"), h("span.summary-row__val.tnum", tons(result.reconciledTonnage))),
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
