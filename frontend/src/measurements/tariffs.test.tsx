import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { perUnitLabel, tariffKeyFor, tariffStorageKey, useVariationTariff, validRate } from "./tariffs";

const actor = { id: "admin", name: "NPA Admin" };

describe("variation tariff", () => {
  beforeEach(() => window.localStorage.clear());

  it("reads each rate per unit in plain words", () => {
    expect(perUnitLabel("tonnes")).toBe("per tonne");
    expect(perUnitLabel("m3")).toBe("per m³");
    expect(perUnitLabel("count", "40 ft laden containers")).toBe("per container");
    expect(perUnitLabel("count", "Vehicles")).toBe("per vehicle");
    expect(perUnitLabel("count", "Bags of rice")).toBe("per item");
  });

  it("maps cargo lines to tariff rates by size and load, product type and unit", () => {
    expect(tariffKeyFor({ category: "Container", containerSize: "40", loadStatus: "laden", unit: "count" })).toBe("container:40:laden");
    expect(tariffKeyFor({ category: "Container", containerSize: "", loadStatus: "laden", unit: "count" })).toBeNull();
    expect(tariffKeyFor({ category: "Liquid", containerSize: "", loadStatus: "", unit: "m3" })).toBe("liquid:m3");
    expect(tariffKeyFor({ category: "Bulk", containerSize: "", loadStatus: "", unit: "tonnes" })).toBe("bulk:tonnes");
    expect(tariffKeyFor({ category: "Vehicle", containerSize: "", loadStatus: "", unit: "count" })).toBe("vehicle:count");
  });

  it("accepts up to four decimal places and saves per organisation", () => {
    expect(validRate("12.3456")).toBe(true);
    expect(validRate("12.34567")).toBe(false);
    expect(validRate("-1")).toBe(false);
    const { result } = renderHook(() => useVariationTariff("org-1"));
    expect(() => result.current.save({ currency: "USD", reference: "T1", rates: { "bulk:tonnes": "abc" } }, actor)).toThrow(/dry bulk by weight rate/i);
    act(() => { result.current.save({ currency: "USD", reference: " Tariff 2026 ", rates: { "bulk:tonnes": "10" } }, actor); });
    expect(result.current.tariff).toMatchObject({ reference: "Tariff 2026", rates: { "bulk:tonnes": "10", "liquid:tonnes": "" }, updatedBy: actor });
    expect(renderHook(() => useVariationTariff("org-2")).result.current.tariff).toBeNull();
  });

  it("preserves an unreadable saved tariff and reports it", () => {
    window.localStorage.setItem(tariffStorageKey("org-1")!, "broken");
    const { result } = renderHook(() => useVariationTariff("org-1"));
    expect(result.current.tariff).toBeNull();
    expect(result.current.error).toMatch(/preserved/);
    expect(window.localStorage.getItem(tariffStorageKey("org-1")!)).toBe("broken");
  });
});
