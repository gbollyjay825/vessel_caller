/* ============================================================
   settings.js — Settings (spec §1.9).
   Tabbed: charge configuration · notifications · port profile.
   Sticky save bar, unsaved-changes guard on navigation.
   The fields render here; population/validation is backend-driven.
   ============================================================ */
import { h } from "../dom.js";
import { icon } from "../icons.js";
import { api } from "../store.js";
import { num, pct } from "../format.js";
import { field, button, card, badge, loadingBlock, emptyState } from "../components/ui.js";
import { toastSuccess, toastError } from "../components/toast.js";

const TABS = [
  ["charge", "Charge configuration"],
  ["notifications", "Notifications"],
  ["port", "Port profile"],
];

export function renderSettings(ctx) {
  const { content } = ctx;
  let settings = null;
  let working = null;
  let dirty = false;
  let activeTab = "charge";

  // One-time browser-level unsaved guard, driven by window.__navGuard
  if (!window.__beforeUnloadBound) {
    window.__beforeUnloadBound = true;
    window.addEventListener("beforeunload", (e) => {
      if (typeof window.__navGuard === "function" && window.__navGuard()) {
        e.preventDefault();
        e.returnValue = "";
      }
    });
  }

  let saveBar; // recreated each render

  function setDirty(v) {
    dirty = v;
    window.__navGuard = v ? () => dirty : null;
    if (saveBar) saveBar.hidden = !v;
  }

  function markDirty() {
    if (!dirty) setDirty(true);
  }

  function render() {
    const tabBar = h(
      "div.tabs",
      { role: "tablist" },
      TABS.map(([k, label]) => {
        const b = h(
          "button",
          { type: "button", class: "tab" + (k === activeTab ? " is-active" : ""), role: "tab", "aria-selected": String(k === activeTab) },
          label
        );
        b.addEventListener("click", () => {
          activeTab = k;
          render();
        });
        return b;
      })
    );

    saveBar = buildSaveBar();
    saveBar.hidden = !dirty;

    content.replaceChildren(
      h(
        "div",
        h(
          "div.page-head",
          h(
            "div.page-head__text",
            h("h1.h1", "Settings"),
            h("p.page-head__desc", "Charge rates, notification channels and port profile.")
          )
        ),
        tabBar,
        sectionFor(activeTab),
        saveBar
      )
    );
  }

  /* ---- Charge configuration ---- */
  function chargeSection() {
    const c = working.charge;
    const commission = field({
      kind: "number",
      label: "Commission rate (%)",
      value: c.commissionRate,
      step: "0.1",
      min: 0,
      inputmode: "decimal",
      onInput: (e) => {
        c.commissionRate = Number(e.target.value);
        markDirty();
      },
    });
    const fx = field({
      kind: "number",
      label: "USD → ₦ exchange rate",
      value: c.exchangeRate,
      step: "1",
      min: 0,
      inputmode: "decimal",
      hint: "Naira per 1 USD",
      onInput: (e) => {
        c.exchangeRate = Number(e.target.value);
        markDirty();
      },
    });
    const duesRate = field({
      kind: "number",
      label: "NPA dues rate (USD / MT)",
      value: c.duesRatePerTon,
      step: "0.01",
      min: 0,
      inputmode: "decimal",
      onInput: (e) => {
        c.duesRatePerTon = Number(e.target.value);
        markDirty();
      },
    });
    const basis = field({
      kind: "select",
      label: "NPA dues rate basis",
      value: c.duesBasis,
      options: [
        "Reconciled cargo tonnage (per MT)",
        "Net registered tonnage (per NRT)",
        "Gross registered tonnage (per GRT)",
      ],
      onChange: (e) => {
        c.duesBasis = e.target.value;
        markDirty();
      },
    });

    return card(
      h(
        "div",
        h("h2.card__title", { style: { marginBottom: "4px" } }, "Charge configuration"),
        h(
          "p.muted",
          { style: { marginBottom: "20px", fontSize: "13px" } },
          "Used to compute harbour dues and agency commission."
        ),
        h("div.field-row", commission.el, fx.el),
        h("div.field-row", duesRate.el, basis.el),
        h(
          "div.row",
          { style: { gap: "10px", marginTop: "8px", padding: "12px 14px", background: "var(--warning-bg)", borderRadius: "8px" } },
          icon("info", { size: 18, cls: "muted" }),
          h("span", { style: { fontSize: "13px", color: "var(--warning)" } }, "Changes affect future calculations only — existing invoices are not recalculated.")
        )
      )
    );
  }

  /* ---- Notifications ---- */
  function notificationsSection() {
    const n = working.notifications;

    const smtp = n.smtp;
    const smtpFields = [
      ["host", "SMTP host", "text"],
      ["port", "SMTP port", "text"],
      ["user", "SMTP username", "text"],
      ["from", "From address", "text"],
    ].map(([key, label, kind]) =>
      field({
        kind,
        label,
        value: smtp[key] ?? "",
        onInput: (e) => {
          smtp[key] = e.target.value;
          markDirty();
        },
      })
    );

    const sms = n.sms;
    const smsFields = [
      ["accountSid", "Twilio Account SID"],
      ["fromNumber", "From number"],
    ].map(([key, label]) =>
      field({
        label,
        value: sms[key] ?? "",
        onInput: (e) => {
          sms[key] = e.target.value;
          markDirty();
        },
      })
    );

    function testEmail(done) {
      if (!smtp.connected) {
        toastError("Email not connected", "Save valid SMTP credentials first.");
        return done();
      }
      setTimeout(() => {
        toastSuccess("Test email sent", `Delivered via ${smtp.host}.`);
        done();
      }, 700);
    }
    function testSms(done) {
      if (!sms.connected) {
        toastError("SMS not connected", "Add Twilio credentials and save to connect.");
        return done();
      }
      setTimeout(() => {
        toastSuccess("Test SMS sent", `Sent from ${sms.fromNumber}.`);
        done();
      }, 700);
    }

    const emailCard = card(
      h(
        "div",
        connHeader("mail", "Email (SMTP)", smtp.connected, testEmail),
        h("div.divider"),
        h("div.field-row", smtpFields[0].el, smtpFields[1].el),
        smtpFields[2].el,
        smtpFields[3].el
      )
    );

    const smsCard = card(
      h(
        "div",
        connHeader("message", "SMS (Twilio)", sms.connected, testSms),
        h("div.divider"),
        smsFields[0].el,
        smsFields[1].el
      )
    );

    return h("div.stack.stack-gap-4", emailCard, smsCard);
  }

  function connHeader(ic, label, connected, onTest) {
    // Send test triggers async work: inline spinner + disable (§1.11)
    const sendIcon = h("span", { style: { display: "inline-flex" } }, icon("send", { size: 20 }));
    const sendBtn = h(
      "button.btn.btn--secondary.btn--sm",
      { type: "button" },
      sendIcon,
      h("span", "Send test")
    );
    sendBtn.addEventListener("click", () => {
      sendBtn.disabled = true;
      sendIcon.replaceChildren(h("span.spinner"));
      onTest(() => {
        sendBtn.disabled = false;
        sendIcon.replaceChildren(icon("send", { size: 20 }));
      });
    });

    return h(
      "div.row",
      { style: { gap: "12px" } },
      h("span.segmented__icon", { style: { width: "36px", height: "36px" } }, icon(ic, { size: 18 })),
      h("div.conn-row__label", h("div", { style: { fontWeight: 600 } }, label), h("div.cell-sub", connected ? "Channel is configured" : "Not yet configured")),
      badge(connected ? "connected" : "not-connected", connected ? "Connected" : "Not connected"),
      sendBtn
    );
  }

  /* ---- Port profile ---- */
  function portSection() {
    const p = working.port;
    const portName = field({
      label: "Port name",
      value: p.name,
      onInput: (e) => {
        p.name = e.target.value;
        markDirty();
      },
    });

    const chipList = h("div.chip-list");
    function renderChips() {
      const chips = p.terminals.map((tname, i) =>
        h(
          "span.chip",
          tname,
          h(
            "button",
            {
              type: "button",
              "aria-label": `Remove ${tname}`,
              onClick: () => {
                p.terminals.splice(i, 1);
                markDirty();
                renderChips();
              },
            },
            icon("x", { size: 13 })
          )
        )
      );
      if (!p.terminals.length)
        chips.push(h("span.muted", { style: { fontSize: "13px" } }, "No terminals yet."));
      chipList.replaceChildren(...chips);
    }
    renderChips();

    const addInput = h("input.input", { placeholder: "Add a terminal…", "aria-label": "New terminal name" });
    function addTerminal() {
      const v = addInput.value.trim();
      if (!v) return;
      p.terminals.push(v);
      addInput.value = "";
      markDirty();
      renderChips();
      addInput.focus();
    }
    addInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        addTerminal();
      }
    });

    return card(
      h(
        "div",
        h("h2.card__title", { style: { marginBottom: "16px" } }, "Port profile"),
        portName.el,
        h("label.field__label", { style: { marginTop: "8px" } }, "Default terminals"),
        chipList,
        h(
          "div.row",
          { style: { gap: "8px", marginTop: "12px", maxWidth: "420px" } },
          addInput,
          button({ label: "Add", variant: "secondary", leadingIcon: "plus", onClick: addTerminal })
        )
      )
    );
  }

  function sectionFor(tab) {
    if (tab === "charge") return chargeSection();
    if (tab === "notifications") return notificationsSection();
    return portSection();
  }

  /* ---- Save bar ---- */
  function buildSaveBar() {
    const saveIcon = h("span", { style: { display: "inline-flex" } }, icon("check", { size: 16 }));
    const saveBtn = h("button.btn.btn--primary", { type: "button", onClick: save }, saveIcon, h("span", "Save changes"));

    async function save() {
      saveBtn.disabled = true;
      saveIcon.replaceChildren(h("span.spinner"));
      try {
        const saved = await api.updateSettings(working);
        settings = saved;
        working = structuredClone(saved);
        setDirty(false);
        toastSuccess("Settings saved", "Your changes take effect on future calculations.");
        render();
      } catch (err) {
        saveBtn.disabled = false;
        saveIcon.replaceChildren(icon("check", { size: 16 }));
        toastError("Couldn't save settings", err.message);
      }
    }

    function discard() {
      working = structuredClone(settings);
      setDirty(false);
      render();
    }

    return h(
      "div.save-bar",
      h("span.save-bar__note", icon("alert-circle", { size: 14 }), " You have unsaved changes"),
      h(
        "div.row",
        { style: { gap: "12px" } },
        button({ label: "Discard", variant: "secondary", onClick: discard }),
        saveBtn
      )
    );
  }

  function load() {
    content.replaceChildren(loadingBlock("Loading settings…"));
    api
      .getSettings()
      .then((s) => {
        settings = s;
        working = structuredClone(s);
        setDirty(false);
        render();
      })
      .catch((err) => {
        toastError("Couldn't load settings", err.message);
        content.replaceChildren(
          emptyState({
            iconName: "alert-circle",
            title: "Couldn't load settings",
            body: err.message,
            action: button({ label: "Retry", onClick: load }),
          })
        );
      });
  }

  load();
}
