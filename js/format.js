/* ============================================================
   format.js — display formatting. The UI never computes money;
   it only formats figures the (mock) API returns. Tabular,
   right-aligned numerics per spec §1.3.
   ============================================================ */

const usd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const grouped0 = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const grouped2 = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** "$53,137.44" */
export function money(n) {
  if (n == null || Number.isNaN(n)) return "—";
  return usd.format(n);
}

/** "₦2,975,696" — built manually so the ₦ glyph is guaranteed. */
export function naira(n) {
  if (n == null || Number.isNaN(n)) return "—";
  return "₦" + grouped0.format(Math.round(n));
}

/** Plain grouped number, optional decimals. */
export function num(n, decimals = 0) {
  if (n == null || Number.isNaN(n)) return "—";
  return decimals === 2 ? grouped2.format(n) : grouped0.format(n);
}

/** Tonnage with unit, e.g. "28,722.94 MT". */
export function tons(n, decimals = 2) {
  if (n == null || Number.isNaN(n)) return "—";
  return `${grouped2.format(n)} MT`;
}

/** "3.5%" — trims trailing zeros (3.5 → "3.5%", 3 → "3%"). */
export function pct(n) {
  if (n == null || Number.isNaN(n)) return "—";
  return `${+Number(n).toFixed(2)}%`;
}

/** "12 May 2026" */
export function date(iso) {
  if (!iso) return "—";
  const d = iso instanceof Date ? iso : new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(d);
}

/** "12 May 2026, 14:30" */
export function dateTime(iso) {
  if (!iso) return "—";
  const d = iso instanceof Date ? iso : new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(d);
}

/** Convert a Date to the value a <input type="datetime-local"> expects. */
export function toDateTimeLocal(d = new Date()) {
  const pad = (x) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours()
  )}:${pad(d.getMinutes())}`;
}

/** Initials from a full name, e.g. "Adaeze Okon" -> "AO". */
export function initials(name = "") {
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((p) => p[0] || "")
    .join("")
    .toUpperCase();
}

/** Human label for a status key. */
export function statusLabel(s) {
  return (
    {
      "pending": "Pending",
      "in-progress": "In progress",
      "completed": "Completed",
      "draft": "Draft",
      "paid": "Paid",
      "unpaid": "Unpaid",
      "overdue": "Overdue",
    }[s] || s
  );
}
