import { useEffect, useRef, useState } from "react";
import { GuestAgencyReading } from "./GuestAgencyReading";
import { createGuestSubmissionAttempt, guestAgencyApi, GuestPortalError, type GuestPortalContext } from "./guestApi";
import type { GuestReadingInput } from "./guestTypes";

async function openAgencyContext(): Promise<GuestPortalContext> {
  const address = new URL(window.location.href);
  const token = new URLSearchParams(address.hash.slice(1)).get("token") ?? "";
  address.hash = "";
  // The secret is removed before the first network await. Only the non-secret
  // context identifier is retained so reloads cannot silently switch agencies.
  window.history.replaceState(window.history.state, "", address.pathname + address.search);
  let contextId = address.searchParams.get("contextId") ?? undefined;
  if (token) {
    contextId = await guestAgencyApi.exchange(token);
    address.searchParams.set("contextId", contextId);
    window.history.replaceState(window.history.state, "", address.pathname + address.search);
  }
  const context = await guestAgencyApi.context(contextId);
  if (!contextId) {
    address.searchParams.set("contextId", context.contextId);
    window.history.replaceState(window.history.state, "", address.pathname + address.search);
  }
  return context;
}

export function AgencyReadingPage() {
  const [context, setContext] = useState<GuestPortalContext | null>(null);
  const [error, setError] = useState<string | null>(null);
  const opening = useRef<Promise<GuestPortalContext> | null>(null);
  const attempt = useRef<ReturnType<typeof createGuestSubmissionAttempt> | null>(null);
  if (!attempt.current) attempt.current = createGuestSubmissionAttempt();
  useEffect(() => {
    let active = true;
    // StrictMode replays this effect. Share the opening request so a single-use
    // exchange is not repeated and the fragment need not be stored anywhere.
    opening.current ??= openAgencyContext();
    void opening.current.then(value => { if (active) { setContext(value); setError(null); } }, failure => { if (active) setError(failure instanceof Error ? failure.message : "This agency link could not be opened."); });
    return () => { active = false; };
  }, []);
  const submit = async (input: GuestReadingInput) => {
    if (!context) throw new GuestPortalError("Reopen your agency link before submitting.", 403);
    const requestId = attempt.current!(context, input);
    const next = await guestAgencyApi.submit(context, requestId, input);
    setContext(next);
    return next;
  };
  const download = async (reportId: string) => {
    if (!context?.ownReport || context.ownReport.id !== reportId || context.ownReport.participantId !== context.agency.id) throw new GuestPortalError("Only your own submitted report can be downloaded from this link.", 403);
    const blob = await guestAgencyApi.receipt(context.contextId);
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url; anchor.download = `agency-report-${reportId.replace(/[^a-zA-Z0-9_-]/g, "")}.pdf`; anchor.rel = "noreferrer";
    document.body.append(anchor); anchor.click(); anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  if (context) return <>{context.uiPreview && <div className="guest-preview-notice" role="note">UI preview · sample data only. Secure agency links and report storage are not connected in this preview.</div>}<GuestAgencyReading context={context} onSubmit={submit} onDownloadReport={download} /></>;
  return <main className="guest-reading-page"><div className="guest-reading-shell"><div className="guest-reading-brand">Vessel Caller</div>{error ? <section className="guest-reading-card"><h1>Agency link unavailable</h1><p className="guest-reading-error" role="alert">{error}</p><p className="guest-reading-help">Reopen the original agency link, or ask the voyage coordinator for a current link. No account sign-in is required.</p></section> : <p role="status">Opening your agency reading form…</p>}</div></main>;
}
