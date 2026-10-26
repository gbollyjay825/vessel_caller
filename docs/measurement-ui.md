# Import voyage declarations and agency readings

The vessel is an entity with a separate record for each voyage. Each voyage has an owner declaration and independent agency readings. NPA chooses and records the final quantities after comparing those readings. The UI continues from **Readings → Reconciliation → Invoice**, with an activity dashboard guiding the next unfinished step on each voyage.

Variation is a calculation within the voyage's invoice view: **NPA final quantity minus owner declared quantity**, for each cargo item and unit. The original declaration invoice remains the paid baseline. Positive additional quantities can produce an additional invoice; equal quantities need no additional invoice; lower quantities are flagged for overpayment review. The app does not automatically net lower quantities against other cargo or create a credit note.

## Linear input flow

1. **Setup vessel.** Select the vessel and its recorded voyage. Users permitted to register calls can open **Register vessel / voyage** in a separate tab. Optional berth, schedule and survey lead details stay collapsed. The lead defaults to “To be assigned.” Changing an edited voyage requires confirmation before clearing its declaration.
2. **Owner declaration.** Choose the cargo type, enter the owner’s reference and copy quantities into the paper’s matching categories. Container presets use 20, 40 and 45 ft, each laden/empty. Vehicle presets include Cars, Buses, Trucks and Mafi Trailer / HDV. Tanker items identify the cargo/product, including petroleum, chemicals or gas. Mixed cargo preserves separate items and units. Blank is unknown; 0 is an explicit NIL declaration.
3. **Agencies.** Select reusable directory entries or create an agency inline. Confirm its attending representative, then **Create voyage sheet**. There is no separate review/scheduling step. A compact review disclosure is optional.
4. **Report vessel load.** Each selected agency has its own card, submission status and quantities. Staff can open the chosen agency’s reading form. Owner quantities remain in a separate declaration disclosure. The default screen has no reconciliation or disparity billing actions.

Agency setup is available directly through **Agencies**. It is browser-local and organization-scoped, not a shared backend directory. Saved agency snapshots on existing voyage sheets retain the names and representatives copied at creation. The vessel selector groups existing calls by name and flag; it does not create a persistent vessel registry.

## Reconciliation, variation and activity: UI preview

- `/app/dashboard` recommends one next action with the vessel, voyage and missing agency names or declaration context. A compact Declaration / Agency readings / NPA review / Invoice strip and attention worklist show outstanding work. Prepared drafts and no-charge outcomes sit in a secondary disclosure; dated activity shows three recent actions with expandable history. Search and stage filters apply to the recommendation, counts, worklist and activity together. Draft amounts stay separate by currency; prepared previews do not imply issued invoices or completed voyages.
- `/app/measurements/voyages/:callId/reconciliation` compares owner and latest agency quantities with NPA's chosen final quantity, per-item rationale and variance. Required submissions and complete declarations gate approval. Cancelled sheets are excluded. Approvals retain a frozen source snapshot, actor, time and revision in organisation-scoped browser storage. A changed source requires a new approval; previous versions remain in history. Print/save PDF uses the saved report and labels it as a preview.
- `/app/measurements/voyages/:callId/variation-invoice` requires a current approved preview. The owner’s original invoice/payment details are separate from previous variation charges. Manual rates calculate only the positive final-minus-declared quantity, then deduct previous charges for that same additional quantity. Integer decimal arithmetic preserves cents. The original declaration payment is never deducted from the variation or charged again. Missing inputs block saving. Equal quantities produce no additional charge; lower quantities flag overpayment for review without a credit note or refund; previous variation charges exceeding entitlement hold billing. A review/hold outcome blocks a payable total across mixed rows.
- `/app/variation-invoices` is labelled **Invoices** and lists voyage invoice previews with the original paid declaration context, additional charge or review outcome, saved versions and reconciliation freshness. Repeated generation of an unchanged draft is idempotent. Printed invoice previews use the selected saved snapshot, even if the editor contains unsaved changes.

These new screens make no backend mutations: only the existing measurement list is read. Reports, draft invoices and their activity events are local UI review records, not operational approvals or issued NPA documents. They do not verify accounting payment, tariff authority or production permissions. There are no schema, endpoint, infrastructure or staging changes in this iteration. The NPA logo and shared green brand tokens are retained, with navigation limited to Dashboard, Voyages, Invoices and Agencies. Vessel setup remains accessible within Voyages.

## No-login agency form: frontend prepared for review

When a server supports agency links, staff can generate an agency-specific link with an expiry, copy it and revoke unused links. This UI does not send messages. The public `/agency-reading` route sits outside the staff login flow. It removes the token fragment before its first network request and exchanges it through a separate guest adapter. Only a non-secret context ID stays in the address.

The agency is fixed to the form. It enters its representative, observation time, source reference and every applicable quantity. Explicit NIL is 0; blank is unknown and cannot be submitted; N/A requires an explanation. Owner quantities are omitted from guest entry to preserve independent measurements.

After submission, the form shows the submitted record, **Download your PDF** and completed peer quantities from this same measurement sheet. Peer readings are hidden until the agency submits. Peer summaries omit representatives, source references, notes and evidence. The PDF action is restricted to the agency’s own report. A lost submission response first refreshes the same context; an identical retry preserves its request ID. A different context never silently replaces it.

These frontend protections are not security enforcement. The backend endpoints, token validation, guest session authorization, idempotent publication, durable report storage and PDF generation are not implemented in this UI-only change. The review server uses isolated in-memory demo records and labels the interaction as a preview. No real agency access is granted. On existing servers that lack the link endpoints, link and PDF controls are hidden and the public route reports the feature unavailable.

## Prepared endpoint contract

The staff adapter expects:

- `GET /api/measurement-plans/{planId}/agency-links`
- `POST /api/measurement-plans/{planId}/participants/{participantId}/agency-links` with `expiryDays`, returning link metadata and its URL once
- `POST /api/measurement-plans/{planId}/agency-links/{linkId}/revoke`
- `GET /api/measurement-plans/{planId}/submissions/{submissionId}/receipt`

The guest adapter expects:

- `GET /api/agency-portal/csrf` → `csrfToken`
- `POST /api/agency-portal/exchange` with `token` → `contextId`
- `GET /api/agency-portal/context?contextId=...` → `context`
- `POST /api/agency-portal/submission` with context ID, input fingerprint, request ID and guest readings → confirmed `context`
- `GET /api/agency-portal/receipt?contextId=...` → `application/pdf`

The server must derive the organization, plan, agency and external actor from the grant and session, validate revocation/expiry/plan state at publication, and return only authorized completed peer quantities after the agency’s own publication. It must bind the guest session to the requested context, preserve idempotent receipts, avoid recording an external submission as the staff link issuer, and freeze receipt data. These are future backend requirements, not implemented capabilities.

## Existing records and verification

The previous workspace remains available at `?workspace=reconciliation` for regression coverage. Its existing reconciliation, assessment and billing behavior is unchanged. Count, tonnes and m3 are never added into a cargo total.

Validation covers the linear setup, inline agency failures, selected agency and version handling, cancellation/permission changes, token removal, ambiguous submission retries, own PDF download, post-submission peer visibility and mobile layouts. Browser guest journeys use API mocks. Existing real-backend regression tests do not establish a working secure-link backend. No schema, permission, billing, infrastructure or staging changes are included.
