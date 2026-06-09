/* ============================================================
   vesselCallDetail.js — Vessel Call detail (spec §1.6.3).
   Header (name/ref/type/flag + status) and three sections:
   particulars · inspections on this call · financials + PDFs.
   ============================================================ */
import { h } from "../dom.js";
import { icon } from "../icons.js";
import { api } from "../store.js";
import { money, naira, num, tons, pct, date, dateTime } from "../format.js";
import { openPrintable } from "../pdf.js";
import { dataTable } from "../components/table.js";
import {
  badge,
  button,
  card,
  kvGrid,
  cargoTag,
  emptyState,
  loadingBlock,
  sectionHead,
} from "../components/ui.js";
import { confirmDialog } from "../components/modal.js";
import { toastSuccess, toastError } from "../components/toast.js";

function openPdfTab(kind, doc, label) {
  const w = window.open("", "_blank");
  if (!openPrintable(kind, doc, w))
    toastError("Pop-up blocked", `Allow pop-ups to open the ${label.toLowerCase()}.`);
}

export function renderVesselCallDetail(ctx) {
  const { content, params } = ctx;

  function load() {
    content.replaceChildren(loadingBlock("Loading vessel call…"));
    api
      .getVesselCall(params.id)
      .then((call) => {
        ctx.setTitle(call.vesselName);
        content.replaceChildren(view(call));
      })
      .catch((err) =>
        content.replaceChildren(
          emptyState({
            iconName: "alert-circle",
            title: "Vessel call not found",
            body: err.message,
            action: h("a.btn.btn--primary", { href: "#/vessel-calls" }, "Back to Vessel Calls"),
          })
        )
      );
  }

  function view(call) {
    const completed = call.inspections.find((i) => i.status === "completed");

    const backLink = h(
      "a.btn.btn--ghost.btn--sm",
      { href: "#/vessel-calls", style: { marginBottom: "16px", paddingLeft: "6px" } },
      icon("arrow-left", { size: 16 }),
      "Vessel Calls"
    );

    const header = h(
      "div.page-head",
      h(
        "div.page-head__text",
        h("div.row", { style: { gap: "12px", flexWrap: "wrap" } }, h("h1.h1", call.vesselName), badge(call.status)),
        h(
          "p.page-head__desc",
          h("span.tnum", call.ref),
          " · ",
          call.type,
          " · ",
          call.flag || "Unknown flag"
        )
      ),
      h(
        "div.page-head__actions",
        button({
          label: "Add Inspection",
          leadingIcon: "plus",
          onClick: () => ctx.navigate(`/inspections/new?callId=${call.id}`),
        }),
        call.status !== "completed"
          ? button({ label: "Cancel call", variant: "secondary", onClick: () => cancelCall(call) })
          : null
      )
    );

    return h("div", backLink, header, particulars(call), inspectionsSection(call), financials(call, completed));
  }

  /* ---- Vessel particulars ---- */
  function particulars(call) {
    const pairs = [
      ["Net registered tonnage", `${num(call.nrt)} NRT`],
      ["Vessel type", call.type],
      ["Flag / registry", call.flag || "—"],
      ["ETA", dateTime(call.eta)],
      ["Berth / terminal", call.berth || "—"],
      ["Registered", dateTime(call.registeredDate)],
    ];
    return h(
      "section.section",
      sectionHead("Vessel particulars"),
      card(
        h(
          "div",
          kvGrid(pairs),
          call.notes
            ? h(
                "div",
                { style: { marginTop: "24px", paddingTop: "20px", borderTop: "1px solid var(--border)" } },
                h("div.kv__key", "Notes"),
                h("p", { style: { marginTop: "4px" } }, call.notes)
              )
            : null
        )
      )
    );
  }

  /* ---- Inspections on this call ---- */
  function inspectionsSection(call) {
    const addBtn = button({
      label: "Add Inspection",
      variant: "secondary",
      size: "sm",
      leadingIcon: "plus",
      onClick: () => ctx.navigate(`/inspections/new?callId=${call.id}`),
    });

    const body = call.inspections.length
      ? dataTable({
          rows: call.inspections,
          columns: [
            { key: "ref", label: "Reference", render: (r) => h("span.tnum", r.ref) },
            { key: "date", label: "Date", render: (r) => date(r.date) },
            {
              key: "cargoType",
              label: "Cargo",
              render: (r) =>
                h("div.row", { style: { gap: "8px" } }, cargoTag(r.cargoCategory), r.cargoType),
            },
            {
              key: "reconciledTonnage",
              label: "Reconciled Tonnage",
              align: "num",
              render: (r) => h("span.tnum", tons(r.reconciledTonnage)),
            },
            { key: "status", label: "Status", render: (r) => badge(r.status) },
            {
              key: "actions",
              label: "Actions",
              isActions: true,
              render: (r) =>
                r.status === "completed"
                  ? h(
                      "span.cell-actions",
                      button({
                        label: "Report",
                        variant: "pdf",
                        leadingIcon: "file",
                        onClick: () =>
                          openPdfTab("report", api.buildDoc({ inspectionId: r.id }), "Report"),
                      })
                    )
                  : h(
                      "a.btn.btn--ghost.btn--sm",
                      { href: `#/inspections/new?callId=${call.id}` },
                      "Resume"
                    ),
            },
          ],
        })
      : card(
          emptyState({
            iconName: "clipboard",
            title: "No inspections yet",
            body: "Add the first cargo inspection for this vessel call.",
            action: button({
              label: "Add Inspection",
              leadingIcon: "plus",
              onClick: () => ctx.navigate(`/inspections/new?callId=${call.id}`),
            }),
          })
        );

    return h("section.section", sectionHead("Inspections on this call", h("div.grow"), addBtn), body);
  }

  /* ---- Financials ---- */
  function financials(call, insp) {
    if (!insp || !insp.charges) {
      return h(
        "section.section",
        sectionHead("Financials"),
        card(
          h(
            "div.row",
            { style: { gap: "12px" } },
            icon("info", { size: 20, cls: "muted" }),
            h(
              "p.muted",
              "Harbour dues, commission and PDFs appear here once an inspection on this call is completed."
            )
          )
        )
      );
    }

    const c = insp.charges;
    const breakdown = card(
      h(
        "div",
        h(
          "div.breakdown__row",
          h(
            "span.breakdown__key",
            h("strong", "NPA harbour dues"),
            h("div.cell-sub", `${tons(c.reconciledTonnage)} × ${money(c.duesRatePerTon)}/MT`)
          ),
          h("span.money.money--lg", money(c.harbourDues))
        ),
        h(
          "div.breakdown__row",
          h(
            "span.breakdown__key",
            h("strong", `Agency commission (${pct(c.commissionRate)})`),
            h("div.cell-sub", `Commission on harbour dues`)
          ),
          h(
            "div",
            { style: { textAlign: "right" } },
            h("span.money.money--lg", money(c.commissionUSD)),
            h("div.money__secondary", naira(c.commissionNGN))
          )
        ),
        h(
          "div.breakdown__row.breakdown__row--total",
          h("span.breakdown__key", h("strong", "Total due")),
          h("span.money.money--lg", money(c.harbourDues + c.commissionUSD))
        ),
        h(
          "div.result-card__pdf-actions",
          { style: { marginTop: "20px" } },
          button({
            label: "View & download invoice",
            variant: "primary",
            leadingIcon: "download",
            onClick: () => openPdfTab("invoice", api.buildDoc({ inspectionId: insp.id }), "Invoice"),
          }),
          button({
            label: "View & download inspection report",
            variant: "secondary",
            leadingIcon: "file",
            onClick: () => openPdfTab("report", api.buildDoc({ inspectionId: insp.id }), "Report"),
          })
        )
      )
    );

    return h("section.section", sectionHead("Financials"), breakdown);
  }

  function cancelCall(call) {
    confirmDialog({
      title: `Cancel ${call.ref}?`,
      message: `This will cancel the vessel call for ${call.vesselName}. This action cannot be undone.`,
      confirmLabel: "Cancel call",
      danger: true,
    }).then((ok) => {
      if (!ok) return;
      // Demo: no destructive backend call; acknowledge per spec §1.11.
      toastSuccess("Call cancelled", `${call.ref} has been cancelled.`);
      ctx.navigate("/vessel-calls");
    });
  }

  load();
}
