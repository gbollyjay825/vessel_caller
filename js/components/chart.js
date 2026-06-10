/* ============================================================
   chart.js — dependency-free inline-SVG charts.

   areaChart(): layered area chart (liquid over dry) used on the
   dashboard and analytics screens. sparkline(): the small white
   trend area inside the PMS highlight card.
   ============================================================ */

const SVG_NS = "http://www.w3.org/2000/svg";

function el(name, attrs = {}) {
  const node = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}

/** Map series values to "x,y" point strings inside the plot box. */
function points(values, max, box) {
  const { x, y, w, hgt } = box;
  const stepX = w / (values.length - 1);
  return values.map((v, i) => {
    const px = x + i * stepX;
    const py = y + hgt - (v / max) * hgt;
    return `${px.toFixed(1)},${py.toFixed(1)}`;
  });
}

/**
 * areaChart({ labels, series, height })
 *  labels: x-axis labels (one per point)
 *  series: [{ values, stroke, fill }] — drawn in order, later on top
 *  height: viewBox height (default 260)
 * Scales to its container via viewBox + width:100%.
 */
export function areaChart({ labels = [], series = [], height = 260, ariaLabel = "Area chart" }) {
  const W = 720;
  const H = height;
  const pad = { top: 12, right: 8, bottom: 26, left: 8 };
  const box = { x: pad.left, y: pad.top, w: W - pad.left - pad.right, hgt: H - pad.top - pad.bottom };

  const max = Math.max(...series.flatMap((s) => s.values)) * 1.15 || 1;

  const svg = el("svg", {
    viewBox: `0 0 ${W} ${H}`,
    width: "100%",
    height: "auto",
    role: "img",
    "aria-label": ariaLabel,
    fill: "none",
  });

  // soft horizontal gridlines
  for (let i = 1; i <= 3; i++) {
    const gy = box.y + (box.hgt / 4) * i;
    svg.appendChild(
      el("line", { x1: box.x, y1: gy, x2: box.x + box.w, y2: gy, stroke: "#eef0f3", "stroke-width": "1" })
    );
  }

  const baseline = box.y + box.hgt;
  for (const s of series) {
    const pts = points(s.values, max, box);
    svg.appendChild(
      el("polygon", {
        points: `${box.x},${baseline} ${pts.join(" ")} ${box.x + box.w},${baseline}`,
        fill: s.fill,
      })
    );
    svg.appendChild(
      el("polyline", {
        points: pts.join(" "),
        stroke: s.stroke,
        "stroke-width": "2",
        "stroke-linejoin": "round",
        "stroke-linecap": "round",
      })
    );
  }

  // x labels
  const stepX = box.w / (labels.length - 1);
  labels.forEach((lab, i) => {
    const t = el("text", {
      x: box.x + i * stepX,
      y: H - 6,
      "text-anchor": i === 0 ? "start" : i === labels.length - 1 ? "end" : "middle",
      "font-size": "11",
      "font-family": "inherit",
      fill: "#66707e",
    });
    t.textContent = lab;
    svg.appendChild(t);
  });

  return svg;
}

/** Small white-on-accent trend area for the PMS highlight card. */
export function sparkline({ values = [], height = 72, ariaLabel = "Trend" }) {
  const W = 400;
  const H = height;
  const box = { x: 0, y: 6, w: W, hgt: H - 8 };
  const max = Math.max(...values) * 1.1 || 1;
  const pts = points(values, max, box);

  const svg = el("svg", {
    viewBox: `0 0 ${W} ${H}`,
    width: "100%",
    height: "auto",
    role: "img",
    "aria-label": ariaLabel,
    fill: "none",
    preserveAspectRatio: "none",
  });
  svg.appendChild(
    el("polygon", {
      points: `0,${H} ${pts.join(" ")} ${W},${H}`,
      fill: "rgba(255,255,255,0.22)",
    })
  );
  svg.appendChild(
    el("polyline", {
      points: pts.join(" "),
      stroke: "rgba(255,255,255,0.9)",
      "stroke-width": "2",
    })
  );
  return svg;
}
