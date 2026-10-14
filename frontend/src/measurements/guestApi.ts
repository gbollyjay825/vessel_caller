import type { GuestPortalContext, GuestReadingInput } from "./guestTypes";

export type { GuestPortalContext } from "./guestTypes";
export class GuestPortalError extends Error {
  constructor(message: string, public status: number) { super(message); this.name = "GuestPortalError"; }
}
const ROOT = "/api/agency-portal";
const base = (import.meta.env.VITE_API_BASE ?? "").replace(/\/$/, "");
const withContext = (path: string, contextId?: string) => `${ROOT}/${path}${contextId ? `?${new URLSearchParams({ contextId })}` : ""}`;

export function createGuestAgencyApi(fetcher: typeof fetch = (...args) => globalThis.fetch(...args)) {
  const send = async (path: string, options: RequestInit = {}) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await fetcher(base + path, { ...options, credentials: "same-origin", cache: "no-store", referrerPolicy: "no-referrer", signal: controller.signal, headers: { Accept: "application/json", ...options.headers } });
      if (!response.ok) {
        const raw = await response.json().catch(() => ({})) as unknown;
        const body = raw && typeof raw === "object" ? raw as { detail?: string; error?: string } : {};
        const message = response.status === 404 ? "Agency reading links are not available on this environment yet." : typeof body.detail === "string" ? body.detail : typeof body.error === "string" ? body.error : `The agency request could not be completed (${response.status}).`;
        throw new GuestPortalError(message, response.status);
      }
      return response;
    } catch (failure) {
      if (failure instanceof GuestPortalError) throw failure;
      throw new GuestPortalError("The agency request could not be confirmed. Check your connection and try again.", 0);
    } finally { clearTimeout(timeout); }
  };
  const json = async <T,>(path: string, options?: RequestInit): Promise<T> => {
    const response = await send(path, options);
    try { return await response.json() as T; }
    catch { throw new GuestPortalError("The agency service returned an unreadable response.", 502); }
  };
  const post = async <T,>(path: string, body: unknown): Promise<T> => {
    const { csrfToken } = await json<{ csrfToken: string }>(`${ROOT}/csrf`);
    if (!csrfToken) throw new GuestPortalError("Could not establish a secure agency session. Reopen your agency link.", 403);
    return json<T>(path, { method: "POST", headers: { "Content-Type": "application/json", "X-CSRFToken": csrfToken }, body: JSON.stringify(body) });
  };
  const readContext = async (contextId?: string): Promise<GuestPortalContext> => {
    const body = await json<{ context: GuestPortalContext }>(withContext("context", contextId));
    if (!body?.context?.contextId || !body.context.agency?.id || !Array.isArray(body.context.lines) || !Array.isArray(body.context.completedPeers) || typeof body.context.inputFingerprint !== "string") throw new GuestPortalError("The agency service returned an incomplete form. Reopen your agency link.", 502);
    if (contextId && body.context.contextId !== contextId) throw new GuestPortalError("This session no longer matches your agency link. Reopen the original link.", 403);
    return body.context;
  };
  return {
    exchange: async (token: string): Promise<string> => {
      const body = await post<{ contextId: string }>(`${ROOT}/exchange`, { token });
      if (!body.contextId || typeof body.contextId !== "string") throw new GuestPortalError("The agency link could not be opened. Ask the voyage coordinator for a new link.", 502);
      return body.contextId;
    },
    context: readContext,
    submit: async (context: GuestPortalContext, requestId: string, input: GuestReadingInput): Promise<GuestPortalContext> => {
      try {
        const result = await post<{ context: GuestPortalContext }>(`${ROOT}/submission`, { ...input, contextId: context.contextId, requestId, inputFingerprint: context.inputFingerprint });
        if (result?.context?.contextId !== context.contextId || result.context.agency?.id !== context.agency.id) throw new GuestPortalError("This session no longer matches your agency link. Reopen the original link.", 403);
        if (result.context.ownReport?.status !== "submitted" || result.context.ownReport.participantId !== context.agency.id || !Array.isArray(result.context.lines) || !Array.isArray(result.context.completedPeers)) throw new GuestPortalError("The agency service did not confirm your submitted report.", 502);
        return result.context;
      } catch (failure) {
        // A lost POST response may still have committed. Read only this context
        // before offering a retry; never replace it with another tab's agency.
        if (failure instanceof GuestPortalError && (failure.status === 0 || failure.status >= 500)) {
          try {
            const recovered = await readContext(context.contextId);
            if (recovered.agency.id === context.agency.id && recovered.ownReport?.status === "submitted" && recovered.ownReport.participantId === context.agency.id) return recovered;
          } catch { /* Preserve the original uncertain submission error. */ }
        }
        throw failure;
      }
    },
    receipt: async (contextId: string): Promise<Blob> => {
      const response = await send(withContext("receipt", contextId), { headers: { Accept: "application/pdf" } });
      if (!response.headers.get("content-type")?.toLowerCase().includes("application/pdf")) throw new GuestPortalError("The agency service did not return a PDF. Please try again.", 502);
      return response.blob();
    },
  };
}
export const guestAgencyApi = createGuestAgencyApi();

export function createGuestSubmissionAttempt() {
  let previous: { body: string; requestId: string } | null = null;
  return (context: GuestPortalContext, input: GuestReadingInput): string => {
    const body = JSON.stringify([context.contextId, context.inputFingerprint, input]);
    if (previous?.body === body) return previous.requestId;
    previous = { body, requestId: crypto.randomUUID() };
    return previous.requestId;
  };
}
