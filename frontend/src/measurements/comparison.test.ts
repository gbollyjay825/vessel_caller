import { describe, expect, it } from "vitest";
import { quantityDifference, readingQuantity, tallyResult } from "./comparison";

describe("declared and measured cargo comparison", () => {
  it("keeps unknown, NIL and non-zero quantities distinct", () => {
    expect(readingQuantity(null)).toBe("Not provided");
    expect(readingQuantity("0.000")).toBe("NIL (0)");
    expect(readingQuantity("19508.250")).toBe("19,508.25");
    expect(tallyResult(null, "0").status).toBe("unknown");
    expect(tallyResult("0", "0.000").status).toBe("tallies");
  });
  it("compares decimal readings without rounding away a difference", () => {
    expect(quantityDifference("19508", "19500")).toBe("+8");
    expect(quantityDifference("0.2", "0.3")).toBe("-0.1");
    expect(quantityDifference("178", "178.000")).toBe("0");
    expect(tallyResult("535", "534")).toEqual({ status: "above", label: "Above declaration", difference: "+1" });
    expect(tallyResult("534", "535").status).toBe("below");
  });
  it("retains exact values at the API maximum precision", () => {
    expect(quantityDifference("999999999999999.999", "999999999999999.998")).toBe("+0.001");
    expect(readingQuantity("999999999999999.999")).toBe("999,999,999,999,999.999");
  });
  it("compares valid number-input notation and keeps negative zero as NIL", () => {
    expect(quantityDifference(".5", "1")).toBe("-0.5");
    expect(quantityDifference("1e3", "999.999")).toBe("+0.001");
    expect(quantityDifference("2.5e-3", ".002")).toBe("+0.0005");
    expect(readingQuantity("-0")).toBe("NIL (0)");
    expect(readingQuantity("1e10000")).toBe("Not provided");
  });
  it("does not treat incomplete input or a missing declaration as zero", () => {
    for (const value of [undefined, null, "", "1.", "invalid", "-1"]) {
      expect(quantityDifference(value, "1")).toBeNull();
      expect(tallyResult("1", value).status).toBe("unknown");
    }
  });
});
