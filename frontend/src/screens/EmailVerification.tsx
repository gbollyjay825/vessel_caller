import { useEffect, useState, type FormEvent } from "react";
import { Link, useSearchParams } from "../lib/navigation";

import { AuthCard } from "../components/AuthCard";
import { ApiError, api } from "../lib/api";

type VerificationState = "idle" | "verifying" | "verified" | "error";

export function EmailVerification() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get("token") ?? "";
  const [email, setEmail] = useState(searchParams.get("email") ?? "");
  const [state, setState] = useState<VerificationState>(token ? "verifying" : "idle");
  const [message, setMessage] = useState<string | null>(null);
  const [approvalPending, setApprovalPending] = useState(false);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    if (!token) return;
    let active = true;
    api.verifyEmail(token)
      .then((result) => {
        if (!active) return;
        setState("verified");
        setApprovalPending(result.approvalPending === true);
        setMessage(result.detail || "Your email is verified. You can now sign in.");
      })
      .catch((error: unknown) => {
        if (!active) return;
        setState("error");
        setMessage(error instanceof ApiError ? error.message : "This verification link is invalid or has expired.");
      });
    return () => {
      active = false;
    };
  }, [token]);

  const resend = async (event: FormEvent) => {
    event.preventDefault();
    setSending(true);
    setMessage(null);
    try {
      const result = await api.resendVerification(email.trim().toLowerCase());
      setMessage(result.detail || "If the account is pending, a new verification email has been sent.");
    } catch (error) {
      setMessage(error instanceof ApiError ? error.message : "Could not send a verification email.");
    } finally {
      setSending(false);
    }
  };

  if (state === "verifying") {
    return (
      <AuthCard title="Verifying your email" subtitle="Please wait while we validate this secure link.">
        <div className="vc-center" role="status"><div className="vc-spinner" aria-hidden="true" />Verifying…</div>
      </AuthCard>
    );
  }

  if (state === "verified") {
    if (approvalPending) {
      return (
        <AuthCard
          title="Email verified — approval pending"
          subtitle="Your email is verified. A System Administrator must approve your organization before you can sign in."
        >
          <div className="auth-notice" role="status">
            Your organization remains securely locked while the approval review is pending.
          </div>
          <Link className="auth-submit auth-submit-link" to="/">Return to home</Link>
        </AuthCard>
      );
    }
    return (
      <AuthCard title="Email verified" subtitle={message ?? "Your account is ready."}>
        <Link className="auth-submit auth-submit-link" to="/login">Sign in</Link>
      </AuthCard>
    );
  }

  return (
    <AuthCard
      title={state === "error" ? "Verification link unavailable" : "Resend verification"}
      subtitle={state === "error"
        ? "Request a new link below. For your security, verification links can only be used once."
        : "Enter the email address used to register your organization."}
    >
      {message && <div className={state === "error" ? "auth-error" : "auth-notice"} role="status">{message}</div>}
      <form onSubmit={resend}>
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
        <button className="auth-submit" disabled={sending} type="submit">
          {sending ? "Sending…" : "Send a new verification email"}
        </button>
      </form>
      <p className="auth-alt"><Link to="/login">Return to sign in</Link></p>
    </AuthCard>
  );
}
