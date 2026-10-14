import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useLocation, useNavigate } from "../lib/navigation";

import { useAuth } from "../auth/AuthContext";
import { ApiError, type OrganizationSelection } from "../lib/api";
import { organizationAuthPath } from "../lib/organizationAuth";
import type { AuthSession } from "../types";
import { ProductBrand } from "../components/ProductBrand";

function errorMessage(error: unknown): string {
  return error instanceof ApiError
    ? error.message
    : "Something went wrong. Please try again.";
}

export function AuthPage({ mode }: { mode: "login" | "register" }) {
  const { login, register, verifyMfa, status } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const organizationId = mode === "login" ? new URLSearchParams(location.search).get("organizationId") || undefined : undefined;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [approvalRequired, setApprovalRequired] = useState(false);
  const [challengeId, setChallengeId] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [redirectAfterAuth, setRedirectAfterAuth] = useState<string | null>(null);
  const [organizationChoices, setOrganizationChoices] = useState<OrganizationSelection["organizations"] | null>(null);
  const [selectedOrganizationId, setSelectedOrganizationId] = useState("");
  const submitInFlight = useRef(false);

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
    if (!platform && session.user.mfaEnrollmentRequired) return "/app/account";
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
    if (submitInFlight.current) return;
    if (organizationChoices && !organizationChoices.some((org) => org.id === selectedOrganizationId)) return;
    submitInFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      if (challengeId) {
        const session = await verifyMfa(challengeId, code.trim());
        setRedirectAfterAuth(destinationFor(session));
        return;
      }
      if (mode === "login") {
        const loginOrganizationId = organizationChoices ? selectedOrganizationId : organizationId;
        const result = loginOrganizationId
          ? await login(email.trim().toLowerCase(), password, loginOrganizationId)
          : await login(email.trim().toLowerCase(), password);
        if ("organizationSelectionRequired" in result) {
          setOrganizationChoices(result.organizations);
          setSelectedOrganizationId("");
          return;
        }
        setOrganizationChoices(null);
        if ("passwordChangeRequired" in result) {
          setPassword("");
          navigate("/change-temporary-password", { replace: true, state: { from: safeRequestedDestination, organizationId: loginOrganizationId } });
          return;
        }
        if ("mfaRequired" in result) {
          setChallengeId(result.challengeId);
          setPassword("");
          return;
        }
        setPassword("");
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
      setApprovalRequired(result.approvalRequired === true);
      setPassword("");
    } catch (caught) {
      setError(errorMessage(caught));
      if (organizationChoices) {
        setOrganizationChoices(null);
        setSelectedOrganizationId("");
        setPassword("");
      }
    } finally {
      submitInFlight.current = false;
      setBusy(false);
    }
  };

  if (notice) {
    return (
      <div className="auth-wrap">
        <div className="auth-card" role="status">
          <ProductBrand className="auth-brand" />
          <h1 className="auth-title">Verify your email</h1>
          <p className="auth-sub">{notice}</p>
          {approvalRequired && (
            <div className="auth-notice" role="status">
              After email verification, a System Administrator must approve your organization before anyone can sign in.
            </div>
          )}
          <p className="auth-alt">
            Didn’t receive it?{" "}
            <Link to={`/verify-email?email=${encodeURIComponent(email.trim().toLowerCase())}`}>Resend verification email</Link>
          </p>
          {approvalRequired ? (
            <Link className="auth-submit auth-submit-link" to="/">Return to home</Link>
          ) : (
            <Link className="auth-submit auth-submit-link" to="/login">Continue to sign in</Link>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="auth-wrap">
      <form className="auth-card" onSubmit={submit}>
        <ProductBrand className="auth-brand" />
        <h1 className="auth-title">
          {challengeId ? "Two-factor verification" : organizationChoices ? "Choose your organization" : mode === "login" ? "Sign in" : "Register your organization"}
        </h1>
        <p className="auth-sub">
          {challengeId
            ? "Enter the six-digit code from your authenticator app, or a recovery code."
            : organizationChoices
              ? "Your sign-in details match more than one organization. Choose where to continue."
              : mode === "login"
                ? organizationId
                  ? "Sign in with the password shared for this organization."
                  : "Access your voyage readings and reconciliation workspace."
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
        ) : organizationChoices ? (
          <>
            <p className="auth-sub">{email.trim().toLowerCase()}</p>
            <label className="auth-field">
              <span>Organization</span>
              <select value={selectedOrganizationId} onChange={(event) => setSelectedOrganizationId(event.target.value)} required disabled={busy} autoFocus>
                <option value="" disabled>Select an organization</option>
                {organizationChoices.map((organization) => <option key={organization.id} value={organization.id}>{organization.name}</option>)}
              </select>
            </label>
          </>
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
                disabled={busy}
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
                disabled={busy}
              />
            </label>
          </>
        )}

        <button className="auth-submit" type="submit" disabled={busy || Boolean(organizationChoices && !selectedOrganizationId)}>
          {busy
            ? "Please wait…"
            : challengeId
              ? "Verify and sign in"
              : organizationChoices
                ? "Continue to organization"
                : mode === "login"
                  ? "Sign in"
                  : "Create organization"}
        </button>

        {challengeId || organizationChoices ? (
          <button
            type="button"
            className="auth-link-button"
            disabled={busy}
            onClick={() => {
              setChallengeId(null);
              setCode("");
              setError(null);
              setPassword("");
              setOrganizationChoices(null);
              setSelectedOrganizationId("");
            }}
          >
            Use a different account
          </button>
        ) : mode === "login" ? (
          <>
            <p className="auth-alt"><Link to={organizationAuthPath("/forgot-password", organizationId)}>Forgot your password?</Link></p>
            {organizationId && <p className="auth-alt"><Link to="/login">Sign in to another organization</Link></p>}
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
