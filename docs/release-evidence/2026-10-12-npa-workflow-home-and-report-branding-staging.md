# NPA voyage home and report branding on staging — 12 October 2026

Frontend-only overlay `npa-workflow-20261012T223341Z` is deployed to [staging](https://staging.vesselcalls.com), verified at 22:40 UTC / 23:40 Lagos. Source commit: `5311e3fc9512b57a60a7f3853cf1ffdc9c6f1c95`.

The public home now explains the current import voyage workflow: vessel and owner's paid declaration, independent agency readings, the side-by-side Readings report, NPA's reviewed final quantities, and an invoice preview for extra load. Lower final quantities flag overpayment for review. The comparison is explicitly labeled illustrative; NPA's final quantity is a reviewed decision, not an automatic average. The home provides a direct workspace entry and explains email invitations and Admin-approved organization join requests. It states the existing browser-saved reconciliation/invoice preview boundary. It removes the previous inspection, automatic harbour-dues, receivables and offline-capture marketing claims.

Readings reports and saved variation invoice previews now share the same **NPA Vessel Caller** name and official NPA crest used by login and sign-up. The invoice retains the brand in print. Browser title, page description and installed-app description match the voyage workflow; the installed-app start URL is `/app/dashboard`.

## Validation

- Node 22.23.1 same-origin production build, TypeScript and lint passed. Existing focused tests passed: 36 report tests, 12 landing/public-flow tests and 46 authentication/public/guest-flow tests. These sets can overlap and are not reported as a total.
- Final built homepage checked at 320, 390, 640, 768, 840, 900, 1024 and 1440px: crest loaded, header fits, mobile navigation works, no viewport overflow and example-table scrolling remains inside its card. Scroll-reveal content was exercised before full-page screenshots.
- Readings and saved invoice previews checked at 320, 390 and 1440px using isolated sample records. A4 print-media rendering preserves brand, quantities, total and preview notice while hiding app chrome/actions. No unexpected API requests or runtime errors occurred. This is layout evidence using sample data, not a staging financial journey or an actual exported PDF.
- Live staging browser verified the new home title, navigation, voyage-flow copy, labeled comparison and loaded crest. Live sign-up also displays the same name and loaded crest. Screenshot: `/Users/gbolahan.salami/.codex/preview/vessel-agency-ui/evidence/staging-npa-voyage-home-20261012.png`.
- The signed-in staging account had no voyage records during this verification; no sample voyages, reconciliation decisions, invoices, users or emails were created.

## Deployment and rollback

Archive SHA256: `86386629b4249b3cdecd138df7435b3a723704e3ade79c113002429a64c94f0e`. Root independently verified all 15 checksum entries, exact nine reviewed source paths, source commit and equality with the final built dist. The 14-file dist changes application JS/CSS, HTML title/description, manifest description/start URL and overlay metadata. All other public assets, logo/favicons, provenance and service worker remain byte-identical to the previous overlay. This is not a new signed backend release.

Application assets:

- `assets/index-CWu48fSg.js`: `d98e0609ef488667ca53c15cbfe161a34c9bc242bc3c398a0f710d125666f9b0`
- `assets/index-C46V4diZ.css`: `117c0fe4a52a4ad577f0187fb42c62ce051e454e42e0fc29bb1a9e6780adfd16`

All SSH sessions used the pinned FlexSchools connector. An initial preflight stopped before changing the static target because a new generic ancestry guard assumed the staging slot group was root. Read-only inspection confirmed the existing slot is `root:vessel-caller-staging:751`, with no group/other write permissions. The guard was corrected to pin that exact existing owner/group/mode; no remote directory permissions were changed. The reviewed wrapper's final SHA256 is `725092452c9a789844305219aec9cccd2fc35d6d21d16def59f68de17640267c`.

The successful deployment held the release lock, validated root-owned inputs, prior static target, backend identity and runtime/configuration pins, then atomically replaced only the static symlink with rollback protection. HTTPS responses for release metadata, HTML, JS/CSS, manifest, crest and favicon assets matched installed bytes. Nginx configuration validation passed without reload.

Current static target: `/opt/vessel-caller/frontend-releases/staging/npa-workflow-20261012T223341Z/dist`. Rollback target: `/opt/vessel-caller/frontend-releases/staging/npa-brand-20261012T221813Z/dist`. A rollback must hold the release lock and verify that the current static target remains this overlay before replacing only `frontend-current`.

Backend remains `v0.2.2-staging.20261012T2113` / `65aa3618e60ffac60221c9cf1611ff6c2a309044`; readiness is `ready` with database/cache true. Web, worker and Nginx PIDs remain `145334`, `145320` and `18608`; all three Nginx configuration hashes are unchanged. No service restart/reload, backend code, migration, database or production changes occurred. Invitation email acceptance testing remains paused at the user's request.
