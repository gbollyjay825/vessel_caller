import { useEffect, useId, useRef, useState, type FormEvent } from "react";

import { AuthCard } from "../components/AuthCard";
import { ApiError } from "../lib/api";
import { Link } from "../lib/navigation";
import { organizationJoinApi } from "../lib/organizationJoin";

function secureToken(): string {
  return new URLSearchParams(window.location.hash.slice(1)).get("token") ?? "";
}

function failureMessage(error: unknown, fallback: string): string {
  if (!(error instanceof ApiError)) return fallback;
  const fields = Object.values(error.errors).flatMap((value) => Array.isArray(value) ? value : [value]);
  return fields.length ? fields.join(" ") : error.message;
}

type LinkState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; data: Awaited<ReturnType<typeof organizationJoinApi.inspect>> };

export function OrganizationJoin() {
  const [token] = useState(secureToken);
  const [link, setLink] = useState<LinkState>({ status: "loading" });
  useEffect(() => {
    if (!token) return;
    let active = true;
    // Anonymous session hydration clears the authenticated query cache. This
    // public capability lookup must finish independently of that cache reset.
    void organizationJoinApi.inspect(token).then(
      (data) => { if (active) setLink({ status: "ready", data }); },
      () => { if (active) setLink({ status: "error" }); },
    );
    return () => { active = false; };
  }, [token]);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [complete, setComplete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (inFlight.current || link.status !== "ready" || !event.currentTarget.reportValidity()) return;
    setError(null);
    if (!name.trim()) { setError("Enter your full name."); return; }
    inFlight.current = true;
    setBusy(true);
    try {
      await organizationJoinApi.submit({ token, name: name.trim(), email: email.trim().toLowerCase() });
      setComplete(true);
    } catch (caught) {
      setError(failureMessage(caught, "Your request could not be submitted. Please try again."));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  if (!token || link.status === "error") {
    return <AuthCard title="Sign-up link unavailable" subtitle="This link may have expired or been revoked. Ask your organization’s Admin for a new sign-up link.">
      <Link className="auth-submit auth-submit-link" to="/login">Return to sign in</Link>
    </AuthCard>;
  }
  if (link.status === "loading") {
    return <AuthCard title="Opening sign-up link" subtitle="Checking which organization you will join.">
      <div className="organization-join-loading" role="status">Loading…</div>
    </AuthCard>;
  }
  if (complete) {
    return <AuthCard title="Check your email" subtitle={`Verify your email to request access to ${link.data.organization.name}.`}>
      <div className="auth-notice" role="status">If this address is eligible, you will receive an email to verify it and choose your password. An Admin must then approve your request and choose your role before you can sign in.</div>
      <p className="auth-alt">Already have an account? <Link to="/login">Sign in</Link></p>
    </AuthCard>;
  }
  return <AuthCard title={`Join ${link.data.organization.name}`} subtitle="Request access to this organization. Your Admin will review your request after you verify your email.">
    <ol className="organization-join-steps" aria-label="Joining steps">
      <li className="current">Your details</li><li>Verify email</li><li>Admin approval</li>
    </ol>
    <form className="organization-join-form" onSubmit={submit} aria-busy={busy}>
      {error && <div className="auth-error" role="alert">{error}</div>}
      <label className="auth-field"><span>Full name</span><input type="text" required maxLength={255} autoComplete="name" value={name} disabled={busy} onChange={(event) => setName(event.target.value)} /></label>
      <label className="auth-field"><span>Email</span><input type="email" required maxLength={254} autoComplete="email" value={email} disabled={busy} onChange={(event) => setEmail(event.target.value)} /></label>
      <p className="organization-access-hint">You will choose your password after verifying your email.</p>
      <button className="auth-submit" type="submit" disabled={busy}>{busy ? "Submitting…" : "Request to join"}</button>
    </form>
    <p className="auth-alt">Already have an account? <Link to="/login">Sign in</Link></p>
  </AuthCard>;
}

export function OrganizationJoinVerification() {
  const [token] = useState(secureToken);
  const passwordHintId = useId();
  const inFlight = useRef(false);
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [state, setState] = useState<"ready" | "verifying" | "pending" | "error">(token ? "ready" : "error");
  const [error, setError] = useState<string | null>(null);
  const verify = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!token || inFlight.current || !event.currentTarget.reportValidity()) return;
    setError(null);
    if (password.length < 12) { setError("Use at least 12 characters for your password."); return; }
    if (password !== confirmPassword) { setError("The passwords do not match."); return; }
    inFlight.current = true;
    setState("verifying");
    try {
      await organizationJoinApi.verify(token, password);
      setPassword("");
      setConfirmPassword("");
      setState("pending");
    } catch (caught) {
      setState("error");
      setError(failureMessage(caught, "This verification link is invalid or has expired."));
    } finally { inFlight.current = false; }
  };
  if (state === "pending") {
    return <AuthCard title="Email verified" subtitle="Your request is awaiting Admin approval.">
      <ol className="organization-join-steps" aria-label="Joining steps"><li>Details submitted</li><li>Email verified</li><li className="current">Admin approval</li></ol>
      <div className="auth-notice" role="status">You do not have workspace access yet. Your organization’s Admin must approve your request and assign your role. Your Admin will confirm access once your request has been approved.</div>
      <Link className="auth-submit auth-submit-link" to="/">Return to home</Link>
    </AuthCard>;
  }
  if (!token) {
    return <AuthCard title="Verification link unavailable" subtitle="Verification links expire and can only be used once.">
      <div className="auth-error" role="alert">This verification link is missing its secure token.</div>
      <Link className="auth-submit auth-submit-link" to="/">Return to home</Link>
    </AuthCard>;
  }
  return <AuthCard title="Verify email and set your password" subtitle="Choose your own password to confirm your email and send your request to the organization’s Admin.">
    <form className="organization-join-form" onSubmit={(event) => void verify(event)} aria-busy={state === "verifying"}>
      {error && <div className="auth-error" role="alert">{error}</div>}
      <label className="auth-field"><span>Password</span><input type="password" required minLength={12} maxLength={128} autoComplete="new-password" aria-describedby={passwordHintId} value={password} disabled={state === "verifying"} onChange={(event) => setPassword(event.target.value)} /></label><p className="organization-password-hint" id={passwordHintId}>Use at least 12 characters.</p>
      <label className="auth-field"><span>Confirm password</span><input type="password" required minLength={12} maxLength={128} autoComplete="new-password" value={confirmPassword} disabled={state === "verifying"} onChange={(event) => setConfirmPassword(event.target.value)} /></label>
      <button className="auth-submit" type="submit" disabled={state === "verifying"}>{state === "verifying" ? "Verifying…" : "Verify email"}</button>
    </form>
    {state === "verifying" && <div role="status">Verifying your email…</div>}
    <p className="auth-alt">After verification, your Admin will still need to approve access. If this link is expired or already used, ask your Admin for a new sign-up link.</p>
  </AuthCard>;
}
