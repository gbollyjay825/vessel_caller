export type PlatformEnvironmentKind = "staging" | "production" | "development" | "unknown";

export interface PlatformEnvironment {
  kind: PlatformEnvironmentKind;
  label: string;
  description: string;
}

function normalizedHostname(hostname: string): string {
  return hostname.trim().toLowerCase().replace(/\.$/, "");
}

/**
 * Prefer the backend's runtime environment. The exact deployment hostname is
 * a rolling-deploy fallback because the same frontend artifact is promoted
 * everywhere. Unknown values and hosts are never described as production.
 */
export function getPlatformEnvironment(
  runtimeEnvironment?: string | null,
  hostname = typeof window === "undefined" ? "" : window.location.hostname,
): PlatformEnvironment {
  const runtime = runtimeEnvironment?.trim().toLowerCase();
  const host = normalizedHostname(hostname);
  const hostedEnvironment = host === "staging.vesselcalls.com"
    ? "staging"
    : host === "vesselcalls.com" || host === "www.vesselcalls.com"
      ? "production"
      : null;
  if (runtime) {
    if (hostedEnvironment && hostedEnvironment !== runtime) return unknownEnvironment();
    if (runtime === "staging" || runtime === "production") {
      return runtime === "staging" ? stagingEnvironment() : productionEnvironment();
    }
    if (runtime === "development" || runtime === "local" || runtime === "test") {
      return developmentEnvironment();
    }
    return unknownEnvironment();
  }

  if (host === "staging.vesselcalls.com") {
    return stagingEnvironment();
  }

  if (host === "vesselcalls.com" || host === "www.vesselcalls.com") {
    return productionEnvironment();
  }

  if (host === "localhost" || host === "127.0.0.1" || host === "[::1]") {
    return developmentEnvironment();
  }

  return unknownEnvironment();
}

function stagingEnvironment(): PlatformEnvironment {
  return {
    kind: "staging",
    label: "Staging",
    description: "You are viewing staging organizations only. Production data and controls are separate.",
  };
}

function productionEnvironment(): PlatformEnvironment {
  return {
    kind: "production",
    label: "Production",
    description: "You are viewing production organizations only. Staging data and controls are separate.",
  };
}

function developmentEnvironment(): PlatformEnvironment {
  return {
    kind: "development",
    label: "Local development",
    description: "You are viewing local development data. Hosted staging and production are separate.",
  };
}

function unknownEnvironment(): PlatformEnvironment {
  return {
    kind: "unknown",
    label: "Unknown environment",
    description: "Confirm the address before making changes; this host is not a recognized Vessel Caller environment.",
  };
}
