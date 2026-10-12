import type { ReactNode } from "react";
import { Link } from "../lib/navigation";
import { ProductBrand } from "./ProductBrand";

interface AuthCardProps {
  title: string;
  subtitle: string;
  children: ReactNode;
}

export function AuthCard({ title, subtitle, children }: AuthCardProps) {
  return (
    <div className="auth-wrap">
      <div className="auth-card">
        <ProductBrand className="auth-brand" />
        <h1 className="auth-title">{title}</h1>
        <p className="auth-sub">{subtitle}</p>
        {children}
        <p className="auth-alt"><Link to="/">← Back to home</Link></p>
      </div>
    </div>
  );
}
