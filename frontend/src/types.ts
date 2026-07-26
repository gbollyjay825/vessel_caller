// Domain model — mirrors the API's camelCase JSON (see backend app/services.py).

export type Role = "Admin" | "Operations" | "Finance" | "Viewer";
export const ROLES: Role[] = ["Admin", "Operations", "Finance", "Viewer"];

export interface User {
  id: string;
  name: string;
  email: string;
  role: Role;
  active: boolean;
  createdAt?: string | null;
}
export type Member = User;

export interface Organization {
  id: string;
  registered: boolean;
  name: string;
  rcNumber: string;
  email: string;
  phone: string;
  address: string;
  designatedPort: string;
  primaryPort: string;
  ports: string[];
  logo: string | null;
  rev: number;
  members: Member[];
}

export interface Jetty {
  type: "International" | "Local" | string;
  category?: string | null;
  name?: string;
}

export interface Settings {
  commissionRate: number;
  exchangeRate: number;
  liquidDuesRates: { government: number; private: number; international: number };
  dryDuesRate: number;
  portName: string;
  terminals: string[];
  smtp: Record<string, unknown> | null;
  sms: Record<string, unknown> | null;
}

export type CallStatus = "pending" | "in-progress" | "completed";
export interface VesselCall {
  id: string;
  vesselName: string;
  reference: string;
  type: string;
  flag: string;
  nrt: number;
  eta: string;
  sailingEta: string;
  berth: string;
  berthDate: string | null;
  status: CallStatus;
  notes: string;
  registered: string;
}

export type CargoType = "Liquid" | "Dry";
export interface Inspection {
  id: string;
  reference: string;
  callId: string;
  vesselName: string;
  cargoType: CargoType;
  product: string | null;
  reconciledTonnage: number;
  jetty: Jetty | null;
  liquid: Record<string, unknown> | null;
  dry: Record<string, unknown> | null;
  date: string;
  status: "draft" | "completed";
}

export interface Payment {
  paidOn: string;
  method: string;
  reference: string;
  amount: number;
  recordedBy: string;
}
export type InvoiceStatus = "paid" | "unpaid";
export type EffectiveInvoiceStatus = "paid" | "unpaid" | "overdue";
export interface Invoice {
  id: string;
  invoiceNo: string;
  callId: string;
  inspectionId: string | null;
  cargoType: string;
  issued: string;
  due: string;
  status: InvoiceStatus;
  dues: number;
  rate: number;
  commissionUsd: number;
  commissionNgn: number;
  fx: number;
  payment: Payment | null;
}

export interface AppState {
  rev: number;
  org: Organization;
  settings: Settings;
  calls: VesselCall[];
  inspections: Inspection[];
  invoices: Invoice[];
}

export interface AnalyticsSeriesRow {
  key: string;
  month: string;
  year: string;
  liquidT: number;
  dryT: number;
  revenue: number;
  calls: number;
}
export interface AnalyticsProduct {
  key: string;
  name: string;
  tonnage: number;
  share: number;
  revenue: number;
}
export interface AnalyticsTotals {
  throughput: number;
  liquidT: number;
  dryT: number;
  revenue: number;
  liquidR: number;
  dryR: number;
  invoiced: number;
  collected: number;
  outstanding: number;
  calls: number;
}
export interface Analytics {
  series: AnalyticsSeriesRow[];
  products: AnalyticsProduct[];
  totals: AnalyticsTotals;
}

export interface Session {
  token: string;
  user: User;
  org?: Organization;
}
