/* ============================================================
   inspections.js — Inspections list (spec §1.7.1).
   H1 + primary "+ New Inspection", then the table:
   Reference · Vessel · Cargo Type · Reconciled Tonnage · Date ·
   Status · Actions — Report (shared PDF button) on completed rows,
   Resume on drafts (re-opens the draft itself).
   ============================================================ */
import { h } from "../dom.js";
import { icon } from "../icons.js";
import { api } from "../store.js";
import { tons, date } from "../format.js";
import { dataTable } from "../components/table.js";
import { badge, button, cargoTag, emptyState, pdfButton } from "../components/ui.js";
import { toastError } from "../components/toast.js";

export function renderInspections(ctx) {
  const { content } = ctx;
  let flashId = ctx.query.flash || null; // brief highlight for a just-created row

  const tableSlot = h("div");

  const page = h(
    "div",
    h(
      "div.page-head",
      h(
        "div.page-head__text",
        h("h1.h1", "Inspections"),
        h("p.page-head__desc", "Liquid and dry cargo inspections across all vessel calls.")
      ),
      h(
        "div.page-head__actions",
        button({ label: "New Inspection", leadingIcon: "plus", onClick: () => ctx.navigate("/inspections/new") })
      )
    ),
    tableSlot
  );

  function renderTable(rows) {
    tableSlot.replaceChildren(
      dataTable({
        rows,
        rowKey: (r) => r.id,
        flashKey: flashId,
        empty: emptyState({
          iconName: "clipboard",
          title: "No inspections yet",
          body: "Start a new inspection to reconcile cargo tonnage.",
          action: button({ label: "New Inspection", leadingIcon: "plus", onClick: () => ctx.navigate("/inspections/new") }),
        }),
        footer: rows.length
          ? h("div.table-foot", h("span", `${rows.length} inspection${rows.length === 1 ? "" : "s"}`))
          : null,
        columns: [
          { key: "ref", label: "Reference", sortable: true, render: (r) => h("span.tnum", r.ref) },
          { key: "vesselName", label: "Vessel", sortable: true, render: (r) => h("span.cell-primary", r.vesselName) },
          {
            key: "cargoType",
            label: "Cargo Type",
            render: (r) => h("div.row", { style: { gap: "8px" } }, cargoTag(r.cargoCategory), r.cargoType),
          },
          {
            key: "reconciledTonnage",
            label: "Reconciled Tonnage",
            align: "num",
            sortable: true,
            render: (r) => h("span.figure", tons(r.reconciledTonnage)),
          },
          {
            key: "date",
            label: "Date",
            sortable: true,
            sortValue: (r) => new Date(r.date).getTime(),
            render: (r) => date(r.date),
          },
          { key: "status", label: "Status", sortable: true, render: (r) => badge(r.status) },
          {
            key: "actions",
            label: "Actions",
            isActions: true,
            render: (r) =>
              r.status === "completed"
                ? pdfButton({
                    kind: "report",
                    resolve: () => api.buildDoc({ inspectionId: r.id }),
                  })
                : h(
                    "a.btn.btn--ghost.btn--sm",
                    { href: `#/inspections/new?draftId=${r.id}` },
                    icon("edit", { size: 20 }),
                    "Resume"
                  ),
          },
        ],
      })
    );
    flashId = null; // brief highlight: plays once, never on re-render
  }

  function load() {
    tableSlot.replaceChildren(
      dataTable({
        loading: true,
        columns: [
          { key: "ref", label: "Reference" },
          { key: "vesselName", label: "Vessel" },
          { key: "cargoType", label: "Cargo Type" },
          { key: "reconciledTonnage", label: "Reconciled Tonnage", align: "num" },
          { key: "date", label: "Date" },
          { key: "status", label: "Status" },
          { key: "actions", label: "Actions", isActions: true },
        ],
      })
    );
    api
      .listInspections()
      .then(renderTable)
      .catch((err) => {
        toastError("Couldn't load inspections", err.message);
        tableSlot.replaceChildren(
          emptyState({
            iconName: "alert-circle",
            title: "Couldn't load inspections",
            body: err.message,
            action: button({ label: "Retry", onClick: load }),
          })
        );
      });
  }

  content.replaceChildren(page);
  load();
}
