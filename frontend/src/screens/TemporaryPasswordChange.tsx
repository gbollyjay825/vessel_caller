import { useEffect, useRef, useState, type FormEvent } from "react";

import { useAuth } from "../auth/AuthContext";
import { AuthCard } from "../components/AuthCard";
import { ApiError } from "../lib/api";
import { Link, useLocation, useNavigate } from "../lib/navigation";
import { organizationAuthPath } from "../lib/organizationAuth";
import type { AuthSession } from "../types";

function destinationFor(session: AuthSession, requested: unknown): string {
  if (session.platformAccess) return session.platformAccess.mfaEnrollmentRequired ? "/system/account" : "/system";
  if (session.user.mfaEnrollmentRequired) return "/app/account";
  if (typeof requested === "string" && /^\/app(?:\/|\?|$)/.test(requested)) return requested;
  return "/app";
}

function passwordError(error: unknown): string {
  if (!(error instanceof ApiError)) return "Could not change your password. Please try again.";
  const messages = error.errors?.password ?? error.errors?.token;
  return Array.isArray(messages) ? messages.join(" ") : messages || error.message;
}

export function TemporaryPasswordChange() {
  const { passwordChangeChallenge, completeTemporaryPassword, verifyMfa, logout, status } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const requested = location.state && typeof location.state === "object" && "from" in location.state ? location.state.from : null;
  const organizationId = location.state && typeof location.state === "object" && "organizationId" in location.state && typeof location.state.organizationId === "string" ? location.state.organizationId : undefined;
  const signInPath = organizationAuthPath("/login", organizationId);
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [mfaChallenge, setMfaChallenge] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [destination, setDestination] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const inFlight = useRef(false);
  const mounted = useRef(true);
  const expiresAt = passwordChangeChallenge ? Date.parse(passwordChangeChallenge.passwordChangeExpiresAt) : null;
  const expired = expiresAt !== null && (!Number.isFinite(expiresAt) || expiresAt <= now);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    if (!passwordChangeChallenge) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [passwordChangeChallenge]);
  useEffect(() => {
    if (destination && status === "authenticated") navigate(destination, { replace: true });
  }, [destination, navigate, status]);

  const cancel = () => {
    setPassword("");
    setConfirmation("");
    setCode("");
    void logout();
    navigate(signInPath, { replace: true });
  };
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (inFlight.current || busy || (!mfaChallenge && (!passwordChangeChallenge || expired))) return;
    setError(null);
    if (!mfaChallenge && password.length < 12) { setError("Use at least 12 characters."); return; }
    if (!mfaChallenge && password !== confirmation) { setError("The passwords do not match."); return; }
    inFlight.current = true;
    setBusy(true);
    try {
      const result = mfaChallenge
        ? await verifyMfa(mfaChallenge, code.trim())
        : await completeTemporaryPassword(password);
      if (!mounted.current) return;
      setPassword("");
      setConfirmation("");
      if ("mfaRequired" in result) setMfaChallenge(result.challengeId);
      else setDestination(destinationFor(result, requested));
    } catch (caught) {
      if (mounted.current) setError(passwordError(caught));
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  };

  if (!passwordChangeChallenge && !mfaChallenge && !destination && !busy) {
    return <AuthCard title="Sign in to continue" subtitle="Sign in again with your current password. If you have already replaced the temporary password, use your new password.">
      <Link className="auth-submit auth-submit-link" to={signInPath}>Return to sign in</Link>
    </AuthCard>;
  }
  return (
    <AuthCard title={mfaChallenge ? "Two-factor verification" : "Choose your own password"}
      subtitle={mfaChallenge ? "Your password is updated. Enter your authenticator or recovery code to finish signing in." : "Replace your temporary password before accessing NPA Vessel Caller."}>
      <form onSubmit={submit} aria-label={mfaChallenge ? "Two-factor verification" : "Choose your own password"}>
        {error && <div className="auth-error" role="alert">{error}</div>}
        {expired && !mfaChallenge && <div className="auth-error" role="alert">This password-change session has expired. Return to sign in with your temporary password again.</div>}
        {mfaChallenge ? <label className="auth-field"><span>Verification code</span>
          <input value={code} onChange={(event) => setCode(event.target.value)} required autoComplete="one-time-code" autoFocus disabled={busy} />
        </label> : <>
          <p className="organization-password-hint">Use a unique password with at least 12 characters. The temporary password will stop working.</p>
          <label className="auth-field"><span>New password</span>
            <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} required minLength={12} autoComplete="new-password" autoFocus disabled={busy || expired} />
          </label>
          <label className="auth-field"><span>Confirm new password</span>
            <input type="password" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} required minLength={12} autoComplete="new-password" disabled={busy || expired} />
          </label>
        </>}
        <button type="submit" className="auth-submit" disabled={busy || (!mfaChallenge && expired)}>
          {busy ? "Please wait…" : mfaChallenge ? "Verify and sign in" : "Change password and continue"}
        </button>
        <button type="button" className="auth-link-button" onClick={cancel}>Return to sign in</button>
      </form>
    </AuthCard>
  );
}
