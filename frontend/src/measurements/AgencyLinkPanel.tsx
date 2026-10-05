import { useRef, useState } from "react";
import { dateLabel } from "./helpers";
import { ErrorMessage } from "./shared";
import type { CreatedAgencyLink } from "./AgencyCollection";
import "../styles/agency-collection.css";

export interface AgencyLinkPanelProps {
  agencyName: string;
  link: CreatedAgencyLink;
  onRevoke?: () => Promise<unknown>;
  onReplace?: () => Promise<CreatedAgencyLink>;
}

// The parent owns the displayed link and updates it after replacement, keeping
// its revoke callback scoped to that same link. URLs remain in memory only.
export function AgencyLinkPanel(props: AgencyLinkPanelProps) {
  return <LinkPanel key={props.link.link.id} {...props} />;
}

function LinkPanel({ agencyName, link, onRevoke, onReplace }: AgencyLinkPanelProps) {
  const [copied, setCopied] = useState(false);
  const [revoked, setRevoked] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const busy = useRef(false);
  const run = async (action: () => Promise<unknown>) => {
    if (busy.current) return;
    busy.current = true; setPending(true); setError(null);
    try { await action(); } catch (failure) { setError(failure); }
    finally { busy.current = false; setPending(false); }
  };
  if (revoked || link.link.revokedAt) return <p className="agency-link-message" role="status">Link revoked.</p>;
  return <div className="agency-link-panel" role="region" aria-label={`Agency link for ${agencyName}`}>
    <div className="agency-link-copy"><label className="measurement-field"><span>Link for {agencyName}</span><input readOnly value={link.url} onFocus={event => event.currentTarget.select()} /></label><button type="button" className="btn btn-secondary" disabled={pending} onClick={() => void run(async () => { await navigator.clipboard.writeText(link.url); setCopied(true); })}>{copied ? "Copied" : "Copy"}</button></div>
    <p className="agency-link-message">Valid until {dateLabel(link.link.expiresAt)}. Share only with this agency.</p>
    {(onReplace || onRevoke) && <details className="agency-link-options"><summary>Link options</summary><div>{onReplace && <button type="button" className="link-btn" disabled={pending} onClick={() => void run(async () => { await onReplace(); setCopied(false); })}>Replace link</button>}{onRevoke && <button type="button" className="link-btn" disabled={pending} onClick={() => void run(async () => { await onRevoke(); setRevoked(true); })}>Revoke link</button>}</div><p>Replacing or revoking a link disables the previous link.</p></details>}
    <ErrorMessage error={error} />
  </div>;
}
