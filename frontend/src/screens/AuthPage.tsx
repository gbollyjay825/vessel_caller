// Login + organization registration. Real auth against the FastAPI backend.
import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";

import { useAuth } from "../auth/AuthContext";
import { ApiError } from "../lib/api";

const anchor = (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 22V8" /><path d="M5 12H2a10 10 0 0 0 20 0h-3" /><circle cx="12" cy="5" r="3" />
  </svg>
);

export function AuthPage({ mode }: { mode: "login" | "register" }) {
  const { login, register } = useAuth();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // login fields
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  // register fields
  const [name, setName] = useState("");
  const [orgName, setOrgName] = useState("");
  const [port, setPort] = useState("Port of Calabar");

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      if (mode === "login") {
        await login(email.trim(), password);
      } else {
        await register({ name: name.trim(), email: email.trim(), password, orgName: orgName.trim(), designatedPort: port });
      }
      navigate("/app", { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  const fillDemo = () => { setEmail("admin@calabarport.ng"); setPassword("demo1234"); };

  return (
    <div className="auth-wrap">
      <form className="auth-card" onSubmit={submit}>
        <div className="auth-brand"><span className="auth-mark">{anchor}</span> Vessel Caller</div>
        <h1 className="auth-title">{mode === "login" ? "Sign in" : "Register your organization"}</h1>
        <p className="auth-sub">
          {mode === "login"
            ? "Access your port-inspection console."
            : "Create your agency and its first admin account."}
        </p>

        {error && <div className="auth-error">{error}</div>}

        {mode === "register" && (
          <>
            <label className="auth-field"><span>Your name</span>
              <input value={name} onChange={(e) => setName(e.target.value)} required autoComplete="name" />
            </label>
            <label className="auth-field"><span>Organization name</span>
              <input value={orgName} onChange={(e) => setOrgName(e.target.value)} required />
            </label>
            <label className="auth-field"><span>Designated port</span>
              <select value={port} onChange={(e) => setPort(e.target.value)}>
                {["Port of Calabar", "Apapa Port, Lagos", "Tin Can Island Port, Lagos",
                  "Onne Port, Rivers", "Port Harcourt Port", "Warri Port, Delta"].map((p) => (
                  <option key={p} value={p}>{p}</option>
                ))}
              </select>
            </label>
          </>
        )}

        <label className="auth-field"><span>Email</span>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" />
        </label>
        <label className="auth-field"><span>Password</span>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required
            autoComplete={mode === "login" ? "current-password" : "new-password"} minLength={8} />
        </label>

        <button className="auth-submit" type="submit" disabled={busy}>
          {busy ? "Please wait…" : mode === "login" ? "Sign in" : "Create organization"}
        </button>

        {mode === "login" ? (
          <>
            <button type="button" className="auth-demo" onClick={fillDemo}>Use demo credentials</button>
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
