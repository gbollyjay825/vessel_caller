/* ============================================================
   analytics.js — Analytics screen (design): port-level cargo
   throughput, product mix and revenue, last 12 months.
   ============================================================ */
import { h } from "../dom.js";
import { api } from "../store.js";
import { num, pct } from "../format.js";
import { dataTable } from "../components/table.js";
import { areaChart } from "../components/chart.js";
import { statCard, button, cargoTag, emptyState } from "../components/ui.js";
import { toastError } from "../components/toast.js";

const LIQUID_STROKE = "#1b5faa";
const LIQUID_FILL = "rgba(27, 95, 170, 0.12)";
const DRY_STROKE = "#d9a13b";
const DRY_FILL = "rgba(217, 161, 59, 0.16)";

const fmtM = (mt) => `${(mt / 1e6).toFixed(2).replace(/0$/, "")}M`;

export function renderAnalytics(ctx) {
  const { content } = ctx;

  function load() {
    content.replaceChildren(loadingView());
    api
      .getAnalytics()
      .then((a) => content.replaceChildren(view(a)))
      .catch((err) => {
        toastError("Couldn't load analytics", err.message);
        content.replaceChildren(
          emptyState({
            iconName: "alert-circle",
            title: "Couldn't load analytics",
            body: err.message,
            action: button({ label: "Retry", onClick: load }),
          })
        );
      });
  }

  function view(a) {
    const totalMT = a.totals.liquidMT + a.totals.dryMT;

    const head = h(
      "div.page-head",
      h(
        "div.page-head__text",
        h("h1.h1", "Analytics"),
        h("p.page-head__desc", "Cargo throughput, product mix and revenue across the port · last 12 months.")
      )
    );

    const kpis = h(
      "div.kpi-strip",
      statCard({ label: "Total Throughput", value: `${fmtM(totalMT)} MT` }),
      statCard({ label: "Liquid Cargo", value: `${fmtM(a.totals.liquidMT)} MT` }),
      statCard({ label: "Dry / Bulk Cargo", value: `${fmtM(a.totals.dryMT)} MT` }),
      statCard({
        label: `${a.pms.abbr} Share of Cargo`,
        value: pct(a.pms.sharePct),
        foot: `${fmtM(a.pms.volumeMT)} MT of ${a.pms.name}`,
      })
    );

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
      { style: { marginBottom: "32px" } },
      h(
        "div.chart-card__head",
        h(
          "div.chart-card__titles",
          h("h2.card__title", "Monthly throughput"),
          h(
            "div.chart-card__sub",
            h("strong", `${fmtM(a.totals.liquidMT)} MT liquid`),
            ` · ${fmtM(a.totals.dryMT)} MT dry`
          )
        )
      ),
      legend,
      areaChart({
        labels: a.labels,
        series: [
          { values: a.liquid, stroke: LIQUID_STROKE, fill: LIQUID_FILL },
          { values: a.dry, stroke: DRY_STROKE, fill: DRY_FILL },
        ],
        height: 300,
        ariaLabel: "Monthly cargo throughput, liquid versus dry",
      })
    );

    const productsCard = h(
      "div.card",
      h("div.card__head", h("h2.card__title", "Product mix · last 12 months")),
      dataTable({
        flush: true,
        rows: a.products,
        columns: [
          {
            key: "name",
            label: "Product",
            render: (r) =>
              h(
                "div",
                h("div.cell-primary", r.abbr),
                h("div.cell-sub", r.name)
              ),
          },
          { key: "category", label: "Category", render: (r) => cargoTag(r.category) },
          {
            key: "volumeMT",
            label: "Volume (MT)",
            align: "num",
            sortable: true,
            render: (r) => h("span.figure", num(r.volumeMT)),
          },
          {
            key: "sharePct",
            label: "Share",
            align: "num",
            sortable: true,
            render: (r) => h("span.figure", pct(r.sharePct)),
          },
          {
            key: "revenueUSD",
            label: "Revenue (USD)",
            align: "num",
            sortable: true,
            render: (r) => h("span.money", `$${num(r.revenueUSD)}`),
          },
        ],
      })
    );

    return h("div", head, kpis, chartCard, productsCard);
  }

  function loadingView() {
    return h(
      "div",
      h(
        "div.page-head",
        h("div.page-head__text", h("h1.h1", "Analytics"), h("p.page-head__desc", "Loading…"))
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
        "div.card.card--pad",
        h("span.skeleton", { style: { width: "40%" } }),
        h("span.skeleton", { style: { width: "100%", height: "260px", marginTop: "16px" } })
      )
    );
  }

  load();
}
