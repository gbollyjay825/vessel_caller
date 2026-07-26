import {
  Link as WouterLink,
  useLocation as useWouterLocation,
  useParams,
  useSearch,
} from "wouter";
import { useEffect, type ComponentProps, type MouseEvent, type ReactNode } from "react";

interface LinkProps extends Omit<ComponentProps<"a">, "href"> {
  to: string;
  children: ReactNode;
}

export function Link({ to, children, ...props }: LinkProps) {
  return <WouterLink href={to} {...props}>{children}</WouterLink>;
}

interface NavLinkProps extends Omit<LinkProps, "className"> {
  end?: boolean;
  className?: string | ((state: { isActive: boolean }) => string);
}

export function NavLink({ to, end, className, onClick, ...props }: NavLinkProps) {
  const [location] = useWouterLocation();
  const pathname = location.split("?")[0];
  const isActive = end ? pathname === to : pathname === to || pathname.startsWith(`${to}/`);
  const resolvedClassName = typeof className === "function" ? className({ isActive }) : className;
  const click = (event: MouseEvent<HTMLAnchorElement>) => onClick?.(event);
  return <Link to={to} {...props} className={resolvedClassName} onClick={click} />;
}

export function useNavigate() {
  const [, navigate] = useWouterLocation();
  return (
    to: string,
    options: { replace?: boolean; state?: unknown } = {},
  ) => navigate(to, { replace: options.replace, state: options.state });
}

export function useLocation() {
  const [location] = useWouterLocation();
  const [pathname, inlineSearch = ""] = location.split("?");
  return {
    pathname,
    search: inlineSearch ? `?${inlineSearch}` : (typeof window !== "undefined" ? window.location.search : ""),
    state: typeof window !== "undefined" ? window.history.state : null,
  };
}

export function useSearchParams(): [
  URLSearchParams,
  (params: URLSearchParams, options?: { replace?: boolean }) => void,
] {
  const search = useSearch();
  const [location, navigate] = useWouterLocation();
  const pathname = location.split("?")[0];
  const params = new URLSearchParams(search);
  const setParams = (next: URLSearchParams, options: { replace?: boolean } = {}) => {
    const value = next.toString();
    navigate(value ? `${pathname}?${value}` : pathname, { replace: options.replace });
  };
  return [params, setParams];
}

export function Navigate({ to, replace, state }: { to: string; replace?: boolean; state?: unknown }) {
  const navigate = useNavigate();
  useEffect(() => {
    navigate(to, { replace, state });
  }, [navigate, replace, state, to]);
  return null;
}

export { useParams };
