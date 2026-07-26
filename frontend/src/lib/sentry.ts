import * as Sentry from "@sentry/react";
import type { Breadcrumb, Event } from "@sentry/react";

const REDACTED = "[REDACTED]";
const SENSITIVE_KEY =
  /(?:password|passcode|token|secret|authorization|headers?|cookie|mfa|otp|recovery|email|phone|address|payment|card|evidence|query_string)/i;
const EMAIL_VALUE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const BEARER_VALUE = /\bBearer\s+\S+/gi;
const JWT_VALUE = /\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g;

interface RuntimeMonitoringConfig {
  sentry: {
    dsn: string;
    environment: string;
    release: string;
  };
}

type SentryInitializer = (options: Parameters<typeof Sentry.init>[0]) => void;

export interface FrontendMonitoringDependencies {
  fetch?: typeof globalThis.fetch;
  initialize?: SentryInitializer;
  timeoutMs?: number;
}

function redactString(value: string, key: string): string {
  const withoutSecrets = value
    .replace(EMAIL_VALUE, "[REDACTED_EMAIL]")
    .replace(BEARER_VALUE, "Bearer [REDACTED]")
    .replace(JWT_VALUE, REDACTED);
  return key.toLowerCase() === "url" ? withoutSecrets.replace(/[?#].*$/, "") : withoutSecrets;
}

function redactValue(value: unknown, key = "", seen = new WeakSet<object>()): unknown {
  if (SENSITIVE_KEY.test(key)) return REDACTED;
  if (typeof value === "string") return redactString(value, key);
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return REDACTED;

  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, "", seen));
  }

  const redacted: Record<string, unknown> = {};
  Object.entries(value).forEach(([childKey, childValue]) => {
    redacted[childKey] = redactValue(childValue, childKey, seen);
  });
  return redacted;
}

export function redactSentryEvent<T extends Event>(event: T): T {
  const redacted = redactValue(event) as T;
  // Never attach an actor identity from SDK defaults or a future setUser call.
  redacted.user = undefined;
  return redacted;
}

export function redactSentryBreadcrumb(breadcrumb: Breadcrumb): Breadcrumb {
  return redactValue(breadcrumb) as Breadcrumb;
}

function parseRuntimeConfig(value: unknown): RuntimeMonitoringConfig | null {
  if (value === null || typeof value !== "object") return null;
  const sentry = (value as { sentry?: unknown }).sentry;
  if (sentry === null || typeof sentry !== "object") return null;

  const { dsn, environment, release } = sentry as Record<string, unknown>;
  if (typeof dsn !== "string" || typeof environment !== "string" || typeof release !== "string") {
    return null;
  }

  const normalized = {
    dsn: dsn.trim(),
    environment: environment.trim(),
    release: release.trim(),
  };
  if (!normalized.dsn) {
    return { sentry: normalized };
  }
  if (!normalized.environment || !normalized.release) return null;

  try {
    const parsedDsn = new URL(normalized.dsn);
    if (
      parsedDsn.protocol !== "https:"
      || !parsedDsn.username
      || !parsedDsn.hostname
      || parsedDsn.pathname === "/"
    ) {
      return null;
    }
  } catch {
    return null;
  }

  return { sentry: normalized };
}

export async function initializeFrontendMonitoring(
  dependencies: FrontendMonitoringDependencies = {},
): Promise<boolean> {
  const fetchRuntimeConfig = dependencies.fetch ?? globalThis.fetch?.bind(globalThis);
  if (!fetchRuntimeConfig) return false;

  const controller = new AbortController();
  const timeout = globalThis.setTimeout(() => controller.abort(), dependencies.timeoutMs ?? 2_000);
  let runtimeConfig: RuntimeMonitoringConfig;
  try {
    const response = await fetchRuntimeConfig("/api/runtime-config", {
      method: "GET",
      credentials: "same-origin",
      headers: { Accept: "application/json" },
      cache: "no-store",
      signal: controller.signal,
    });
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (!response.ok || !contentType.includes("application/json")) return false;
    const parsedRuntimeConfig = parseRuntimeConfig(await response.json());
    if (!parsedRuntimeConfig) return false;
    runtimeConfig = parsedRuntimeConfig;
  } catch {
    return false;
  } finally {
    globalThis.clearTimeout(timeout);
  }
  if (!runtimeConfig.sentry.dsn) return false;

  const { dsn, environment, release } = runtimeConfig.sentry;
  (dependencies.initialize ?? Sentry.init)({
    dsn,
    environment,
    release,
    sendDefaultPii: false,
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: { request: false, response: false },
      httpBodies: [],
      urlQueryParams: false,
      graphQL: { document: false, variables: false },
      genAI: { inputs: false, outputs: false },
      databaseQueryData: false,
      stackFrameVariables: false,
      frameContextLines: 0,
    },
    integrations: (defaults) => defaults.filter((integration) => integration.name !== "Replay"),
    beforeSend: redactSentryEvent,
    beforeBreadcrumb: redactSentryBreadcrumb,
    tracesSampleRate: 0,
    profilesSampleRate: 0,
    profileSessionSampleRate: 0,
    replaysSessionSampleRate: 0,
    replaysOnErrorSampleRate: 0,
  });
  return true;
}
