import { useState, type FormEvent } from "react";
import { Link, useSearchParams } from "../lib/navigation";

import { AuthCard } from "../components/AuthCard";
import { ApiError, api } from "../lib/api";

function messageFor(error: unknown): string {
  return error instanceof ApiError ? error.message : "Something went wrong. Please try again.";
}

export function ForgotPassword() {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await api.forgotPassword(email.trim().toLowerCase());
      setMessage(result.detail || "If an account exists, password reset instructions have been sent.");
    } catch (caught) {
      setError(messageFor(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthCard title="Reset your password" subtitle="We’ll send a single-use reset link to your verified email address.">
      {message ? (
        <>
          <div className="auth-notice" role="status">{message}</div>
          <p className="auth-alt"><Link to="/login">Return to sign in</Link></p>
        </>
      ) : (
        <form onSubmit={submit}>
          {error && <div className="auth-error" role="alert">{error}</div>}
          <label className="auth-field">
            <span>Email</span>
            <input
              type="email"
              required
              autoComplete="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </label>
          <button className="auth-submit" type="submit" disabled={busy}>
            {busy ? "Sending…" : "Send reset link"}
          </button>
          <p className="auth-alt"><Link to="/login">Return to sign in</Link></p>
        </form>
      )}
    </AuthCard>
  );
}

export function ResetPassword() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get("token") ?? "";
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(token ? null : "This reset link is missing its secure token.");

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    if (password.length < 12) {
      setError("Use at least 12 characters.");
      return;
    }
    if (password !== confirmPassword) {
      setError("The passwords do not match.");
      return;
    }
    setBusy(true);
    try {
      const result = await api.resetPassword(token, password);
      setMessage(result.detail || "Your password has been changed. Sign in with your new password.");
      setPassword("");
      setConfirmPassword("");
    } catch (caught) {
      setError(messageFor(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthCard title="Choose a new password" subtitle="Use a unique password with at least 12 characters.">
      {message ? (
        <>
          <div className="auth-notice" role="status">{message}</div>
          <Link className="auth-submit auth-submit-link" to="/login">Sign in</Link>
        </>
      ) : (
        <form onSubmit={submit}>
          {error && <div className="auth-error" role="alert">{error}</div>}
          <label className="auth-field">
            <span>New password</span>
            <input
              type="password"
              required
              minLength={12}
              autoComplete="new-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>
          <label className="auth-field">
            <span>Confirm new password</span>
            <input
              type="password"
              required
              minLength={12}
              autoComplete="new-password"
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
            />
          </label>
          <button className="auth-submit" type="submit" disabled={busy || !token}>
            {busy ? "Changing password…" : "Change password"}
          </button>
        </form>
      )}
    </AuthCard>
  );
}
