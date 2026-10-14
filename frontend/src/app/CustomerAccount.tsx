import { useState } from "react";

import { useAuth } from "../auth/AuthContext";
import { Icon } from "../components/Icon";
import { PRODUCT_NAME, ProductBrand } from "../components/ProductBrand";
import { Link, useLocation, useNavigate } from "../lib/navigation";
import { AccountSecurity } from "../screens/AccountSecurity";

// Account recovery must remain available when tenant data access is blocked.
export function CustomerAccount() {
  const { user, org, can, logout } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  // The nonsecret route marker survives a reload; setup material stays in the panel.
  const [guidedMfa] = useState(() => new URLSearchParams(location.search).get("setup") === "authenticator");
  const enrollmentRequired = Boolean(user?.mfaEnrollmentRequired);
  const [beganEnrollment] = useState(enrollmentRequired);
  const workspaceAvailable = can("organization.view");
  const passwordUpdated = Boolean(location.state && typeof location.state === "object" && "passwordUpdated" in location.state && location.state.passwordUpdated);
  const finishSetup = () => {
    const requested = location.state && typeof location.state === "object" && "from" in location.state ? location.state.from : null;
    const destination = typeof requested === "string" && /^\/app(?:\/|\?|$)/.test(requested)
      && !requested.startsWith("/app/account") ? requested : "/app";
    navigate(destination, { replace: true });
  };

  return (
    <div className="account-workspace">
      <header className="topbar account-workspace-header">
        {guidedMfa ? <ProductBrand subtitle={org?.name || "Account setup"} /> : <div>
          <h1>Account &amp; Security</h1>
          <p className="muted">{org?.name || PRODUCT_NAME}</p>
        </div>}
        <button className="btn btn-ghost" type="button" onClick={() => void logout()}>
          <Icon name="logout" size={16} />Sign out
        </button>
      </header>
      <main className="content scroll-host">
        {guidedMfa ? <div className="content-inner account-workspace-intro account-onboarding-intro">
          {passwordUpdated && <p className="account-onboarding-complete"><Icon name="check" size={16} /> Password updated</p>}
          <h1>Secure your account</h1>
          <p className="muted">Connect an authenticator on your phone, then save your recovery codes. We’ll guide you through each step.</p>
        </div> : <div className="content-inner account-workspace-intro">
          <section className="card card-pad" aria-labelledby="account-access-heading">
            <div className="account-access-heading">
              <Icon name={enrollmentRequired ? "alert" : "check"} size={22} />
              <div>
                <h2 id="account-access-heading">
                  {enrollmentRequired ? "Set up MFA to open your workspace" : beganEnrollment ? "MFA is enabled" : "Your account"}
                </h2>
                <p className="muted account-copy">
                  {enrollmentRequired
                    ? "Your role requires two-factor authentication. Use your password and authenticator app below to restore workspace access."
                    : beganEnrollment
                      ? "Save the recovery codes below before opening your workspace. Keep them somewhere secure in case you lose your authenticator."
                      : "Manage your sign-in details and security here."}
                </p>
              </div>
            </div>
            {workspaceAvailable && (
              <div className="flex gap-3" style={{ flexWrap: "wrap" }}>
                <Link className="btn btn-primary" to="/app">Open workspace</Link>
                {can("users.view") && <Link className="btn btn-secondary" to="/app/users"><Icon name="users" size={16} />Manage users</Link>}
              </div>
            )}
          </section>
        </div>}
        {/* Keep this component mounted after session refresh so recovery codes stay visible. */}
        <AccountSecurity initialTab={beganEnrollment ? "security" : "profile"} prioritizeMfa={beganEnrollment}
          guidedMfa={guidedMfa} onMfaSetupComplete={finishSetup} />
      </main>
    </div>
  );
}
