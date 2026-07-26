import { useState, type FormEvent } from "react";
import { Link, useSearchParams } from "../lib/navigation";

import { AuthCard } from "../components/AuthCard";
import { ApiError, api } from "../lib/api";

export function InvitationAccept() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get("token") ?? "";
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [complete, setComplete] = useState(false);
  const [error, setError] = useState<string | null>(token ? null : "This invitation link is missing its secure token.");

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
      await api.acceptInvitation({ token, name: name.trim(), password });
      setComplete(true);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "This invitation could not be accepted.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthCard
      title={complete ? "Invitation accepted" : "Join your organization"}
      subtitle={complete
        ? "Your account is ready. Sign in to access the Vessel Caller workspace."
        : "Complete your profile and choose a secure password."}
    >
      {complete ? (
        <Link className="auth-submit auth-submit-link" to="/login">Sign in</Link>
      ) : (
        <form onSubmit={submit}>
          {error && <div className="auth-error" role="alert">{error}</div>}
          <label className="auth-field">
            <span>Full name</span>
            <input required autoComplete="name" value={name} onChange={(event) => setName(event.target.value)} />
          </label>
          <label className="auth-field">
            <span>Password</span>
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
            <span>Confirm password</span>
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
            {busy ? "Creating account…" : "Accept invitation"}
          </button>
        </form>
      )}
    </AuthCard>
  );
}
