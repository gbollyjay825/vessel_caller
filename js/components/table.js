/* ============================================================
   table.js — data table (spec §1.10).
   Sortable headers, hairline dividers, hover tint, clickable rows,
   loading skeleton, empty state, responsive collapse-to-cards (<768px
   via .is-responsive + data-label, styled in components.css §1.8).

   Column: { key, label, align?:'num', sortable?, isActions?,
             mobile?:'title'|'sub'|'prominent'|'status',
             render?(row)->node|string, sortValue?(row)->any }
   `mobile` marks the cell's role in the <768px stacked card
   (title / subtitle / prominent figure / status, spec §1.8).
   ============================================================ */
import { h } from "../dom.js";
import { icon } from "../icons.js";

export function dataTable(opts = {}) {
  const {
    columns,
    rows = [],
    loading = false,
    empty = null,
    onRowClick,
    rowKey,
    flashKey,
    initialSort = null,
    responsive = true,
    footer = null,
    skeletonRows = 6,
    flush = false, // borderless: for tables embedded inside a card
  } = opts;

  let sort = initialSort;

  const wrap = h("div.table-wrap" + (flush ? ".table-wrap--flush" : ""));
  const scroll = h("div.table-scroll");
  const table = h("table", { class: "table" + (responsive ? " is-responsive" : "") });
  const thead = h("thead");
  const tbody = h("tbody");
  table.append(thead, tbody);
  scroll.append(table);
  wrap.append(scroll);

  function thCls(col) {
    return [col.align === "num" ? "is-num" : "", col.isActions ? "is-actions" : "", col.sortable ? "sortable" : ""]
      .filter(Boolean)
      .join(" ");
  }

  function buildHead() {
    const tr = h(
      "tr",
      columns.map((col) => {
        const ariaSort =
          sort && sort.key === col.key
            ? sort.dir === "asc"
              ? "ascending"
              : "descending"
            : "none";
        const th = h(
          "th",
          {
            class: thCls(col),
            ...(col.sortable
              ? { "aria-sort": ariaSort, role: "button", tabindex: "0" }
              : {}),
          },
          col.label,
          col.sortable ? h("span.sort-ind", icon("chevron-down", { size: 14 })) : null
        );
        if (col.sortable) {
          const toggle = () => {
            sort =
              sort && sort.key === col.key
                ? { key: col.key, dir: sort.dir === "asc" ? "desc" : "asc" }
                : { key: col.key, dir: "asc" };
            thead.replaceChildren(buildHead());
            renderBody();
          };
          th.addEventListener("click", toggle);
          th.addEventListener("keydown", (e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              toggle();
            }
          });
        }
        return th;
      })
    );
    return tr;
  }

  function sortedRows() {
    if (!sort) return rows;
    const col = columns.find((c) => c.key === sort.key);
    if (!col) return rows;
    const getVal = col.sortValue || ((r) => r[col.key]);
    const dir = sort.dir === "asc" ? 1 : -1;
    return [...rows].sort((a, b) => {
      const av = getVal(a);
      const bv = getVal(b);
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      if (typeof av === "number" && typeof bv === "number") return (av - bv) * dir;
      return String(av).localeCompare(String(bv)) * dir;
    });
  }

  function buildSkeleton() {
    return Array.from({ length: skeletonRows }, () =>
      h(
        "tr",
        columns.map((col) =>
          h(
            "td",
            { class: col.align === "num" ? "is-num" : "" },
            h("span.skeleton", {
              style: {
                width: col.isActions ? "84px" : col.align === "num" ? "64px" : "70%",
                marginLeft: col.align === "num" ? "auto" : "0",
              },
            })
          )
        )
      )
    );
  }

  function renderBody() {
    if (loading) {
      tbody.replaceChildren(...buildSkeleton());
      return;
    }
    const data = sortedRows();
    if (!data.length) {
      tbody.replaceChildren(
        h(
          "tr",
          h(
            "td",
            { colspan: String(columns.length), style: { padding: "0" } },
            empty || h("div.empty", h("p.muted", "No records found."))
          )
        )
      );
      return;
    }
    tbody.replaceChildren(
      ...data.map((row) => {
        const tr = h("tr", { class: onRowClick ? "is-clickable" : "" });
        if (rowKey && flashKey && rowKey(row) === flashKey)
          tr.classList.add("row-flash");
        columns.forEach((col) => {
          const td = h(
            "td",
            {
              class: [
                col.align === "num" ? "is-num" : "",
                col.isActions ? "is-actions" : "",
                col.mobile ? `m-${col.mobile}` : "",
              ]
                .filter(Boolean)
                .join(" "),
              "data-label": col.label,
            },
            col.render ? col.render(row) : row[col.key] ?? "—"
          );
          tr.append(td);
        });
        if (onRowClick) {
          tr.addEventListener("click", () => onRowClick(row));
          tr.setAttribute("tabindex", "0");
          tr.setAttribute("role", "button");
          tr.addEventListener("keydown", (e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              onRowClick(row);
            }
          });
        }
        return tr;
      })
    );
  }

  thead.append(buildHead());
  renderBody();
  if (footer) wrap.append(footer);
  return wrap;
}
