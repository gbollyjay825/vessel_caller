/* ============================================================
   inspections.js — Inspections list (spec §1.7.1).
   Table with Liquid/Dry tags; Report on completed, Resume on drafts.
   ============================================================ */
import { h } from "../dom.js";
import { icon } from "../icons.js";
import { api } from "../store.js";
import { tons, date } from "../format.js";
import { openPrintable } from "../pdf.js";
import { dataTable } from "../components/table.js";
import { badge, button, cargoTag, emptyState } from "../components/ui.js";
import { toastError } from "../components/toast.js";

export function renderInspections(ctx) {
  const { content } = ctx;
  let all = null;
  const state = { q: "", status: "all" };

  const searchInput = h("input.input", {
    type: "search",
    placeholder: "Search reference or vessel…",
    "aria-label": "Search inspections",
  });
  searchInput.addEventListener("input", () => {
    state.q = searchInput.value.trim().toLowerCase();
    refresh();
  });

  const STATUSES = [
    ["all", "All"],
    ["completed", "Completed"],
    ["draft", "Draft"],
  ];
  const segButtons = {};
  const seg = h(
    "div.seg-filter",
    { role: "tablist", "aria-label": "Filter by status" },
    STATUSES.map(([v, l]) => {
      const b = h("button", { type: "button", class: v === state.status ? "is-active" : "", role: "tab" }, l);
      b.addEventListener("click", () => {
        state.status = v;
        Object.entries(segButtons).forEach(([k, btn]) => btn.classList.toggle("is-active", k === v));
        refresh();
      });
      segButtons[v] = b;
      return b;
    })
  );

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
    h("div.filter-bar", h("div.search", icon("search", { size: 16 }), searchInput), seg),
    tableSlot
  );

  function openReport(insp) {
    const w = window.open("", "_blank");
    if (!openPrintable("report", api.buildDoc({ inspectionId: insp.id }), w))
      toastError("Pop-up blocked", "Allow pop-ups to open the report.");
  }

  function filtered() {
    return all.filter((i) => {
      if (state.q && !(i.ref.toLowerCase().includes(state.q) || i.vesselName.toLowerCase().includes(state.q)))
        return false;
      if (state.status !== "all" && i.status !== state.status) return false;
      return true;
    });
  }

  function refresh() {
    if (all === null) return;
    const rows = filtered();
    tableSlot.replaceChildren(
      dataTable({
        rows,
        empty: emptyState({
          iconName: "clipboard",
          title: all.length ? "No matching inspections" : "No inspections yet",
          body: all.length
            ? "Try a different search or filter."
            : "Start a new inspection to reconcile cargo tonnage.",
          action: all.length
            ? null
            : button({ label: "New Inspection", leadingIcon: "plus", onClick: () => ctx.navigate("/inspections/new") }),
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
            render: (r) => h("span.tnum", tons(r.reconciledTonnage)),
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
                ? h(
                    "span.cell-actions",
                    button({ label: "Report", variant: "pdf", leadingIcon: "file", onClick: () => openReport(r) })
                  )
                : h(
                    "a.btn.btn--ghost.btn--sm",
                    { href: `#/inspections/new?callId=${r.callId}` },
                    icon("edit", { size: 15 }),
                    "Resume"
                  ),
          },
        ],
      })
    );
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
      .then((rows) => {
        all = rows;
        refresh();
      })
      .catch((err) =>
        tableSlot.replaceChildren(
          emptyState({
            iconName: "alert-circle",
            title: "Couldn't load inspections",
            body: err.message,
            action: button({ label: "Retry", onClick: load }),
          })
        )
      );
  }

  content.replaceChildren(page);
  load();
}
