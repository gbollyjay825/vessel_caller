import { describe, expect, it } from "vitest";

import { getPlatformEnvironment } from "./environment";

describe("getPlatformEnvironment", () => {
  it.each([
    ["staging.vesselcalls.com", "staging", "Staging"],
    ["STAGING.VESSELCALLS.COM.", "staging", "Staging"],
    ["vesselcalls.com", "production", "Production"],
    ["www.vesselcalls.com", "production", "Production"],
    ["localhost", "development", "Local development"],
    ["127.0.0.1", "development", "Local development"],
  ] as const)("classifies %s without build-time configuration", (hostname, kind, label) => {
    expect(getPlatformEnvironment(null, hostname)).toMatchObject({ kind, label });
  });

  it("does not mistake an unrecognized or lookalike hostname for production", () => {
    expect(getPlatformEnvironment(null, "preview.vesselcalls.com")).toMatchObject({
      kind: "unknown",
      label: "Unknown environment",
    });
    expect(getPlatformEnvironment(null, "vesselcalls.com.example.test")).toMatchObject({
      kind: "unknown",
      label: "Unknown environment",
    });
  });

  it("cross-checks hosted runtime identity and fails closed on an unknown value", () => {
    expect(getPlatformEnvironment("production", "staging.vesselcalls.com")).toMatchObject({
      kind: "unknown",
      label: "Unknown environment",
    });
    expect(getPlatformEnvironment("staging", "staging.vesselcalls.com")).toMatchObject({
      kind: "staging",
      label: "Staging",
    });
    expect(getPlatformEnvironment("development", "vesselcalls.com")).toMatchObject({
      kind: "unknown",
      label: "Unknown environment",
    });
    expect(getPlatformEnvironment("test", "staging.vesselcalls.com")).toMatchObject({
      kind: "unknown",
      label: "Unknown environment",
    });
    expect(getPlatformEnvironment("preview", "vesselcalls.com")).toMatchObject({
      kind: "unknown",
      label: "Unknown environment",
    });
  });
});
