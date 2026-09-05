let authSessionEpoch = 0;
const AUTH_BOUNDARY_CHANNEL = "vessel-caller:auth-boundary";
const AUTH_BOUNDARY_STORAGE_KEY = "vessel-caller:auth-boundary-event";
const AUTH_BOUNDARY_MESSAGE_TYPE = "auth-boundary-v1";

export type AuthSessionBoundaryEvent =
  | { phase: "boundary" }
  | { phase: "start" | "settled"; transitionId: string };

type AuthBoundaryListener = (event: AuthSessionBoundaryEvent) => void;

const authBoundaryListeners = new Set<AuthBoundaryListener>();
let authBoundaryChannel: BroadcastChannel | null | undefined;
let storageListenerInstalled = false;

function parseBoundaryMessage(value: unknown): AuthSessionBoundaryEvent | null {
  if (!value || typeof value !== "object" || !("type" in value)) return null;
  if (value.type !== AUTH_BOUNDARY_MESSAGE_TYPE || !("phase" in value)) return null;
  if (value.phase === "boundary") return { phase: "boundary" };
  if (
    (value.phase === "start" || value.phase === "settled")
    && "transitionId" in value
    && typeof value.transitionId === "string"
    && value.transitionId.length > 0
  ) {
    return { phase: value.phase, transitionId: value.transitionId };
  }
  return null;
}

function receiveAuthBoundary(value: unknown): void {
  const event = parseBoundaryMessage(value);
  if (!event) return;
  advanceAuthSessionEpoch();
  authBoundaryListeners.forEach((listener) => listener(event));
}

function ensureAuthBoundaryTransport(): BroadcastChannel | null {
  if (authBoundaryChannel !== undefined) return authBoundaryChannel;
  if (typeof globalThis.BroadcastChannel === "function") {
    authBoundaryChannel = new globalThis.BroadcastChannel(AUTH_BOUNDARY_CHANNEL);
    authBoundaryChannel.addEventListener("message", (event) => receiveAuthBoundary(event.data));
    return authBoundaryChannel;
  }
  authBoundaryChannel = null;
  if (!storageListenerInstalled && typeof window !== "undefined") {
    window.addEventListener("storage", receiveStorageBoundary);
    storageListenerInstalled = true;
  }
  return null;
}

function receiveStorageBoundary(event: StorageEvent): void {
  if (event.key !== AUTH_BOUNDARY_STORAGE_KEY || !event.newValue) return;
  try {
    receiveAuthBoundary(JSON.parse(event.newValue));
  } catch {
    // Ignore malformed/unrelated localStorage values.
  }
}

export function currentAuthSessionEpoch(): number {
  return authSessionEpoch;
}

export function advanceAuthSessionEpoch(): number {
  authSessionEpoch += 1;
  return authSessionEpoch;
}

export function publishAuthSessionBoundary(notifyLocal = false): number {
  const epoch = advanceAuthSessionEpoch();
  const message = {
    type: AUTH_BOUNDARY_MESSAGE_TYPE,
    phase: "boundary",
    // This event intentionally carries no user, organization, or session data.
    nonce: typeof globalThis.crypto?.randomUUID === "function"
      ? globalThis.crypto.randomUUID()
      : `${Date.now()}-${Math.random()}`,
  };
  const channel = ensureAuthBoundaryTransport();
  if (channel) {
    channel.postMessage(message);
  } else if (typeof globalThis.localStorage !== "undefined") {
    try {
      globalThis.localStorage.setItem(AUTH_BOUNDARY_STORAGE_KEY, JSON.stringify(message));
      globalThis.localStorage.removeItem(AUTH_BOUNDARY_STORAGE_KEY);
    } catch {
      // Session safety in this tab still relies on the epoch when storage is unavailable.
    }
  }
  if (notifyLocal) authBoundaryListeners.forEach((listener) => listener({ phase: "boundary" }));
  return epoch;
}

function publishTransitionMessage(
  phase: "start" | "settled",
  transitionId: string,
): number {
  const epoch = advanceAuthSessionEpoch();
  const message = { type: AUTH_BOUNDARY_MESSAGE_TYPE, phase, transitionId };
  const channel = ensureAuthBoundaryTransport();
  if (channel) {
    channel.postMessage(message);
  } else if (typeof globalThis.localStorage !== "undefined") {
    try {
      globalThis.localStorage.setItem(AUTH_BOUNDARY_STORAGE_KEY, JSON.stringify(message));
      globalThis.localStorage.removeItem(AUTH_BOUNDARY_STORAGE_KEY);
    } catch {
      // The local epoch still prevents pre-transition responses from committing.
    }
  }
  return epoch;
}

export function publishAuthSessionTransitionStart(): string {
  const transitionId = typeof globalThis.crypto?.randomUUID === "function"
    ? globalThis.crypto.randomUUID()
    : `${Date.now()}-${Math.random()}`;
  publishTransitionMessage("start", transitionId);
  return transitionId;
}

export function publishAuthSessionTransitionSettled(transitionId: string): number {
  return publishTransitionMessage("settled", transitionId);
}

export function subscribeAuthSessionBoundary(listener: AuthBoundaryListener): () => void {
  authBoundaryListeners.add(listener);
  ensureAuthBoundaryTransport();
  return () => authBoundaryListeners.delete(listener);
}

export function resetAuthSessionEpochForTests(): void {
  authSessionEpoch = 0;
  authBoundaryListeners.clear();
  authBoundaryChannel?.close();
  authBoundaryChannel = undefined;
  if (storageListenerInstalled && typeof window !== "undefined") {
    window.removeEventListener("storage", receiveStorageBoundary);
    storageListenerInstalled = false;
  }
}
