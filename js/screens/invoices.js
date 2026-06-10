/* ============================================================
   invoices.js — Invoices list (spec §1.8).
   Filters (status · date range · search), table with always-two
   PDF buttons, and a detail drawer with the full line-item
   breakdown (traceability, principle §1.2.4).
   ============================================================ */
import { h } from "../dom.js";
import { icon } from "../icons.js";
import { api } from "../store.js";
import { money, naira, num, tons, pct, date, dateTime } from "../format.js";
import { openPrintable } from "../pdf.js";
import { dataTable } from "../components/table.js";
import { badge, button, pdfActions, moneyFigure, emptyState, card } from "../components/ui.js";
import { openPanel } from "../components/modal.js";
import { toastError } from "../components/toast.js";

export function renderInvoices(ctx) {
  const { content } = ctx;
  let all = null;
  const state = { q: "", status: "all", from: "", to: "" };

  const searchInput = h("input.input", {
    type: "search",
    placeholder: "Search invoice no. or vessel…",
    "aria-label": "Search invoices",
  });
  searchInput.addEventListener("input", () => {
    state.q = searchInput.value.trim().toLowerCase();
    refresh();
  });

  const STATUSES = [
    ["all", "All"],
    ["paid", "Paid"],
    ["unpaid", "Unpaid"],
    ["overdue", "Overdue"],
  ];
  const segButtons = {};
  const seg = h(
    "div.seg-filter",
    { role: "group", "aria-label": "Filter by status" },
    STATUSES.map(([v, l]) => {
      const b = h(
        "button",
        {
          type: "button",
          class: v === state.status ? "is-active" : "",
          "aria-pressed": String(v === state.status),
        },
        l
      );
      b.addEventListener("click", () => {
        state.status = v;
        Object.entries(segButtons).forEach(([k, btn]) => {
          btn.classList.toggle("is-active", k === v);
          btn.setAttribute("aria-pressed", String(k === v));
        });
        refresh();
      });
      segButtons[v] = b;
      return b;
    })
  );

  const fromInput = h("input.input", { type: "date", "aria-label": "Issued from" });
  const toInput = h("input.input", { type: "date", "aria-label": "Issued to" });
  const onDate = () => {
    state.from = fromInput.value;
    state.to = toInput.value;
    refresh();
  };
  fromInput.addEventListener("change", onDate);
  toInput.addEventListener("change", onDate);

  const tableSlot = h("div");

  const page = h(
    "div",
    h(
      "div.page-head",
      h(
        "div.page-head__text",
        h("h1.h1", "Invoices"),
        h("p.page-head__desc", "Issued invoices with harbour dues and commission.")
      )
    ),
    h(
      "div.filter-bar",
      h("div.search", icon("search", { size: 16 }), searchInput),
      seg,
      h(
        "div.row",
        { style: { gap: "8px" } },
        icon("calendar", { size: 16, cls: "muted" }),
        fromInput,
        h("span.muted", "→"),
        toInput
      )
    ),
    tableSlot
  );

  function filtered() {
    return all.filter((i) => {
      if (state.q && !(i.invoiceNo.toLowerCase().includes(state.q) || i.vesselName.toLowerCase().includes(state.q)))
        return false;
      if (state.status !== "all" && i.status !== state.status) return false;
      if (state.from && new Date(i.issued) < new Date(state.from)) return false;
      if (state.to && new Date(i.issued) > new Date(state.to + "T23:59")) return false;
      return true;
    });
  }

  function refresh() {
    if (all === null) return;
    const rows = filtered();
    tableSlot.replaceChildren(
      dataTable({
        rows,
        onRowClick: (r) => openDrawer(r),
        empty: emptyState({
          iconName: "invoice",
          title: all.length ? "No matching invoices" : "No invoices yet",
          body: all.length ? "Try a different search or filter." : "Invoices are generated when an inspection is completed.",
        }),
        footer: rows.length
          ? h("div.table-foot", h("span", `${rows.length} invoice${rows.length === 1 ? "" : "s"}`))
          : null,
        // `mobile` roles compose the <768px card: vessel + invoice no. as
        // title, amount prominent, status badge, PDF buttons last (§1.8).
        columns: [
          { key: "invoiceNo", label: "Invoice No.", sortable: true, mobile: "sub", render: (r) => h("span.tnum.cell-primary", r.invoiceNo) },
          { key: "vesselName", label: "Vessel", sortable: true, mobile: "title" },
          { key: "callRef", label: "Call Reference", render: (r) => h("span.tnum", r.callRef) },
          {
            key: "amountUSD",
            label: "Amount (USD)",
            align: "num",
            sortable: true,
            mobile: "prominent",
            render: (r) => h("span.money", money(r.amountUSD)),
          },
          {
            key: "commissionUSD",
            label: "Commission",
            align: "num",
            sortable: true,
            render: (r) => moneyFigure(r.commissionUSD, { ngn: r.commissionNGN }),
          },
          { key: "status", label: "Status", sortable: true, mobile: "status", render: (r) => badge(r.status) },
          {
            key: "issued",
            label: "Issued",
            sortable: true,
            sortValue: (r) => new Date(r.issued).getTime(),
            render: (r) => date(r.issued),
          },
          {
            key: "actions",
            label: "Actions",
            isActions: true,
            render: (r) =>
              pdfActions({
                resolveInvoice: () => api.buildDoc({ invoiceId: r.id }),
                resolveReport: () => api.buildDoc({ invoiceId: r.id }),
              }),
          },
        ],
      })
    );
  }

  function openDrawer(inv) {
    const doc = api.buildDoc({ invoiceId: inv.id });
    function openDoc(kind) {
      const w = window.open("", "_blank");
      if (!openPrintable(kind, doc, w)) toastError("Pop-up blocked", `Allow pop-ups to open the ${kind}.`);
    }

    const lineRow = (k, sub, val) =>
      h(
        "div.breakdown__row",
        h("span.breakdown__key", h("strong", k), sub ? h("div.cell-sub", sub) : null),
        val
      );

    openPanel({
      kind: "slideover",
      title: inv.invoiceNo,
      subtitle: `${inv.vesselName} · ${inv.callRef}`,
      body: h(
        "div",
        h("div.row", { style: { marginBottom: "20px" } }, badge(inv.status), h("div.grow"), h("span.meta", `Issued ${dateTime(inv.issued)}`)),
        card(
          h(
            "div",
            h("h2.card__title", { style: { marginBottom: "12px" } }, "Line-item breakdown"),
            lineRow(
              "NPA harbour dues",
              `${tons(doc.reconciledTonnage)} × ${money(doc.duesRatePerTon)}/MT`,
              h("span.money.money--lg", money(doc.harbourDues))
            ),
            lineRow(
              `Agency commission (${pct(doc.commissionRate)})`,
              "Commission on harbour dues",
              h(
                "div",
                { style: { textAlign: "right" } },
                h("span.money.money--lg", money(doc.commissionUSD)),
                h("div.money__secondary", `${naira(doc.commissionNGN)} @ ₦${num(doc.exchangeRate)}/USD`)
              )
            ),
            h(
              "div.breakdown__row.breakdown__row--total",
              h("span.breakdown__key", h("strong", "Total due")),
              h("span.money.money--lg", money(doc.harbourDues + doc.commissionUSD))
            )
          ),
          { pad: true }
        ),
        h(
          "div",
          { style: { marginTop: "20px" } },
          card(
            h(
              "div",
              h("h2.card__title", { style: { marginBottom: "12px" } }, "Dues basis"),
              h("div.summary-row", h("span.summary-row__key", "Cargo"), h("span.summary-row__val", `${doc.cargoType} (${doc.cargoCategory === "liquid" ? "Liquid" : "Dry"})`)),
              h("div.summary-row", h("span.summary-row__key", "Reconciled tonnage"), h("span.summary-row__val.tnum", tons(doc.reconciledTonnage))),
              h("div.summary-row", h("span.summary-row__key", "Dues rate"), h("span.summary-row__val", `${money(doc.duesRatePerTon)} / MT`)),
              h("div.summary-row", h("span.summary-row__key", "Commission rate"), h("span.summary-row__val", pct(doc.commissionRate))),
              h("div.summary-row", h("span.summary-row__key", "Exchange rate"), h("span.summary-row__val", `₦${num(doc.exchangeRate)} / USD`))
            ),
            { pad: true }
          )
        )
      ),
      footer: h(
        "div.panel__foot",
        button({ label: "View & download report", variant: "secondary", leadingIcon: "file", onClick: () => openDoc("report") }),
        button({ label: "View & download invoice", variant: "primary", leadingIcon: "download", onClick: () => openDoc("invoice") })
      ),
    });
  }

  function load() {
    tableSlot.replaceChildren(
      dataTable({
        loading: true,
        columns: [
          { key: "invoiceNo", label: "Invoice No." },
          { key: "vesselName", label: "Vessel" },
          { key: "callRef", label: "Call Reference" },
          { key: "amountUSD", label: "Amount (USD)", align: "num" },
          { key: "commissionUSD", label: "Commission", align: "num" },
          { key: "status", label: "Status" },
          { key: "issued", label: "Issued" },
          { key: "actions", label: "Actions", isActions: true },
        ],
      })
    );
    api
      .listInvoices()
      .then((rows) => {
        all = rows;
        refresh();
      })
      .catch((err) => {
        toastError("Couldn't load invoices", err.message);
        tableSlot.replaceChildren(
          emptyState({
            iconName: "alert-circle",
            title: "Couldn't load invoices",
            body: err.message,
            action: button({ label: "Retry", onClick: load }),
          })
        );
      });
  }

  content.replaceChildren(page);
  load();
}
