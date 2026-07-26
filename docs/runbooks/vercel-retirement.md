# Vercel production retirement and staging retention

Vercel remains the protected static-frontend staging tier. It must never become
a production API/data tier. These changes happen only after Django production
has completed seven successful days of hypercare.

1. Confirm `vesselcalls.com` production DNS/TLS/traffic terminate at the
   FlexSchools Droplet.
2. Convert the dedicated Vercel project to staging-only:
   `staging.vesselcalls.com`, deployment protection on, no public preview
   branches, and scoped automation bypass.
3. Route same-origin staging `/api` to
   `https://staging-api.vesselcalls.com`; keep Django/Celery/Redis/PostgreSQL on
   the isolated staging backend tier.
4. Remove Vercel runtime/fallback API code, localStorage/demo behavior, and any
   production custom domain in an independently qualified release.
5. Remove production database, Spaces, Resend, Sentry, payment, or operator
   credentials from every Vercel environment. The only repository secrets are
   scoped staging deployment identifiers/token/bypass values.
6. Deploy only the exact qualified frontend from the signed release using
   pinned CLI and `--prebuilt`; do not run a second application build on
   Vercel.
7. Search frontend/API/network logs for old Vercel production/demo URLs and
   correct clients, links, callbacks, webhooks, and documentation.
8. Record production-domain removal, environment-variable inventory, staging
   protection, deployed artifact checksum, proxy/E2E evidence, and token scope
   in E14-S05.

CI and Ansible never delete the Vercel project.
