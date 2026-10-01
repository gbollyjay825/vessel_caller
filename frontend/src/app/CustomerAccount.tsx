import { useState } from "react";

import { useAuth } from "../auth/AuthContext";
import { Icon } from "../components/Icon";
import { Link } from "../lib/navigation";
import { AccountSecurity } from "../screens/AccountSecurity";

// Account recovery must remain available when tenant data access is blocked.
export function CustomerAccount() {
  const { user, org, can, logout } = useAuth();
  const enrollmentRequired = Boolean(user?.mfaEnrollmentRequired);
  const [beganEnrollment] = useState(enrollmentRequired);
  const workspaceAvailable = can("organization.view");

  return (
    <div className="account-workspace">
      <header className="topbar account-workspace-header">
        <div>
          <h1>Account &amp; Security</h1>
          <p className="muted">{org?.name || "Vessel Caller"}</p>
        </div>
        <button className="btn btn-ghost" type="button" onClick={() => void logout()}>
          <Icon name="logout" size={16} />Sign out
        </button>
      </header>
      <main className="content scroll-host">
        <div className="content-inner account-workspace-intro">
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
            {workspaceAvailable && <Link className="btn btn-primary" to="/app">Open workspace</Link>}
          </section>
        </div>
        {/* Keep this component mounted after session refresh so recovery codes stay visible. */}
        <AccountSecurity initialTab={beganEnrollment ? "security" : "profile"} prioritizeMfa={beganEnrollment} />
      </main>
    </div>
  );
}
