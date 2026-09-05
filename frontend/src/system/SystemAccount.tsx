import { useState, type FormEvent } from "react";
import { useMutation } from "@tanstack/react-query";

import { useAuth } from "../auth/AuthContext";
import { Icon } from "../components/Icon";
import { ApiError, api } from "../lib/api";
import { fmtDateTime } from "../lib/format";
import { AccountSecurity } from "../screens/AccountSecurity";

function errorMessage(error: unknown): string {
  return error instanceof ApiError
    ? error.message
    : "Could not refresh System Administrator verification. Try again.";
}

export function SystemAccount() {
  const { platformAccess, refreshSession } = useAuth();
  const enrollmentRequired = Boolean(platformAccess?.mfaEnrollmentRequired);
  const [code, setCode] = useState("");
  const stepUp = useMutation({
    mutationFn: () => api.systemStepUp(code.trim()),
    onSuccess: async () => {
      setCode("");
      await refreshSession();
    },
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!code.trim() || stepUp.isPending || enrollmentRequired) return;
    stepUp.mutate();
  };
  const verified = !platformAccess?.stepUpRequired && Boolean(platformAccess?.assuranceExpiresAt);

  return (
    <div className="content-inner system-account">
      {enrollmentRequired ? (
        <section className="card card-pad system-enrollment-card" aria-labelledby="system-enrollment-title">
          <div className="system-enrollment-heading">
            <span className="system-enrollment-icon"><Icon name="alert" size={20} /></span>
            <div>
              <div className="card-title" id="system-enrollment-title">Secure your System Administrator account</div>
              <p className="muted system-form-copy">
                Set up an authenticator below to unlock the platform overview, organization directory, and audit trail.
              </p>
            </div>
          </div>
          <ol className="system-enrollment-steps">
            <li className="current"><span>1</span><div><strong>Set up MFA</strong><small>Use your password and authenticator app.</small></div></li>
            <li><span>2</span><div><strong>Save recovery codes</strong><small>Keep the one-time codes somewhere secure.</small></div></li>
            <li><span>3</span><div><strong>Open the control plane</strong><small>The console unlocks automatically after enrollment.</small></div></li>
          </ol>
        </section>
      ) : (
        <section className="card card-pad" aria-labelledby="system-step-up-title">
          <div className="card-head system-card-head-inline">
            <div>
              <div className="card-title" id="system-step-up-title">System Administrator verification</div>
              <p className="muted system-form-copy">
                Organization changes, administrator recovery, invitations, and audit export require a recent MFA check.
              </p>
            </div>
            <span className={verified ? "badge active" : "badge pending"}>
              <span className="dot" />{verified ? "Recently verified" : "Verification required"}
            </span>
          </div>

          <form className="system-step-up-form" onSubmit={submit}>
            {stepUp.isError && <div className="auth-error" role="alert">{errorMessage(stepUp.error)}</div>}
            {stepUp.isSuccess && <div className="user-access-note" role="status"><Icon name="check" size={16} />System Administrator verification refreshed.</div>}
            {verified && (
              <p className="muted" role="status">
                High-impact controls are available until {fmtDateTime(platformAccess?.assuranceExpiresAt)}.
              </p>
            )}
            <label className="field" htmlFor="system-step-up-code">
              <span>Authenticator or recovery code</span>
              <input
                id="system-step-up-code"
                value={code}
                onChange={(event) => { setCode(event.target.value); stepUp.reset(); }}
                autoComplete="one-time-code"
                spellCheck={false}
                aria-describedby="system-step-up-help"
                required
              />
            </label>
            <p className="hint" id="system-step-up-help">Enter the current authenticator code or one unused recovery code. Codes are never displayed or stored here.</p>
            <button className="btn btn-primary" type="submit" disabled={stepUp.isPending || !code.trim()}>
              {stepUp.isPending ? "Verifying…" : verified ? "Verify again" : "Verify platform changes"}
            </button>
          </form>
        </section>
      )}
      <AccountSecurity initialTab={enrollmentRequired ? "security" : "profile"} prioritizeMfa />
    </div>
  );
}
