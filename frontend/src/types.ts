// Domain model — mirrors the API's camelCase JSON (see backend app/services.py).

export type Role = "Admin" | "Operations" | "Finance" | "Viewer";
export const ROLES: Role[] = ["Admin", "Operations", "Finance", "Viewer"];

export interface RoleDefinition {
  role: Role;
  permissions: string[];
}

export type UserStatus = "invited" | "active" | "suspended" | "removed";

export interface User {
  id: string;
  name: string;
  email: string;
  role: Role;
  status: UserStatus;
  active?: boolean;
  emailVerified: boolean;
  mfaEnabled: boolean;
  mfaRequired: boolean;
  mfaEnrollmentRequired?: boolean;
  mfaGraceEndsAt?: string | null;
  lastLogin?: string | null;
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
  members?: Member[];
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
}

export type CallStatus = "pending" | "in-progress" | "completed" | "cancelled";
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
  cancellationReason?: string | null;
  cancelledAt?: string | null;
  version: number;
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
  status: "draft" | "completed" | "cancelled";
  version: number;
  createdAt?: string | null;
  updatedAt?: string | null;
}

export interface Payment {
  id: string;
  amount: number;
  paidOn: string;
  method: string;
  reference: string;
  recordedBy: string;
  recordedAt: string;
  reversedAt?: string | null;
  reversedBy?: string | null;
  reversalReason?: string | null;
}
export type InvoiceStatus = "paid" | "unpaid" | "void";
export type EffectiveInvoiceStatus = "paid" | "unpaid" | "overdue" | "void";
export interface InvoiceWorkflowStatus {
  id: string | null; code: string; label: string; position: number | null; active: boolean;
  isPaid: boolean; isTerminal: boolean; isProtected: boolean;
  notifyOnEntry: boolean; notificationRoles: Role[];
}
export interface InvoiceWorkflowStatusUpdate {
  label?: string;
  active?: boolean;
  notifyOnEntry?: boolean;
  notificationRoles?: Role[];
}
export interface InvoiceStatusEvent {
  id: string; fromCode?: string | null; fromLabel?: string | null; toCode: string; toLabel: string;
  source: string; note?: string | null; actorId?: string | null; actorName?: string | null; createdAt: string;
}
export interface InvoiceAttachment {
  id: string; invoiceId: string; fileName: string; contentType: string; size: number;
  checksum: string; uploadedBy: string; createdAt: string;
}
export interface Invoice {
  id: string;
  invoiceNo: string;
  callId: string;
  inspectionId: string | null;
  cargoType: string;
  issued: string;
  due: string;
  status: InvoiceStatus;
  workflowStatus?: InvoiceWorkflowStatus;
  statusHistory?: InvoiceStatusEvent[];
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
  invoiceStatusSteps?: InvoiceWorkflowStatus[];
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

export interface AuthSession {
  user: User;
  org: Organization;
  permissions: string[];
}

export interface Paginated<T> {
  results: T[];
  count: number;
  page: number;
  pageSize: number;
}

export type InvitationStatus = "pending" | "accepted" | "expired" | "revoked";
export interface Invitation {
  id: string;
  name: string;
  email: string;
  role: Role;
  status: InvitationStatus;
  invitedBy?: Pick<User, "id" | "name" | "email"> | null;
  expiresAt: string;
  createdAt: string;
  acceptedAt?: string | null;
}

export interface AuditEvent {
  id: string;
  action: string;
  actor?: Pick<User, "id" | "name" | "email"> | null;
  targetType?: string | null;
  targetId?: string | null;
  targetLabel?: string | null;
  category?: string | null;
  requestId?: string | null;
  ipAddress?: string | null;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  occurredAt: string;
}

export interface Profile {
  id: string;
  name: string;
  email: string;
  pendingEmail?: string | null;
  role: Role;
  emailVerified: boolean;
  mfaEnabled: boolean;
  mfaRequired: boolean;
  mfaEnrollmentRequired?: boolean;
  mfaGraceEndsAt?: string | null;
}

export interface DeviceSession {
  id: string;
  current: boolean;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  ipAddress?: string | null;
  userAgent?: string | null;
}
