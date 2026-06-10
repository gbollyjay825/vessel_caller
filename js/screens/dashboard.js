/* ============================================================
   dashboard.js — landing screen, per the approved design:
   KPI strip (period labels + deltas) → cargo-throughput chart +
   PMS highlight card → Recent Vessel Calls card with View all.
   ============================================================ */
import { h } from "../dom.js";
import { icon } from "../icons.js";
import { api } from "../store.js";
import { money, naira, num, date } from "../format.js";
import { dataTable } from "../components/table.js";
import { areaChart, sparkline } from "../components/chart.js";
import {
  statCard,
  badge,
  button,
  pdfActions,
  emptyState,
} from "../components/ui.js";
import { toastError } from "../components/toast.js";
import { openRegisterCall } from "./registerCall.js";

const LIQUID_STROKE = "#1b5faa";
const LIQUID_FILL = "rgba(27, 95, 170, 0.12)";
const DRY_STROKE = "#d9a13b";
const DRY_FILL = "rgba(217, 161, 59, 0.16)";

const monthLabel = () =>
  new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric" }).format(new Date());

/** "$" prefix rendered small and raised, per the design. */
function curValue(n, symbol = "$") {
  return h(
    "span",
    { class: "tnum" },
    h("span.cur", symbol),
    num(Math.round(n))
  );
}

const fmtM = (mt) => `${(mt / 1e6).toFixed(2).replace(/0$/, "")}M`;

export function renderDashboard(ctx) {
  const { content } = ctx;
  let flashId = null;

  function load() {
    content.replaceChildren(loadingView());
    Promise.all([api.getDashboard(), api.getAnalytics()])
      .then(([data, analytics]) => {
        content.replaceChildren(view(data, analytics));
        flashId = null; // the new-row highlight plays once (spec §1.6.2)
      })
      .catch((err) => {
        toastError("Couldn't load the dashboard", err.message);
        content.replaceChildren(
          emptyState({
            iconName: "alert-circle",
            title: "Couldn't load the dashboard",
            body: err.message,
            action: button({ label: "Retry", onClick: load }),
          })
        );
      });
  }

  function register() {
    openRegisterCall({
      onCreated: (call) => {
        flashId = call.id;
        load();
      },
    });
  }

  function view(data, analytics) {
    const head = h(
      "div.page-head",
      h(
        "div.page-head__text",
        h("h1.h1", "Dashboard"),
        h("p.page-head__desc", "What is happening at the Port of Calabar right now.")
      )
    );

    const period = monthLabel();
    const kpis = h(
      "div.kpi-strip",
      statCard({
        label: "Active Vessel Calls",
        value: String(data.activeCalls),
        delta: "+2",
        deltaDir: "up",
        foot: "vs last week",
      }),
      statCard({
        label: "Inspections This Month",
        value: String(data.inspectionsThisMonth),
        delta: "+1",
        deltaDir: "up",
        foot: period,
      }),
      statCard({
        label: "Total Harbour Dues Collected",
        valueNode: curValue(data.duesCollected),
        foot: period,
      }),
      statCard({
        label: "Commission Earned",
        valueNode: h(
          "div",
          curValue(data.commissionUSD),
          h(
            "div.money__secondary",
            { style: { fontSize: "13px", marginTop: "2px" } },
            naira(data.commissionNGN)
          )
        ),
        foot: period,
      })
    );

    return h(
      "div",
      head,
      kpis,
      chartsRow(analytics),
      recentCallsCard(data.recentCalls)
    );
  }

  /* ---- Cargo throughput chart + PMS highlight (design) ---- */
  function chartsRow(a) {
    const chart = areaChart({
      labels: a.labels,
      series: [
        { values: a.liquid, stroke: LIQUID_STROKE, fill: LIQUID_FILL },
        { values: a.dry, stroke: DRY_STROKE, fill: DRY_FILL },
      ],
      height: 260,
      ariaLabel: "Cargo throughput by month, liquid versus dry",
    });

    const legend = h(
      "div.chart-legend",
      h(
        "span.chart-legend__item",
        h("span.chart-legend__swatch", { style: { background: LIQUID_STROKE } }),
        "Liquid (PMS · AGO · DPK)"
      ),
      h(
        "span.chart-legend__item",
        h("span.chart-legend__swatch", { style: { background: DRY_STROKE } }),
        "Dry / bulk"
      )
    );

    const chartCard = h(
      "div.card.card--pad",
      h(
        "div.chart-card__head",
        h(
          "div.chart-card__titles",
          h("h2.card__title", "Cargo throughput · last 12 months"),
          h(
            "div.chart-card__sub",
            h("strong", `${fmtM(a.totals.liquidMT)} MT liquid`),
            ` · ${fmtM(a.totals.dryMT)} MT dry`
          )
        ),
        h(
          "a.link-arrow",
          { href: "#/analytics" },
          "Full analytics",
          icon("chevron-right", { size: 16 })
        )
      ),
      legend,
      chart
    );

    const pms = a.pms;
    const promoCard = h(
      "div.promo-card",
      h("div.promo-card__label", icon("droplet", { size: 14 }), `${pms.abbr} · ${pms.name}`),
      h(
        "div.promo-card__value",
        { class: "tnum" },
        fmtM(pms.volumeMT),
        h("span.promo-card__unit", "MT")
      ),
      h(
        "div.promo-card__desc",
        `${pms.sharePct}% of all cargo through Calabar · last 12 months`
      ),
      h("div.promo-card__divider"),
      h(
        "div.promo-card__row",
        h("span", `Revenue from ${pms.abbr}`),
        h("span.money", `$${(pms.revenueUSD / 1e6).toFixed(2)}M`)
      ),
      h("div.promo-card__spark", sparkline({ values: pms.trend, ariaLabel: `${pms.abbr} volume trend` }))
    );

    return h("div.chart-row", chartCard, promoCard);
  }

  /* ---- Recent Vessel Calls card ---- */
  function recentCallsCard(recent) {
    const headRow = h(
      "div.card__head",
      h("h2.card__title", "Recent Vessel Calls"),
      h(
        "a.link-arrow",
        { href: "#/vessel-calls" },
        "View all",
        icon("chevron-right", { size: 16 })
      )
    );

    if (!recent.length) {
      return h(
        "div.card",
        headRow,
        emptyState({
          iconName: "ship",
          title: "No vessel calls yet",
          body: "Register the first incoming vessel to get started",
          action: button({
            label: "Register Vessel Call",
            leadingIcon: "plus",
            onClick: register,
          }),
        })
      );
    }

    return h("div.card", headRow, recentTable(recent));
  }

  function recentTable(rows) {
    return dataTable({
      rows,
      flush: true,
      rowKey: (r) => r.id,
      flashKey: flashId,
      onRowClick: (r) => ctx.navigate(`/vessel-calls/${r.id}`),
      columns: [
        {
          key: "vesselName",
          label: "Vessel Name",
          render: (r) =>
            h(
              "div",
              h("div.cell-primary", r.vesselName),
              h("div.cell-sub", r.flag || "—")
            ),
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
    });
  }

  function loadingView() {
    return h(
      "div",
      h(
        "div.page-head",
        h("div.page-head__text", h("h1.h1", "Dashboard"), h("p.page-head__desc", "Loading…"))
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
        "div.chart-row",
        h(
          "div.card.card--pad",
          h("span.skeleton", { style: { width: "40%" } }),
          h("span.skeleton", { style: { width: "100%", height: "220px", marginTop: "16px" } })
        ),
        h("div.card.card--pad", h("span.skeleton", { style: { width: "100%", height: "100%", minHeight: "220px" } }))
      ),
      h(
        "div.card",
        h("div.card__head", h("h2.card__title", "Recent Vessel Calls")),
        dataTable({
          loading: true,
          flush: true,
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
