import type { ReactNode } from "react";
import { Link } from "../lib/navigation";

interface AuthCardProps {
  title: string;
  subtitle: string;
  children: ReactNode;
}

export function AuthCard({ title, subtitle, children }: AuthCardProps) {
  return (
    <div className="auth-wrap">
      <div className="auth-card">
        <div className="auth-brand">
          <span className="auth-mark" aria-hidden="true">⚓</span>
          Vessel Caller
        </div>
        <h1 className="auth-title">{title}</h1>
        <p className="auth-sub">{subtitle}</p>
        {children}
        <p className="auth-alt"><Link to="/">← Back to home</Link></p>
      </div>
    </div>
  );
}
