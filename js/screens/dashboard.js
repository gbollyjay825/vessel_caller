/* ============================================================
   dashboard.js — landing screen (spec §1.5).
   KPI strip + recent vessel calls table + empty state.
   ============================================================ */
import { h } from "../dom.js";
import { api } from "../store.js";
import { money, naira, date } from "../format.js";
import { dataTable } from "../components/table.js";
import {
  statCard,
  badge,
  button,
  pdfActions,
  emptyState,
  moneyFigure,
} from "../components/ui.js";
import { openRegisterCall } from "./registerCall.js";

export function renderDashboard(ctx) {
  const { content } = ctx;
  let flashId = null;

  function load() {
    content.replaceChildren(loadingView());
    api
      .getDashboard()
      .then((data) => content.replaceChildren(view(data)))
      .catch((err) =>
        content.replaceChildren(
          emptyState({
            iconName: "alert-circle",
            title: "Couldn't load the dashboard",
            body: err.message,
            action: button({ label: "Retry", onClick: load }),
          })
        )
      );
  }

  function register() {
    openRegisterCall({
      onCreated: (call) => {
        flashId = call.id;
        load();
        ctx.navigate(`/vessel-calls/${call.id}`);
      },
    });
  }

  function view(data) {
    const head = h(
      "div.page-head",
      h(
        "div.page-head__text",
        h("h1.h1", "Port overview"),
        h("p.page-head__desc", "What is happening at the Port of Calabar right now.")
      ),
      h(
        "div.page-head__actions",
        button({
          label: "Register Vessel Call",
          leadingIcon: "plus",
          onClick: register,
        })
      )
    );

    const kpis = h(
      "div.kpi-strip",
      statCard({
        label: "Active Vessel Calls",
        value: String(data.activeCalls),
        delta: "+2",
        deltaDir: "up",
        foot: "vs last month",
      }),
      statCard({
        label: "Inspections This Month",
        value: String(data.inspectionsThisMonth),
        delta: "+1",
        deltaDir: "up",
        foot: "vs last month",
      }),
      statCard({
        label: "Harbour Dues Collected",
        value: money(data.duesCollected),
        foot: "this month",
      }),
      statCard({
        label: "Commission Earned",
        valueNode: h(
          "div",
          h("div", { class: "tnum" }, money(data.commissionUSD)),
          h("div.money__secondary", { style: { fontSize: "13px", marginTop: "2px" } }, naira(data.commissionNGN))
        ),
        foot: "this month",
      })
    );

    const recent = data.recentCalls;
    const body = recent.length
      ? recentTable(recent)
      : emptyState({
          iconName: "ship",
          title: "No vessel calls yet",
          body: "Register the first incoming vessel to get started.",
          action: button({
            label: "Register Vessel Call",
            leadingIcon: "plus",
            onClick: register,
          }),
        });

    return h(
      "div",
      head,
      kpis,
      h(
        "section.section",
        h(
          "div.section__head",
          h("h2.h2", "Recent Vessel Calls"),
          h("div.grow"),
          button({
            label: "View all",
            variant: "ghost",
            size: "sm",
            trailingIcon: "chevron-right",
            onClick: () => ctx.navigate("/vessel-calls"),
          })
        ),
        body
      )
    );
  }

  function recentTable(rows) {
    return dataTable({
      rows,
      rowKey: (r) => r.id,
      flashKey: flashId,
      onRowClick: (r) => ctx.navigate(`/vessel-calls/${r.id}`),
      columns: [
        {
          key: "vesselName",
          label: "Vessel Name",
          render: (r) => h("span.cell-primary", r.vesselName),
        },
        { key: "ref", label: "Call Reference", render: (r) => h("span.tnum", r.ref) },
        { key: "type", label: "Type" },
        {
          key: "status",
          label: "Status",
          render: (r) => badge(r.status),
        },
        {
          key: "eta",
          label: "Berth Date",
          render: (r) => date(r.eta),
        },
        {
          key: "dues",
          label: "Dues",
          align: "num",
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
                  "a.btn.btn--ghost.btn--sm",
                  {
                    href: `#/vessel-calls/${r.id}`,
                    onClick: (e) => e.stopPropagation(),
                  },
                  "Open",
                  // trailing chevron
                ),
        },
      ],
    });
  }

  function loadingView() {
    return h(
      "div",
      h(
        "div.page-head",
        h("div.page-head__text", h("h1.h1", "Port overview"), h("p.page-head__desc", "Loading…"))
      ),
      h(
        "div.kpi-strip",
        ...Array.from({ length: 4 }, () =>
          h(
            "div.stat-card",
            h("span.skeleton", { style: { width: "60%" } }),
            h("span.skeleton", { style: { width: "45%", height: "28px", marginTop: "14px" } })
          )
        )
      ),
      h(
        "section.section",
        h("div.section__head", h("h2.h2", "Recent Vessel Calls")),
        dataTable({
          loading: true,
          columns: [
            { key: "vesselName", label: "Vessel Name" },
            { key: "ref", label: "Call Reference" },
            { key: "type", label: "Type" },
            { key: "status", label: "Status" },
            { key: "eta", label: "Berth Date" },
            { key: "dues", label: "Dues", align: "num" },
            { key: "actions", label: "Actions", isActions: true },
          ],
        })
      )
    );
  }

  load();
}
