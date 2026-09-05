import { useEffect, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useAuth } from "../auth/AuthContext";
import { ConfirmModal, EmptyState, Field, StatusBadge } from "../components/ui";
import { Icon } from "../components/Icon";
import { ApiError, api } from "../lib/api";
import { fmtDateTime } from "../lib/format";

type AccountTab = "profile" | "security" | "sessions";

interface AccountSecurityProps {
  initialTab?: AccountTab;
  prioritizeMfa?: boolean;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback;
}

export function AccountSecurity({ initialTab = "profile", prioritizeMfa = false }: AccountSecurityProps = {}) {
  const [tab, setTab] = useState<AccountTab>(initialTab);
  const tabs: Array<[AccountTab, string]> = [
    ["profile", "Profile"],
    ["security", "Password & MFA"],
    ["sessions", "Sessions"],
  ];

  return (
    <div className="content-inner">
      <div className="page-head">
        <div>
          <h1 className="hide-sr">Account and security</h1>
          <p className="desc">Manage your profile, sign-in security, and active sessions.</p>
        </div>
      </div>
      <div className="settings-tabs" role="tablist" aria-label="Account sections">
        {tabs.map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            className={tab === key ? "on" : ""}
            onClick={() => setTab(key)}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === "profile" && <ProfilePanel />}
      {tab === "security" && <SecurityPanel prioritizeMfa={prioritizeMfa} />}
      {tab === "sessions" && <SessionsPanel />}
    </div>
  );
}

function ProfilePanel() {
  const { refreshSession, platformAccess } = useAuth();
  const queryClient = useQueryClient();
  const profileQuery = useQuery({ queryKey: ["profile"], queryFn: api.profile });
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [profilePassword, setProfilePassword] = useState("");
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!profileQuery.data) return;
    setName(profileQuery.data.user.name);
    setEmail(profileQuery.data.user.email);
  }, [profileQuery.data]);

  const saveMutation = useMutation({
    mutationFn: () =>
      api.updateProfile({
        name: name.trim(),
        email: email.trim().toLowerCase(),
        ...(email.trim().toLowerCase() !== profileQuery.data?.user.email.toLowerCase()
          ? { currentPassword: profilePassword }
          : {}),
      }),
    onSuccess: async (result) => {
      queryClient.setQueryData(["profile"], { user: result.user });
      await refreshSession();
      setProfilePassword("");
      setNotice(result.verificationRequired
        ? "Profile saved. Check your new email address to confirm the change."
        : "Profile saved.");
    },
  });

  if (profileQuery.isPending) {
    return <div className="card card-pad account-panel" role="status">Loading profile…</div>;
  }
  if (profileQuery.isError || !profileQuery.data) {
    return (
      <div className="card account-panel">
        <EmptyState icon="alert" title="Profile unavailable" body="We could not load your profile. Refresh the page to try again." />
      </div>
    );
  }

  const profile = profileQuery.data.user;
  return (
    <form
      className="card card-pad account-panel"
      onSubmit={(event) => {
        event.preventDefault();
        setNotice(null);
        saveMutation.mutate();
      }}
    >
      <div className="card-title">Profile</div>
      <p className="muted account-copy">Your name appears on audit records. Email changes require confirmation before taking effect.</p>
      {notice && <div className="user-access-note" role="status"><Icon name="check" size={16} />{notice}</div>}
      {saveMutation.isError && (
        <div className="auth-error" role="alert">
          {errorMessage(saveMutation.error, "Could not save your profile.")}
        </div>
      )}
      <Field label="Full name" required>
        <input value={name} onChange={(event) => setName(event.target.value)} autoComplete="name" required />
      </Field>
      <Field label="Email" required hint={profile.pendingEmail ? `Pending verification: ${profile.pendingEmail}` : undefined}>
        <input type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" required />
      </Field>
      {email.trim().toLowerCase() !== profile.email.toLowerCase() && (
        <Field label="Current password" required hint="Required to protect changes to your sign-in email.">
          <input
            type="password"
            value={profilePassword}
            onChange={(event) => setProfilePassword(event.target.value)}
            autoComplete="current-password"
            required
          />
        </Field>
      )}
      <div className="user-account-summary">
        <span>Account role</span>
        <strong>{platformAccess ? "System Administrator" : profile.role}</strong>
        <small>
          {platformAccess
            ? "Platform access is provisioned and revoked through the controlled operator process."
            : "Role changes are managed by another organization Admin."}
        </small>
      </div>
      <button
        className="btn btn-primary"
        type="submit"
        disabled={
          saveMutation.isPending ||
          !name.trim() ||
          !email.trim() ||
          (email.trim().toLowerCase() !== profile.email.toLowerCase() && !profilePassword)
        }
      >
        {saveMutation.isPending ? "Saving…" : "Save profile"}
      </button>
    </form>
  );
}

function SecurityPanel({ prioritizeMfa }: { prioritizeMfa: boolean }) {
  const { user, platformAccess, refreshSession } = useAuth();
  const [currentPassword, setCurrentPassword] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [passwordNotice, setPasswordNotice] = useState<string | null>(null);
  const [setup, setSetup] = useState<{ secret: string; provisioningUri: string } | null>(null);
  const [mfaCode, setMfaCode] = useState("");
  const [recoveryCode, setRecoveryCode] = useState("");
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [disablePassword, setDisablePassword] = useState("");
  const [mfaSetupPassword, setMfaSetupPassword] = useState("");
  const [showDisable, setShowDisable] = useState(false);

  const passwordMutation = useMutation({
    mutationFn: () => api.changePassword(currentPassword, password),
    onSuccess: (result) => {
      setPasswordNotice(result.detail || "Password changed. Other sessions have been revoked.");
      setCurrentPassword("");
      setPassword("");
      setConfirmPassword("");
    },
  });
  const setupMutation = useMutation({
    mutationFn: () => api.setupMfa(mfaSetupPassword),
    onSuccess: (result) => {
      setSetup(result);
      setMfaSetupPassword("");
      setRecoveryCodes([]);
    },
  });
  const confirmMutation = useMutation({
    mutationFn: () => api.confirmMfa(mfaCode.trim()),
    onSuccess: async (result) => {
      setRecoveryCodes(result.recoveryCodes);
      setSetup(null);
      setMfaCode("");
      await refreshSession();
    },
  });
  const regenerateMutation = useMutation({
    mutationFn: () => api.regenerateRecoveryCodes(recoveryCode.trim()),
    onSuccess: (result) => {
      setRecoveryCode("");
      setRecoveryCodes(result.recoveryCodes);
    },
  });
  const disableMutation = useMutation({
    mutationFn: () => api.disableMfa(disablePassword),
    onSuccess: async () => {
      setShowDisable(false);
      setDisablePassword("");
      setRecoveryCodes([]);
      await refreshSession();
    },
  });

  const changePassword = (event: FormEvent) => {
    event.preventDefault();
    setPasswordNotice(null);
    if (password.length < 12 || password !== confirmPassword) return;
    passwordMutation.mutate();
  };

  const mfaError = setupMutation.error || confirmMutation.error || regenerateMutation.error || disableMutation.error;
  const passwordPanel = (
    <form className="card card-pad account-panel" onSubmit={changePassword}>
      <div className="card-title">Password</div>
      <p className="muted account-copy">Changing your password signs out other devices immediately.</p>
      {passwordNotice && <div className="user-access-note" role="status"><Icon name="check" size={16} />{passwordNotice}</div>}
      {passwordMutation.isError && (
        <div className="auth-error" role="alert">{errorMessage(passwordMutation.error, "Could not change your password.")}</div>
      )}
      <Field label="Current password" required>
        <input
          type="password"
          value={currentPassword}
          onChange={(event) => setCurrentPassword(event.target.value)}
          autoComplete="current-password"
          required
        />
      </Field>
      <Field label="New password" required hint="Use at least 12 characters and avoid passwords used elsewhere.">
        <input
          type="password"
          minLength={12}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          autoComplete="new-password"
          required
        />
      </Field>
      <Field
        label="Confirm new password"
        required
        error={confirmPassword && password !== confirmPassword ? "Passwords do not match" : undefined}
      >
        <input
          type="password"
          minLength={12}
          value={confirmPassword}
          onChange={(event) => setConfirmPassword(event.target.value)}
          autoComplete="new-password"
          required
        />
      </Field>
      <button
        className="btn btn-primary"
        type="submit"
        disabled={passwordMutation.isPending || password.length < 12 || password !== confirmPassword}
      >
        {passwordMutation.isPending ? "Changing…" : "Change password"}
      </button>
    </form>
  );

  const authenticatorPanel = (
    <section className="card card-pad account-panel" aria-labelledby="mfa-heading">
      <div className="flex between items-center">
        <div className="card-title" id="mfa-heading">Authenticator app</div>
        <StatusBadge status={user?.mfaEnabled ? "active" : "inactive"} />
      </div>
      <p className="muted account-copy">
        {user?.mfaEnabled
          ? "Two-factor authentication protects this account at sign-in."
          : user?.mfaEnrollmentRequired
            ? `Enrollment is required for your role${user.mfaGraceEndsAt ? ` by ${fmtDateTime(user.mfaGraceEndsAt)}` : ""}.`
            : "Add a second factor using any TOTP-compatible authenticator app."}
      </p>
      {mfaError && <div className="auth-error" role="alert">{errorMessage(mfaError, "Could not update MFA.")}</div>}

      {!user?.mfaEnabled && !setup && (
        <>
          <Field label="Current password" required hint="Confirm your identity before creating a new MFA seed.">
            <input
              type="password"
              value={mfaSetupPassword}
              onChange={(event) => setMfaSetupPassword(event.target.value)}
              autoComplete="current-password"
              required
            />
          </Field>
          <button
            className="btn btn-primary"
            type="button"
            onClick={() => setupMutation.mutate()}
            disabled={setupMutation.isPending || !mfaSetupPassword}
          >
            {setupMutation.isPending ? "Preparing…" : "Set up authenticator"}
          </button>
        </>
      )}
      {setup && (
        <div className="mfa-setup">
          <ol>
            <li>
              Open this setup link on a device with your authenticator:{" "}
              <a href={setup.provisioningUri}>Add to authenticator</a>.
            </li>
            <li>If needed, enter this key manually: <code>{setup.secret}</code>.</li>
            <li>Enter the six-digit code below to finish.</li>
          </ol>
          <Field label="Authenticator code" required>
            <input
              value={mfaCode}
              onChange={(event) => setMfaCode(event.target.value)}
              inputMode="numeric"
              autoComplete="one-time-code"
            />
          </Field>
          <div className="flex gap-3">
            <button className="btn btn-primary" type="button" onClick={() => confirmMutation.mutate()} disabled={confirmMutation.isPending || !mfaCode.trim()}>
              {confirmMutation.isPending ? "Verifying…" : "Enable MFA"}
            </button>
            <button className="btn btn-secondary" type="button" onClick={() => setSetup(null)}>Cancel</button>
          </div>
        </div>
      )}

      {user?.mfaEnabled && (
        <div className="account-actions">
          <Field label="Current authenticator code" required hint="Required before replacing your recovery codes.">
            <input
              value={recoveryCode}
              onChange={(event) => setRecoveryCode(event.target.value)}
              inputMode="numeric"
              autoComplete="one-time-code"
            />
          </Field>
          <div className="flex gap-3">
            <button className="btn btn-secondary" type="button" onClick={() => regenerateMutation.mutate()} disabled={regenerateMutation.isPending || !recoveryCode.trim()}>
              New recovery codes
            </button>
            {!platformAccess && (
              <button className="btn btn-ghost" type="button" onClick={() => setShowDisable(true)} style={{ color: "var(--danger)" }}>
                Disable MFA
              </button>
            )}
          </div>
          {platformAccess && (
            <p className="muted account-copy">System Administrator MFA cannot be disabled in the product. Use the audited operator recovery process if access is lost.</p>
          )}
        </div>
      )}
      {recoveryCodes.length > 0 && (
        <div className="recovery-codes" role="status">
          <strong>Save these recovery codes now</strong>
          <p>Each code works once. They will not be shown again after you leave this page.</p>
          <ul>{recoveryCodes.map((code) => <li key={code}><code>{code}</code></li>)}</ul>
          <button
            className="btn btn-secondary btn-sm"
            type="button"
            onClick={() => void navigator.clipboard.writeText(recoveryCodes.join("\n"))}
          >
            Copy codes
          </button>
        </div>
      )}
    </section>
  );

  return (
    <div className="account-grid">
      {prioritizeMfa ? (
        <>{authenticatorPanel}{passwordPanel}</>
      ) : (
        <>{passwordPanel}{authenticatorPanel}</>
      )}

      {showDisable && !platformAccess && (
        <ConfirmModal
          title="Disable two-factor authentication?"
          body={(
            <Field label="Confirm with your password" required>
              <input
                type="password"
                value={disablePassword}
                onChange={(event) => setDisablePassword(event.target.value)}
                autoComplete="current-password"
              />
            </Field>
          )}
          confirmLabel="Disable MFA"
          confirmDisabled={disableMutation.isPending || !disablePassword}
          danger
          onClose={() => setShowDisable(false)}
          onConfirm={() => disableMutation.mutate()}
        />
      )}
    </div>
  );
}

function SessionsPanel() {
  const { logout } = useAuth();
  const queryClient = useQueryClient();
  const sessionsQuery = useQuery({ queryKey: ["sessions"], queryFn: api.sessions });
  const revokeMutation = useMutation({
    mutationFn: api.revokeSession,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["sessions"] }),
  });
  const signOutMutation = useMutation({
    mutationFn: api.signOutEverywhere,
    onSuccess: () => logout(),
  });

  return (
    <section className="card card-pad account-panel" aria-labelledby="sessions-heading">
      <div className="flex between items-center">
        <div>
          <div className="card-title" id="sessions-heading">Active sessions</div>
          <p className="muted account-copy">Review devices that are signed in and revoke any you do not recognize.</p>
        </div>
        <button
          className="btn btn-secondary btn-sm"
          type="button"
          disabled={signOutMutation.isPending}
          onClick={() => signOutMutation.mutate()}
        >
          Sign out everywhere
        </button>
      </div>
      {(sessionsQuery.isError || revokeMutation.isError || signOutMutation.isError) && (
        <div className="auth-error" role="alert">
          {errorMessage(sessionsQuery.error || revokeMutation.error || signOutMutation.error, "Could not update sessions.")}
        </div>
      )}
      {sessionsQuery.isPending ? (
        <div role="status">Loading sessions…</div>
      ) : (
        <div className="session-list">
          {(sessionsQuery.data?.results ?? []).map((session) => (
            <div className="session-row" key={session.id}>
              <div className="session-icon"><Icon name="settings" size={20} /></div>
              <div className="session-meta">
                <strong>{session.current ? "This device" : session.userAgent || "Signed-in device"}</strong>
                <span>{session.ipAddress || "IP unavailable"} · Last active {fmtDateTime(session.lastSeenAt)}</span>
              </div>
              {session.current ? (
                <span className="tag">Current</span>
              ) : (
                <button
                  className="btn btn-secondary btn-sm"
                  type="button"
                  disabled={revokeMutation.isPending}
                  onClick={() => revokeMutation.mutate(session.id)}
                >
                  Revoke
                </button>
              )}
            </div>
          ))}
          {!sessionsQuery.data?.results.length && (
            <EmptyState icon="settings" title="No sessions found" body="There are no active sessions to display." />
          )}
        </div>
      )}
    </section>
  );
}
