/* ============================================================
   vesselCalls.js — Vessel Calls list (spec §1.6.1).
   Filter bar (search · status · date range), full-width table,
   pagination at 25 rows.
   ============================================================ */
import { h } from "../dom.js";
import { icon } from "../icons.js";
import { api } from "../store.js";
import { money, date } from "../format.js";
import { dataTable } from "../components/table.js";
import { badge, button, pdfActions, emptyState } from "../components/ui.js";
import { toastError } from "../components/toast.js";
import { openRegisterCall } from "./registerCall.js";

const PER_PAGE = 25;

export function renderVesselCalls(ctx) {
  const { content } = ctx;
  let all = null;
  let flashId = null;
  const state = { q: "", status: "all", from: "", to: "", page: 1 };

  /* ---- filter controls ---- */
  const searchInput = h("input.input", {
    type: "search",
    placeholder: "Search vessel name or reference…",
    "aria-label": "Search vessel calls",
  });
  searchInput.addEventListener("input", () => {
    state.q = searchInput.value.trim().toLowerCase();
    state.page = 1;
    refresh();
  });

  const STATUSES = [
    ["all", "All"],
    ["pending", "Pending"],
    ["in-progress", "In progress"],
    ["completed", "Completed"],
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
        state.page = 1;
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

  const fromInput = h("input.input", { type: "date", "aria-label": "ETA from" });
  const toInput = h("input.input", { type: "date", "aria-label": "ETA to" });
  const onDate = () => {
    state.from = fromInput.value;
    state.to = toInput.value;
    state.page = 1;
    refresh();
  };
  fromInput.addEventListener("change", onDate);
  toInput.addEventListener("change", onDate);

  const filterBar = h(
    "div.filter-bar",
    { role: "group", "aria-label": "Filter vessel calls" },
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
  );

  const tableSlot = h("div");

  const page = h(
    "div",
    h(
      "div.page-head",
      h(
        "div.page-head__text",
        h("h1.h1", "Vessel Calls"),
        h("p.page-head__desc", "Every registered vessel call at the port.")
      ),
      h(
        "div.page-head__actions",
        button({ label: "Register Vessel Call", leadingIcon: "plus", onClick: register })
      )
    ),
    filterBar,
    tableSlot
  );

  function register() {
    openRegisterCall({
      onCreated: (call) => {
        flashId = call.id;
        state.q = "";
        searchInput.value = "";
        state.status = "all";
        Object.entries(segButtons).forEach(([k, btn]) =>
          btn.classList.toggle("is-active", k === "all")
        );
        state.page = 1;
        load();
      },
    });
  }

  function filteredRows() {
    return all.filter((c) => {
      if (
        state.q &&
        !(
          c.vesselName.toLowerCase().includes(state.q) ||
          c.ref.toLowerCase().includes(state.q)
        )
      )
        return false;
      if (state.status !== "all" && c.status !== state.status) return false;
      if (state.from && c.eta && new Date(c.eta) < new Date(state.from)) return false;
      if (state.to && c.eta && new Date(c.eta) > new Date(state.to + "T23:59")) return false;
      return true;
    });
  }

  function refresh() {
    if (all === null) {
      tableSlot.replaceChildren(skeleton());
      return;
    }
    const rows = filteredRows();
    const total = rows.length;
    const pages = Math.max(1, Math.ceil(total / PER_PAGE));
    if (state.page > pages) state.page = pages;
    const start = (state.page - 1) * PER_PAGE;
    const pageRows = rows.slice(start, start + PER_PAGE);

    const footer =
      total > PER_PAGE || state.page > 1
        ? h(
            "div.table-foot",
            h(
              "span",
              `Showing ${total ? start + 1 : 0}–${Math.min(start + PER_PAGE, total)} of ${total}`
            ),
            h(
              "div.pager",
              button({
                label: "Previous",
                variant: "secondary",
                size: "sm",
                leadingIcon: "chevron-left",
                disabled: state.page <= 1,
                onClick: () => {
                  state.page--;
                  refresh();
                },
              }),
              button({
                label: "Next",
                variant: "secondary",
                size: "sm",
                trailingIcon: "chevron-right",
                disabled: state.page >= pages,
                onClick: () => {
                  state.page++;
                  refresh();
                },
              })
            )
          )
        : h("div.table-foot", h("span", `${total} vessel call${total === 1 ? "" : "s"}`));

    tableSlot.replaceChildren(
      dataTable({
        rows: pageRows,
        rowKey: (r) => r.id,
        flashKey: flashId,
        onRowClick: (r) => ctx.navigate(`/vessel-calls/${r.id}`),
        initialSort: null,
        empty: emptyState({
          iconName: "search",
          title: "No matching vessel calls",
          body: "Try a different search term or clear the filters.",
        }),
        footer,
        // (flashId is cleared below so the highlight only plays once)
        columns: [
          {
            key: "vesselName",
            label: "Vessel Name",
            sortable: true,
            render: (r) => h("span.cell-primary", r.vesselName),
          },
          { key: "ref", label: "Reference", sortable: true, render: (r) => h("span.tnum", r.ref) },
          { key: "type", label: "Type", sortable: true },
          { key: "flag", label: "Flag", render: (r) => r.flag || "—" },
          {
            key: "status",
            label: "Status",
            sortable: true,
            render: (r) => badge(r.status),
          },
          {
            key: "eta",
            label: "ETA/Berth",
            sortable: true,
            sortValue: (r) => (r.eta ? new Date(r.eta).getTime() : 0),
            render: (r) =>
              h(
                "div",
                h("div", date(r.eta)),
                h("div.cell-sub", r.berth || "—")
              ),
          },
          {
            key: "dues",
            label: "Dues",
            align: "num",
            sortable: true,
            sortValue: (r) => r.dues ?? -1,
            render: (r) =>
              r.dues != null ? h("span.money", money(r.dues)) : h("span.muted", "—"),
          },
          {
            key: "actions",
            label: "Actions",
            isActions: true,
            render: (r) =>
              r.status === "completed"
                ? pdfActions({
                    resolveInvoice: () => api.buildDoc({ callId: r.id }),
                    resolveReport: () => api.buildDoc({ callId: r.id }),
                  })
                : h(
                    // A plain accent text link (spec §1.5)
                    "a",
                    {
                      href: `#/vessel-calls/${r.id}`,
                      style: { fontWeight: "500" },
                      onClick: (e) => e.stopPropagation(),
                    },
                    "Open"
                  ),
          },
        ],
      })
    );
    flashId = null; // brief highlight: never replays on later re-renders
  }

  function skeleton() {
    return dataTable({
      loading: true,
      columns: [
        { key: "vesselName", label: "Vessel Name" },
        { key: "ref", label: "Reference" },
        { key: "type", label: "Type" },
        { key: "flag", label: "Flag" },
        { key: "status", label: "Status" },
        { key: "eta", label: "ETA/Berth" },
        { key: "dues", label: "Dues", align: "num" },
        { key: "actions", label: "Actions", isActions: true },
      ],
    });
  }

  function load() {
    if (all === null) tableSlot.replaceChildren(skeleton());
    api
      .listVesselCalls()
      .then((rows) => {
        all = rows;
        refresh();
      })
      .catch((err) => {
        toastError("Couldn't load vessel calls", err.message);
        tableSlot.replaceChildren(
          emptyState({
            iconName: "alert-circle",
            title: "Couldn't load vessel calls",
            body: err.message,
            action: button({ label: "Retry", onClick: load }),
          })
        );
      });
  }

  content.replaceChildren(page);
  load();
}
