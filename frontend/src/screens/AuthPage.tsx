import { useEffect, useState, type FormEvent } from "react";
import { Link, useLocation, useNavigate } from "../lib/navigation";

import { useAuth } from "../auth/AuthContext";
import { ApiError } from "../lib/api";

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
  const [redirectAfterAuth, setRedirectAfterAuth] = useState(false);

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [orgName, setOrgName] = useState("");
  const [port, setPort] = useState("Port of Calabar");

  const destination = (
    location.state
    && typeof location.state === "object"
    && "from" in location.state
    && typeof location.state.from === "string"
  ) ? location.state.from : "/app";
  const sessionExpired = Boolean(
    location.state
    && typeof location.state === "object"
    && "reason" in location.state
    && location.state.reason === "session-expired",
  );

  useEffect(() => {
    if (redirectAfterAuth && status === "authenticated") {
      navigate(destination, { replace: true });
    }
  }, [destination, navigate, redirectAfterAuth, status]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (challengeId) {
        await verifyMfa(challengeId, code.trim());
        setRedirectAfterAuth(true);
        return;
      }
      if (mode === "login") {
        const challenge = await login(email.trim().toLowerCase(), password);
        if (challenge) {
          setChallengeId(challenge.challengeId);
          setPassword("");
          return;
        }
        setRedirectAfterAuth(true);
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

  const continueToSignIn = () => {
    setNotice(null);
    setError(null);
    setChallengeId(null);
    setPassword("");
    navigate("/login", { replace: true, state: null });
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
          <button className="auth-submit auth-submit-link" type="button" onClick={continueToSignIn}>
            Continue to sign in
          </button>
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
            <p className="auth-alt">Internal admin testing access only. Public registration and email recovery are not available yet.</p>
          </>
        ) : (
          <p className="auth-alt">Already have an account? <Link to="/login">Sign in</Link></p>
        )}
        <p className="auth-alt"><Link to="/">← Back to home</Link></p>
      </form>
    </div>
  );
}
