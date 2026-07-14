// Formatters + small domain helpers (ported from the prototype's data.jsx).
import type { Invoice, Organization } from "../types";

export function fmtUSD(n: number | null | undefined, dp = 2): string {
  if (n == null || isNaN(n)) return "—";
  return "$" + Number(n).toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });
}
export function fmtNGN(n: number | null | undefined): string {
  if (n == null || isNaN(n)) return "—";
  return "₦" + Math.round(Number(n)).toLocaleString("en-US");
}
export function fmtNum(n: number | null | undefined, dp = 0): string {
  if (n == null || isNaN(n)) return "—";
  return Number(n).toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });
}
export function fmtTons(n: number | null | undefined): string {
  return n == null || isNaN(n) ? "—" : fmtNum(n, 2) + " MTS";
}
export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}
export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return (
    d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }) +
    " · " + d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })
  );
}
export function fmtCompactMT(n: number): string {
  if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(0) + "K";
  return String(Math.round(n));
}
export function fmtCompactUSD(n: number): string {
  if (n >= 1e6) return "$" + (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return "$" + (n / 1e3).toFixed(0) + "K";
  return "$" + Math.round(n);
}

export function userInitials(name: string): string {
  return (
    String(name || "?").trim().split(/\s+/).slice(0, 2).map((p) => p[0] || "").join("").toUpperCase() || "?"
  );
}

export function effectiveInvoiceStatus(inv: Invoice | null): "paid" | "unpaid" | "overdue" {
  if (!inv) return "unpaid";
  if (inv.status === "paid") return "paid";
  if (inv.due && new Date(inv.due + "T23:59:59") < new Date()) return "overdue";
  return "unpaid";
}

export function orgPorts(org: Organization | null | undefined, fallback = "Port of Calabar"): string[] {
  const ports = org?.ports?.length ? org.ports : [org?.designatedPort || fallback];
  return ports.filter(Boolean);
}
export function orgPortsLabel(org: Organization | null | undefined, fallback = "Port of Calabar"): string {
  const ports = orgPorts(org, fallback);
  if (ports.length <= 1) return ports[0] || fallback;
  return `${ports[0]} +${ports.length - 1} more`;
}
