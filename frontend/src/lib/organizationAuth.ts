/** Preserve the account scope without retaining any credential in navigation. */
export function organizationAuthPath(path: string, organizationId?: string | null): string {
  return organizationId ? `${path}?organizationId=${encodeURIComponent(organizationId)}` : path;
}
