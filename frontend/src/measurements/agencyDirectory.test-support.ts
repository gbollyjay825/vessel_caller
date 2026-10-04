import { vi } from "vitest";

// Node's global storage may shadow jsdom's implementation. Keep this test-only
// browser store isolated and restore the global after every test.
export function installTestAgencyStorage() {
  const values = new Map<string, string>();
  const storage: Storage = {
    get length() { return values.size; },
    clear() { values.clear(); },
    getItem(key) { return values.get(key) ?? null; },
    key(index) { return [...values.keys()][index] ?? null; },
    removeItem(key) { values.delete(key); },
    setItem(key, value) { values.set(key, String(value)); },
  };
  vi.stubGlobal("localStorage", storage);
}
