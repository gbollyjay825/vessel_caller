import { useEffect, useRef, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { QRCodeSVG } from "qrcode.react";

import "../styles/authenticator-setup.css";

import { useAuth } from "../auth/AuthContext";
import { ConfirmModal, EmptyState, Field, StatusBadge } from "../components/ui";
import { Icon } from "../components/Icon";
import { ApiError, api } from "../lib/api";
import { fmtDateTime } from "../lib/format";

type AccountTab = "profile" | "security" | "sessions";

interface AccountSecurityProps {
  initialTab?: AccountTab;
  prioritizeMfa?: boolean;
  guidedMfa?: boolean;
  onMfaSetupComplete?: () => void;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback;
}

export function AccountSecurity({
  initialTab = "profile",
  prioritizeMfa = false,
  guidedMfa = false,
  onMfaSetupComplete,
}: AccountSecurityProps = {}) {
  const [tab, setTab] = useState<AccountTab>(initialTab);
  const tabs: Array<[AccountTab, string]> = [
    ["profile", "Profile"],
    ["security", "Password & MFA"],
    ["sessions", "Sessions"],
  ];

  if (guidedMfa) {
    return (
      <div className="content-inner authenticator-onboarding">
        <SecurityPanel prioritizeMfa guidedMfa onMfaSetupComplete={onMfaSetupComplete} />
      </div>
    );
  }

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

function SecurityPanel({ prioritizeMfa, guidedMfa = false, onMfaSetupComplete }: {
  prioritizeMfa: boolean;
  guidedMfa?: boolean;
  onMfaSetupComplete?: () => void;
}) {
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
  const [mfaOperation, setMfaOperation] = useState<"setup" | "confirm" | "regenerate" | null>(null);
  const [mfaOperationError, setMfaOperationError] = useState<string | null>(null);
  const [mfaConfirmed, setMfaConfirmed] = useState(false);
  const [codesSaved, setCodesSaved] = useState(false);
  const [copyNotice, setCopyNotice] = useState<string | null>(null);
  const [sessionRefreshFailed, setSessionRefreshFailed] = useState(false);
  const [refreshPending, setRefreshPending] = useState(false);
  const lifecycle = useRef(0);
  const operationBusy = useRef(false);
  const scanHeading = useRef<HTMLHeadingElement>(null);
  const recoveryHeading = useRef<HTMLHeadingElement>(null);

  useEffect(() => () => { lifecycle.current += 1; }, []);
  useEffect(() => {
    if (recoveryCodes.length > 0) recoveryHeading.current?.focus();
    else if (setup) scanHeading.current?.focus();
  }, [setup, recoveryCodes.length]);

  // Seeds, passwords and recovery codes stay in this component. Returning them
  // from a query mutation would retain them in the shared mutation cache.
  const refreshAfterEnrollment = async () => {
    const currentLifecycle = lifecycle.current;
    setRefreshPending(true);
    try {
      await refreshSession();
      if (currentLifecycle === lifecycle.current) setSessionRefreshFailed(false);
    } catch {
      if (currentLifecycle === lifecycle.current) setSessionRefreshFailed(true);
    } finally {
      if (currentLifecycle === lifecycle.current) setRefreshPending(false);
    }
  };

  const runMfaOperation = async (operation: "setup" | "confirm" | "regenerate") => {
    if (operationBusy.current) return;
    if (operation === "setup" && !mfaSetupPassword) return;
    if (operation === "confirm" && !/^\d{6}$/.test(mfaCode)) return;
    if (operation === "regenerate" && !/^\d{6}$/.test(recoveryCode)) return;
    operationBusy.current = true;
    const currentLifecycle = lifecycle.current;
    setMfaOperation(operation);
    setMfaOperationError(null);
    setCopyNotice(null);
    try {
      if (operation === "setup") {
        const result = await api.setupMfa(mfaSetupPassword);
        if (currentLifecycle !== lifecycle.current) return;
        setSetup(result);
        setMfaSetupPassword("");
        setRecoveryCodes([]);
        setCodesSaved(false);
      } else if (operation === "confirm") {
        const result = await api.confirmMfa(mfaCode);
        if (currentLifecycle !== lifecycle.current) return;
        setRecoveryCodes(result.recoveryCodes);
        setCodesSaved(false);
        setSetup(null);
        setMfaCode("");
        setMfaConfirmed(true);
        await refreshAfterEnrollment();
      } else {
        const result = await api.regenerateRecoveryCodes(recoveryCode);
        if (currentLifecycle !== lifecycle.current) return;
        setRecoveryCode("");
        setRecoveryCodes(result.recoveryCodes);
        setCodesSaved(false);
      }
    } catch (error) {
      if (currentLifecycle === lifecycle.current) {
        setMfaOperationError(errorMessage(error, "Could not update your authenticator. Please try again."));
      }
    } finally {
      if (currentLifecycle === lifecycle.current) {
        operationBusy.current = false;
        setMfaOperation(null);
      }
    }
  };

  const copyValue = async (value: string, notice: string) => {
    const currentLifecycle = lifecycle.current;
    try {
      await navigator.clipboard.writeText(value);
      if (currentLifecycle === lifecycle.current) setCopyNotice(notice);
    } catch {
      if (currentLifecycle === lifecycle.current) setCopyNotice("Copy is unavailable. Select the text and copy it manually.");
    }
  };

  const finishEnrollment = () => {
    if (recoveryCodes.length > 0 && !codesSaved) return;
    if (refreshPending || sessionRefreshFailed) return;
    setRecoveryCodes([]);
    setSetup(null);
    setMfaCode("");
    setMfaSetupPassword("");
    setCopyNotice(null);
    onMfaSetupComplete?.();
  };

  const passwordMutation = useMutation({
    mutationFn: () => api.changePassword(currentPassword, password),
    onSuccess: (result) => {
      setPasswordNotice(result.detail || "Password changed. Other sessions have been revoked.");
      setCurrentPassword("");
      setPassword("");
      setConfirmPassword("");
    },
  });
  const disableMutation = useMutation({
    mutationFn: () => api.disableMfa(disablePassword),
    onSuccess: async () => {
      setShowDisable(false);
      setDisablePassword("");
      setRecoveryCodes([]);
      setMfaConfirmed(false);
      await refreshSession();
    },
  });

  const changePassword = (event: FormEvent) => {
    event.preventDefault();
    setPasswordNotice(null);
    if (password.length < 12 || password !== confirmPassword) return;
    passwordMutation.mutate();
  };

  const mfaError = mfaOperationError || (disableMutation.error
    ? errorMessage(disableMutation.error, "Could not update MFA.")
    : null);
  const mfaEnabled = Boolean(user?.mfaEnabled || mfaConfirmed);
  const currentStep = recoveryCodes.length > 0 || mfaEnabled ? 3 : setup ? 2 : 1;
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
    <section className={`card card-pad account-panel authenticator-panel${guidedMfa ? " authenticator-panel-guided" : ""}`} aria-labelledby="mfa-heading">
      <div className="authenticator-heading">
        <div>
          <h2 className="card-title" id="mfa-heading">{guidedMfa ? "Set up your authenticator" : "Authenticator app"}</h2>
          <p className="muted account-copy">
            {mfaEnabled
              ? "Your authenticator protects this account at sign-in."
              : "Use an app such as Google Authenticator, Microsoft Authenticator or 1Password to get your sign-in codes."}
          </p>
        </div>
        {!guidedMfa && <StatusBadge status={mfaEnabled ? "active" : "inactive"} />}
      </div>
      {!mfaEnabled && !guidedMfa && user?.mfaEnrollmentRequired && (
        <p className="authenticator-deadline">Required for your role{user.mfaGraceEndsAt ? ` by ${fmtDateTime(user.mfaGraceEndsAt)}` : ""}.</p>
      )}
      {(guidedMfa || setup || recoveryCodes.length > 0) && (
        <ol className="authenticator-steps" aria-label="Authenticator setup steps">
          {["Confirm password", "Scan & verify", "Save recovery codes"].map((label, index) => (
            <li key={label} className={currentStep === index + 1 ? "current" : currentStep > index + 1 ? "complete" : ""} aria-current={currentStep === index + 1 ? "step" : undefined}>
              <span aria-hidden="true">{currentStep > index + 1 ? <Icon name="check" size={16} /> : index + 1}</span>
              {label}
            </li>
          ))}
        </ol>
      )}
      {mfaError && <div className="auth-error" role="alert">{mfaError}</div>}

      {!mfaEnabled && !setup && (
        <form className="authenticator-confirm-password" onSubmit={(event) => { event.preventDefault(); void runMfaOperation("setup"); }}>
          <h3>Confirm your password</h3>
          <p className="muted">Enter your current password{guidedMfa ? " — the new one you just chose" : ""} to protect this setup.</p>
          <Field label="Current password" required>
            <input
              type="password"
              value={mfaSetupPassword}
              onChange={(event) => setMfaSetupPassword(event.target.value)}
              autoComplete="current-password"
              required
            />
          </Field>
          <button className="btn btn-primary" type="submit" disabled={mfaOperation !== null || !mfaSetupPassword}>
            {mfaOperation === "setup" ? "Preparing…" : "Set up authenticator"}
          </button>
        </form>
      )}
      {setup && (
        <div className="mfa-setup authenticator-scan">
          <div className="authenticator-scan-grid">
            <div className="authenticator-qr">
              <QRCodeSVG
                value={setup.provisioningUri}
                size={208}
                level="M"
                marginSize={4}
                role="img"
                title="Scan to add NPA Vessel Caller to your authenticator"
                aria-label="Scan to add NPA Vessel Caller to your authenticator"
              />
            </div>
            <div className="authenticator-scan-instructions">
              <h3 ref={scanHeading} tabIndex={-1}>Scan with your authenticator app</h3>
              <p>Open the app on your phone, choose to add an account, then scan this QR code.</p>
              <p>Using this phone? <a href={setup.provisioningUri}>Add to authenticator</a></p>
              <details className="authenticator-manual">
                <summary>Can’t scan the QR code?</summary>
                <p>Choose to enter a setup key in your app. Use <strong>{user?.email}</strong> as the account name and select <strong>Time based</strong>.</p>
                <code className="authenticator-setup-key">{setup.secret}</code>
                <button className="btn btn-secondary btn-sm" type="button" onClick={() => void copyValue(setup.secret, "Setup key copied.")}>Copy setup key</button>
              </details>
            </div>
          </div>
          <form className="authenticator-verify" onSubmit={(event) => { event.preventDefault(); void runMfaOperation("confirm"); }}>
            <h3>Enter the code shown in the app</h3>
            <Field label="Authenticator code" required hint="Use the current six-digit code. It changes every 30 seconds.">
              <input
                className="authenticator-code-input"
                value={mfaCode}
                onChange={(event) => setMfaCode(event.target.value.replace(/\D/g, "").slice(0, 6))}
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]{6}"
                maxLength={6}
                required
              />
            </Field>
            <div className="authenticator-buttons">
              <button className="btn btn-primary" type="submit" disabled={mfaOperation !== null || !/^\d{6}$/.test(mfaCode)}>
                {mfaOperation === "confirm" ? "Verifying…" : "Enable MFA"}
              </button>
              <button className="btn btn-secondary" type="button" disabled={mfaOperation !== null} onClick={() => { setSetup(null); setMfaCode(""); setMfaOperationError(null); setCopyNotice(null); }}>Cancel</button>
            </div>
          </form>
        </div>
      )}

      {mfaEnabled && !guidedMfa && recoveryCodes.length === 0 && (
        <div className="account-actions">
          <Field label="Current authenticator code" required hint="Required before replacing your recovery codes.">
            <input
              value={recoveryCode}
              onChange={(event) => setRecoveryCode(event.target.value.replace(/\D/g, "").slice(0, 6))}
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
            />
          </Field>
          <div className="authenticator-buttons">
            <button className="btn btn-secondary" type="button" onClick={() => void runMfaOperation("regenerate")} disabled={mfaOperation !== null || !/^\d{6}$/.test(recoveryCode)}>
              {mfaOperation === "regenerate" ? "Replacing…" : "New recovery codes"}
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
        <div className="recovery-codes authenticator-recovery" role="status">
          <div className="authenticator-success"><Icon name="check" size={18} />Authenticator enabled</div>
          <h3 ref={recoveryHeading} tabIndex={-1}>Save your recovery codes</h3>
          <p>Keep these somewhere safe, separate from your phone. Each code lets you sign in once if you lose access to your authenticator. They will not be shown again after you leave this page.</p>
          <ul>{recoveryCodes.map((code) => <li key={code}><code>{code}</code></li>)}</ul>
          <button className="btn btn-secondary btn-sm" type="button" onClick={() => void copyValue(recoveryCodes.join("\n"), "Recovery codes copied.")}>Copy codes</button>
          <label className="authenticator-acknowledgment">
            <input type="checkbox" checked={codesSaved} onChange={(event) => setCodesSaved(event.target.checked)} />
            <span>I have saved my recovery codes</span>
          </label>
          <button className="btn btn-primary" type="button" disabled={!codesSaved || refreshPending || sessionRefreshFailed} onClick={finishEnrollment}>
            {guidedMfa ? "Continue to workspace" : "Done"}
          </button>
        </div>
      )}
      {guidedMfa && mfaEnabled && recoveryCodes.length === 0 && (
        <div className="authenticator-already-enabled">
          <div className="authenticator-success"><Icon name="check" size={18} />Authenticator already enabled</div>
          <p>You can continue to your workspace. If you need new recovery codes, replace them in Account & Security.</p>
          <button className="btn btn-primary" type="button" onClick={finishEnrollment}>Continue to workspace</button>
        </div>
      )}
      {copyNotice && <p className="authenticator-copy-notice" role="status">{copyNotice}</p>}
      {sessionRefreshFailed && (
        <div className="authenticator-refresh" role="alert">
          <p>Your authenticator is enabled and your recovery codes are ready to save. We could not refresh your account status.</p>
          <button className="btn btn-secondary btn-sm" type="button" disabled={refreshPending} onClick={() => void refreshAfterEnrollment()}>{refreshPending ? "Refreshing…" : "Retry account refresh"}</button>
        </div>
      )}
    </section>
  );

  if (guidedMfa) return authenticatorPanel;

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
