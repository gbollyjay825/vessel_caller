import { useCallback, useRef } from "react";

import { createIdempotencyKey } from "../lib/api";

/**
 * Keeps one key for retries of the same action payload. A changed payload is a
 * deliberate new action and receives a new key, avoiding ambiguous 409s.
 */
export function useIdempotencyKey() {
  const current = useRef<{ fingerprint: string; key: string } | null>(null);

  const keyFor = useCallback((payload: unknown) => {
    const fingerprint = JSON.stringify(payload);
    if (!current.current || current.current.fingerprint !== fingerprint) {
      current.current = { fingerprint, key: createIdempotencyKey() };
    }
    return current.current.key;
  }, []);

  const reset = useCallback(() => {
    current.current = null;
  }, []);

  return { keyFor, reset };
}
