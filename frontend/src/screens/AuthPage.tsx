import { useEffect, useState, type FormEvent } from "react";
import { Link, useLocation, useNavigate } from "../lib/navigation";

import { useAuth } from "../auth/AuthContext";
import { ApiError } from "../lib/api";
import type { AuthSession } from "../types";

const anchor = (
  <svg
    width="20"
    height="20"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M12 22V8" />
    <path d="M5 12H2a10 10 0 0 0 20 0h-3" />
    <circle cx="12" cy="5" r="3" />
  </svg>
);

function errorMessage(error: unknown): string {
  return error instanceof ApiError
    ? error.message
    : "Something went wrong. Please try again.";
}

export function AuthPage({ mode }: { mode: "login" | "register" }) {
  const { login, register, verifyMfa, status } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [challengeId, setChallengeId] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [redirectAfterAuth, setRedirectAfterAuth] = useState<string | null>(null);

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [orgName, setOrgName] = useState("");
  const [port, setPort] = useState("Port of Calabar");

  const requestedDestination = (
    location.state
    && typeof location.state === "object"
    && "from" in location.state
    && typeof location.state.from === "string"
  ) ? location.state.from : null;
  const safeRequestedDestination = (
    requestedDestination
    && requestedDestination.startsWith("/")
    && !requestedDestination.startsWith("//")
  ) ? requestedDestination : null;
  const isWithin = (path: string, prefix: string) => (
    path === prefix || path.startsWith(`${prefix}/`) || path.startsWith(`${prefix}?`)
  );
  const destinationFor = (session: AuthSession): string => {
    const platform = Boolean(session.platformAccess);
    const home = platform
      ? session.platformAccess?.mfaEnrollmentRequired ? "/system/account" : "/system"
      : "/app";
    if (!safeRequestedDestination) return home;
    if (platform) return isWithin(safeRequestedDestination, "/system") ? safeRequestedDestination : home;
    return (
      isWithin(safeRequestedDestination, "/app")
      || isWithin(safeRequestedDestination, "/capture")
    ) ? safeRequestedDestination : home;
  };
  const sessionExpired = Boolean(
    location.state
    && typeof location.state === "object"
    && "reason" in location.state
    && location.state.reason === "session-expired",
  );

  useEffect(() => {
    if (redirectAfterAuth && status === "authenticated") {
      navigate(redirectAfterAuth, { replace: true });
    }
  }, [navigate, redirectAfterAuth, status]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (challengeId) {
        const session = await verifyMfa(challengeId, code.trim());
        setRedirectAfterAuth(destinationFor(session));
        return;
      }
      if (mode === "login") {
        const result = await login(email.trim().toLowerCase(), password);
        if ("mfaRequired" in result) {
          setChallengeId(result.challengeId);
          setPassword("");
          return;
        }
        setRedirectAfterAuth(destinationFor(result));
        return;
      }
      const result = await register({
        name: name.trim(),
        email: email.trim().toLowerCase(),
        password,
        orgName: orgName.trim(),
        designatedPort: port,
      });
      setNotice(result.detail || "Check your email to verify your account before signing in.");
      setPassword("");
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  if (notice) {
    return (
      <div className="auth-wrap">
        <div className="auth-card" role="status">
          <div className="auth-brand"><span className="auth-mark">{anchor}</span> Vessel Caller</div>
          <h1 className="auth-title">Verify your email</h1>
          <p className="auth-sub">{notice}</p>
          <p className="auth-alt">
            Didn’t receive it?{" "}
            <Link to={`/verify-email?email=${encodeURIComponent(email.trim().toLowerCase())}`}>Resend verification email</Link>
          </p>
          <Link className="auth-submit auth-submit-link" to="/login">Continue to sign in</Link>
        </div>
      </div>
    );
  }

  return (
    <div className="auth-wrap">
      <form className="auth-card" onSubmit={submit}>
        <div className="auth-brand"><span className="auth-mark">{anchor}</span> Vessel Caller</div>
        <h1 className="auth-title">
          {challengeId ? "Two-factor verification" : mode === "login" ? "Sign in" : "Register your organization"}
        </h1>
        <p className="auth-sub">
          {challengeId
            ? "Enter the six-digit code from your authenticator app, or a recovery code."
            : mode === "login"
              ? "Access your port-inspection workspace."
              : "Create your agency and its first Admin account."}
        </p>

        {sessionExpired && !error && (
          <div className="auth-notice" role="status">
            Your session expired. Sign in again to continue.
          </div>
        )}
        {error && <div className="auth-error" role="alert">{error}</div>}

        {challengeId ? (
          <label className="auth-field">
            <span>Verification code</span>
            <input
              value={code}
              onChange={(event) => setCode(event.target.value)}
              required
              autoComplete="one-time-code"
              autoFocus
            />
          </label>
        ) : (
          <>
            {mode === "register" && (
              <>
                <label className="auth-field">
                  <span>Your name</span>
                  <input value={name} onChange={(event) => setName(event.target.value)} required autoComplete="name" />
                </label>
                <label className="auth-field">
                  <span>Organization name</span>
                  <input value={orgName} onChange={(event) => setOrgName(event.target.value)} required autoComplete="organization" />
                </label>
                <label className="auth-field">
                  <span>Designated port</span>
                  <select value={port} onChange={(event) => setPort(event.target.value)}>
                    {[
                      "Port of Calabar",
                      "Apapa Port, Lagos",
                      "Tin Can Island Port, Lagos",
                      "Onne Port, Rivers",
                      "Port Harcourt Port",
                      "Warri Port, Delta",
                    ].map((option) => <option key={option} value={option}>{option}</option>)}
                  </select>
                </label>
              </>
            )}

            <label className="auth-field">
              <span>Email</span>
              <input
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                required
                autoComplete="email"
              />
            </label>
            <label className="auth-field">
              <span>Password</span>
              <input
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
                autoComplete={mode === "login" ? "current-password" : "new-password"}
                minLength={mode === "register" ? 12 : undefined}
              />
            </label>
          </>
        )}

        <button className="auth-submit" type="submit" disabled={busy}>
          {busy
            ? "Please wait…"
            : challengeId
              ? "Verify and sign in"
              : mode === "login"
                ? "Sign in"
                : "Create organization"}
        </button>

        {challengeId ? (
          <button
            type="button"
            className="auth-link-button"
            onClick={() => {
              setChallengeId(null);
              setCode("");
              setError(null);
            }}
          >
            Use a different account
          </button>
        ) : mode === "login" ? (
          <>
            <p className="auth-alt"><Link to="/forgot-password">Forgot your password?</Link></p>
            <p className="auth-alt">New here? <Link to="/register">Register an organization</Link></p>
          </>
        ) : (
          <p className="auth-alt">Already have an account? <Link to="/login">Sign in</Link></p>
        )}
        <p className="auth-alt"><Link to="/">← Back to home</Link></p>
      </form>
    </div>
  );
}
