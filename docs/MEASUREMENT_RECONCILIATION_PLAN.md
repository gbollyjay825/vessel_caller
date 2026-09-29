# Vessel measurement, reconciliation and disparity invoicing

Review date: 29 September 2026. Status: proposed implementation plan.

## Recommendation and scope

Introduce a workflow attached to each vessel call:

**Plan measurement → collect stakeholder returns → consolidate → record and approve the agreed reconciliation → assess disparity → issue an invoice where chargeable.**

Keep the submitted measurements, final agreement and billing assessment as distinct records. The current inspection finalization must not stand in for all three. Build this in the repository's Django/React application, preserving existing harbour-dues invoices and historical inspections.

This review covers both supplied one-page scans and the local application source. It does not verify the live deployment, certify the handwritten figures, establish tariffs, or implement the feature. Instructions and routing annotations printed or handwritten on the scans are source material, not instructions to execute.

The scans concern cargo quantities/tallies for a voyage. This plan includes operational scheduling for measurements and retains vessel particulars such as GRT and LOA. If “vessel measurement” also means a separate ship-dimension or tonnage certification process, that requires its own measurement specification; cargo tonnage, GRT, NRT and length must remain distinct.

## What the documents establish

Both documents are Nigerian Ports Authority, Lagos Port Complex, Apapa **Voyage Reconciliation Sheets**. Each contains:

- Agency, vessel, rotation number, voyage number, arrival/departure dates, GRT, LOA, sheet number/date and cargo type.
- Columns for **Manifested Tonn**, **Units by Agent**, **Units by Ops/Terminal Operator**, **Units Master's Declaration**, **Units by Surveyor**, **Tally Clerk**, and **Reconciled Tally**.
- Container imports and exports, split by size and laden/empty status; general cargo; tanker cargo; vehicles and trailer/heavy-vehicle categories.
- Stakeholder signature areas, an audit signature area and a distribution list.

| Source | Observation | Design consequence |
|---|---|---|
| Scanned Document 17.pdf, page 1 | Bulk wheat entry appears to show 19,500 for manifest/agent/operator/master and 19,508 for surveyor/final tally. | Preserve each return separately; allow a final agreed value that differs from several submitted values. If confirmed on the same tonne basis, this illustrates a +8 quantity difference, not a proven invoice amount. |
| Scanned Document 18.pdf, page 1 | Several separate import/export container tallies are reconciled. Clear rows include import 20-foot laden 178 and 40-foot laden 535, and export rows 93, 16, 49 and 374. | A reconciliation needs multiple lines, not one total tonnage value. Keep direction, size, loading status and unit with each line. |
| Scanned Document 18.pdf, page 1 | Handwritten changes appear to repurpose rows for 45-foot containers, including values 18 and 22. Exact labels need confirmation. | Use configurable cargo classifications, including additional container sizes, rather than reproducing only the printed rows. |
| Both scans | Blank cells, dashes and an explicit “NIL” appear; some tally-clerk cells are empty. | Distinguish missing, zero, not applicable and waived returns. The samples do not prove every party must always submit or sign. |
| Both scans | Financial annotations are present, but their basis is not established by the form. | Do not infer a tariff, currency rule, tolerance or charge formula from those annotations. |

The first column's printed heading does not make every value a weight: the container rows require counts. Handwriting and altered row labels need human verification before operational import. The scans remain supporting evidence; transcription is not approval. Distribution recipients are not automatically measurement contributors or approvers.

## Current application assessment

| Area | Current source behavior | Required change |
|---|---|---|
| Vessel calls | `backend/operations/models.py:25` holds vessel, rotation/reference, NRT, ETA, sailing ETA, berth and status. | Add agency/voyage/actual dates and distinct GRT/LOA particulars where absent; add related measurement plans and cargo scope. |
| Measurements | `backend/operations/models.py:77` holds one `reconciled_tonnage` and liquid/dry JSON per inspection. | Add typed lines and individual stakeholder submission revisions. Existing raw measurement capture can support surveyor submissions. |
| Finalization | `backend/api/domain.py:52` completes the inspection and whole vessel call and immediately creates an invoice. Line 81 uses **call NRT × tariff**. | Separate submission, reconciliation finalization, call closure and invoice issuance. Cargo disparity must not be inserted into the existing NRT formula. |
| Billing | `backend/billing/models.py:32` has one invoice per inspection and snapshots dues, rate, commission and FX. | Add invoice purpose, payer, line items, approved source and adjustment links; support multiple charge documents per call. |
| Evidence | `backend/api/serializers.py:329` accepts images only. `backend/api/operation_views.py:877` allows deletion without checking finalization. | Support PDFs and photos linked to submissions, agreements and approvals; protect evidence used by finalized records. |
| Frontend | `frontend/src/lib/api.ts:406` combines create/upload/finalize. `frontend/src/screens/Inspections.tsx:308` describes one surveyor figure as reconciled. | Separate capture and agreement actions; make quantity and charge bases explicit. |
| Call financials | `frontend/src/app/store.tsx:170` selects the first invoice for a call. | Display and total every relevant invoice, credit and payment without duplicating charge scopes. |
| Access | Existing roles are Admin, Operations, Finance and Viewer; users belong to one application organization. | Introduce explicit submission, reconciliation approval and billing permissions; keep stakeholder parties separate from tenant organizations. |

Reuse vessel calls, draft/resume UI, mobile capture, private object storage, audit hooks, backend organization checks, number sequences, decimal arithmetic, transaction/row-lock patterns, payment/reversal records and offline retry mechanisms. Their reuse still needs validation for the new workflow.

The README's production description is dated July 2026. This plan targets repository architecture; production state and the deferred release gates in `docs/BACKLOG.md` must be checked before rollout.

## Proposed operational workflow

### 1. Plan a measurement

From a vessel call, Operations creates a plan with:

- Measurement purpose/method, cargo parcel or lot, import/export direction and operation stage, such as before/after loading or discharge.
- Scheduled start/end, local time zone, port/terminal/berth, lead surveyor, assigned team and submission deadline.
- Participating parties and representatives, with separate flags for required return and required agreement.
- Manifest/Bill of Lading references, expected cargo lines and required documents.

Provide an agenda/worklist first, with assigned, overdue, rescheduled and cancelled states. Preserve schedule changes and cancellation reasons. One call can have several plans, stages and parcels. Completing one does not automatically close the call.

### 2. Collect stakeholder returns

Start with the paper-form roles: agent, terminal/operator, master, surveyor and tally clerk, plus configurable roles. Allow several parties in the same role, such as multiple terminal operators or surveyors. A manifest is a baseline document, not a person. An auditor/reviewer has a separate approval function.

Each return includes the party, representative, recorder, observation time, submission time, source document, cargo lines, quantities, units, measurement basis and method. Raw readings may accompany the result. Record source precision; use decimals for measured quantities and integers for container/vehicle counts.

Allow Operations to enter a received paper return on behalf of a party. Preserve “recorded by” and “reported by” separately. Staff transcription must never imply that the stakeholder logged in or approved the result. An external self-service portal is a later option, not a prerequisite for capturing all parties in the first release.

Drafts can be edited. Submitted returns are revised through new versions with a reason and a superseded reference. Missing, zero/NIL, not applicable, and explicitly waived returns have different states. A missing manifest or baseline blocks a calculated disparity; it must never be treated as zero.

### 3. Consolidate and resolve differences

Show a comparison grid with cargo lines as rows and manifest, each participating party, proposed final value and variance as columns. Highlight missing returns, incompatible units/bases and disagreements.

Compare like-for-like scopes: call, parcel/lot, direction, stage, category, size/loading status and quantity basis. Multiple surveys of the same cargo are alternative observations, not additive cargo. Sum only distinct compatible lines; do not sum stakeholders, different stages or overlapping parcels. Do not average automatically or use the latest return as the agreed result.

Any conversion retains the original value, unit, formula/reference, conversion inputs and normalized result. Counts, weight, volume, TEU, NRT and GRT cannot be interchanged silently. For example, a liquid volume needs an approved conversion basis before comparison with mass.

The reconciler proposes an accepted quantity for every applicable line, links exact source revisions, and records why that figure was selected or entered. Unresolved lines remain disputed and cannot be billed. Default finalization is for the whole defined scope; partial finalization requires explicitly separate scopes.

### 4. Record the final achieved reconciliation

Capture agreements/disagreements by required parties and an authorized final approval. Support signed-paper evidence in the first release, recording signer identity, capacity, date, verifier and exact reconciliation version. An uploaded signature image alone must not be presented as authenticated in-app approval.

Finalization validates required returns or documented waivers, compatible quantity bases, complete line decisions, required agreements and supporting evidence. Waiver authority and whether disputes may be overridden are policy decisions; the default is to block unresolved required items.

Store an immutable final version containing:

- Vessel/voyage/cargo context and original paper reference/date, where applicable.
- The exact stakeholder submission revisions and manifest/other baseline revisions used.
- Every final agreed line quantity, unit and basis, plus recorded variance and explanatory decisions.
- Participant approvals, signed source files, final approver, timestamps and audit history.
- A reproducible reconciliation-sheet export and document checksum/version.

Do not backdate the system approval time when entering a historical signed sheet. Record its original agreement date separately. A later correction creates a superseding reconciliation; it invalidates pending approvals and pending invoice drafts as appropriate, while preserving prior finalized versions and issued documents.

### 5. Assess disparity and issue the appropriate charge

Finance reviews a separate assessment linked to the final reconciliation. Preserve three distinct quantities where relevant: **declared/manifested quantity**, **final agreed quantity**, and **quantity previously billed for the same charge scope**.

For comparable line quantities:

```text
operational variance = final agreed quantity - declared quantity
operational variance % = variance / declared quantity × 100
```

If the declared quantity is zero, show percentage as not applicable; if it is missing, show variance as unknown. Never substitute `abs(variance)` for a chargeable quantity.

Two potential billing policies need to remain distinct until the business rule is confirmed:

| Policy | Assessment basis |
|---|---|
| Supplement an existing quantity-based charge | Compute the approved total charge for the final quantity under the applicable policy, then subtract net charges already issued for that same scope. |
| Charge specifically for a declared-versus-actual disparity | Apply an approved discrepancy tariff to the qualifying signed difference from the named declaration. Subtract any previous disparity charges for the same event/scope when issuing an amendment. |

For the first policy, a useful control is:

```text
net prior charges = valid issued debit charges - issued credits for this scope
remaining adjustment = approved charge entitlement - net prior charges
```

Payments affect outstanding balance, not whether a charge has already been invoiced. Voided documents must not count as valid charges. Existing harbour-dues charges must not be deducted from an unrelated cargo-disparity charge. For linear per-unit tariffs, quantity difference × rate may suffice; tiered rates, minimum charges, tolerances and amendments require evaluation of the approved policy rather than assuming that formula. Compare approved charges and prior debit/credit allocations in a common charge currency under an explicit FX policy, retaining their original currency and conversion snapshots.

Historical invoices may lack cargo-line quantities or allocations. Finance must establish those from authoritative prior invoices and assessments before using a previously billed baseline. An absent allocation means unknown, not unbilled; do not infer cargo quantities from an NRT-based harbour-dues total. Keep affected assessments on hold until the opening billing position is verified.

The assessment must snapshot payer, charge component, baseline, final quantities, signed difference, tolerance and treatment, rate/tariff version, effective date, currency, any configured tax/FX, rounding, prior-document allocations and calculation breakdown. Decide whether tolerance is a trigger for charging the entire qualifying difference or a deductible portion; those are different calculations.

Possible outcomes are draft supplemental invoice, credit/adjustment review, no charge, or disputed/held. Under the initial proposal, positive billable amounts go to Finance for issuance; negative amounts require the agreed credit/no-charge policy. Within-tolerance and zero outcomes are stored explicitly. Neither final agreement nor a numerical difference alone proves a charge is due.

Issue through an explicit Finance action using server-side calculations and idempotency. Block duplicate billing of a scope even when retries use different request keys. Later reconciliation amendments produce only the remaining adjustment, with links to earlier documents. Issued invoice snapshots do not change when tariffs, exchange rates or source records later change.

## Data model and API outline

| Record | Main responsibility |
|---|---|
| `Party`, `Participant` | Tenant-owned stakeholder identity, representative, role, required return/agreement and any scoped access. |
| `CargoScope`, `CargoLine` | Call/parcel/lot/stage/direction and stable cargo classifications, units and aggregation identity. |
| `MeasurementPlan` | Schedule, location, method, team, deadlines, lifecycle and version. |
| `BaselineDocument`, `BaselineLine` | Versioned manifest/Bill of Lading/reference values and evidence, separate from a billing allocation. |
| `MeasurementSubmission`, `MeasurementLine` | One party's versioned return, typed values, provenance, raw readings and evidence. |
| `Reconciliation`, `ReconciliationLine` | Proposed/final accepted figures, exact input revisions, decisions, supersession and immutable snapshot. |
| `ReconciliationApproval` | Party acknowledgement, audit/reviewer decision, paper or authenticated source, version and timestamp. |
| `DisparityAssessment`, `AssessmentLine` | Frozen billing rule and calculations, prior-charge allocations, payer and no-charge/charge/credit outcome. |
| `Invoice`, `InvoiceLine`, adjustment links | Issued charge purpose, amount/currency, approved source and traceable debit/credit allocations. |
| `EvidenceDocument`, explicit document links | Private PDF/photo, checksum, ownership, retention and links to submissions, baselines, approvals and final versions. |

Keep workflow states separate: plan scheduling/completion; return draft/submitted/superseded; reconciliation draft/in-review/disputed/final/superseded; assessment draft/held/no-charge/ready/issued. “Final” must not silently mean “invoiced” or “paid.”

Use additive Django migrations in `operations` and `billing`; avoid another opaque JSON object for the core workflow. Preserve existing invoice records as harbour-dues records. Replace the blanket one-to-one inspection constraint with charge-source uniqueness that retains legacy exactly-once behavior and permits supplemental documents. Enforce organization consistency across every relationship.

Proposed API groups:

- `/api/vessel-calls/{id}/measurement-plans` and plan scheduling/participants.
- `/api/measurement-plans/{id}/submissions`, with submit/revise and evidence actions.
- `/api/measurement-plans/{id}/reconciliations`, with comparison, propose, acknowledge, approve, finalize, amend and document actions.
- `/api/reconciliations/{id}/disparity-assessments`, and Finance issue-invoice/no-charge decisions.
- Call-level retrieval of all final versions, source documents, charge documents and balances.

Require expected versions on consequential updates. Lock inputs and validate approvals in the finalization transaction; freeze the billing assessment when issuing; use durable uniqueness, idempotency and audit events for all irreversible business transitions. Preview calculations are informational until server validation succeeds.

## Screens and permissions

Vessel detail should expose **Plan**, **Measurements**, **Reconciliation**, **Billing**, and **Documents & History**. Add a measurement worklist and a dedicated comparison/review screen. Show who has submitted, what is missing, disputed lines, final-version identity and billing status.

Mobile capture submits a measurement return. Queued offline records stay visibly pending until the server accepts them; approval, finalization and invoice issuance require online validation. Support PDFs and photos on desktop and mobile. Add a printable reconciliation sheet with the paper form's recognizable columns, scalable line rows and signature/approval history; label app exports clearly instead of implying official issuance by NPA.

Suggested permissions:

| Capability | Proposed access |
|---|---|
| Schedule and capture received returns | Operations/Admin, within organization scope. |
| Submit as an external participant | Later scoped access limited to assigned plans and own returns; no organization-wide role grant. |
| Propose reconciliation | Designated Operations/reconciliation staff. |
| Final approval | Explicitly authorized reconciliation approver; independent review from the preparer is the proposed default. |
| Maintain tariffs and issue invoices/credits | Finance/Admin with relevant billing capability. |
| Read finalized results | Authorized organization roles; external visibility decided per plan. |

Audit actor, on-behalf-of party, before/after revision, reason and timestamps. Preserve private document access checks and prevent removal of evidence underpinning a finalized reconciliation or issued invoice. Party access must not expose another tenant's data or imply all parties can edit each other's returns.

## Delivery sequence and acceptance

| Phase | Deliverable | Acceptance evidence |
|---|---|---|
| 0. Rules and design | Confirm terminology, sample line mapping, required approvals, payer/baseline/tariff policy and screen wireframes. | Operations and Finance can walk through a bulk case, container case and correction without ambiguity. Billing remains disabled where policy is unresolved. |
| 1. Planning and collection | Add structured scope/party/plan/submission models, typed lines, PDF/photo evidence, worklist and desktop/mobile forms. | Several parties can submit different values for one cargo line; revisions retain originals; missing and zero are distinct; offline retries do not duplicate returns. |
| 2. Reconciliation | Comparison grid, agreement/dispute workflow, immutable final records and export. | Required items gate finalization; exact source revisions and signed evidence are retained; corrections create new versions. |
| 3. Disparity billing | Configured assessment, prior-charge allocations, line invoices/credits, multiple documents per call and Finance issuance. | No draft or disputed reconciliation is billed; repeated/concurrent requests cannot double bill; amendments issue only outstanding adjustments. |
| 4. Qualification and rollout | Regression, migration rehearsal, access/concurrency tests, UAT and release evidence. | Legacy harbour-dues calculations and history remain intact; new workflows pass browser/mobile and backend checks under the repository release process. |

Suggested first implementation slice: one call with a bulk-cargo line, five named stakeholder roles, staff-entered returns with PDFs, a side-by-side comparison and a locked approved reconciliation. Extend the same typed-line model to the container examples before enabling billing. Do not require an external portal, OCR automation, automatic measurement hardware integration or a full calendar for this slice.

Necessary scenario checks:

1. Bulk example after verification: 19,500 declared and 19,508 agreed gives +8 on the same basis; its invoice outcome follows the configured tariff and prior charges.
2. Container example: independent import/export 20/40/45-foot lines and laden/empty values remain intact; no accidental conversion to tonnes or double counting across parties.
3. Missing baseline/return, explicit zero, NIL, not applicable, a waived party, conflicting readings and incompatible units produce distinct outcomes.
4. Changes after a proposal invalidate approvals tied to the old inputs; final records and supporting evidence cannot be edited or deleted.
5. Two users finalize or issue concurrently; network/offline retries arrive late; stale versions produce visible conflict handling without duplicate invoices.
6. Equal quantities, positive/negative differences, a zero baseline, tolerance boundaries, rate changes, rounding, partial prior billing, credits, voids and payments produce reproducible results.
7. Multiple parcels/plans on one call and repeated survey stages do not complete or bill each other accidentally.
8. Cross-organization references, unauthorized approval, participant impersonation and unauthorized document access are rejected by the server.
9. Legacy inspections remain labeled as historical records, not falsely backfilled as stakeholder-approved reconciliations; existing issued totals stay unchanged.
10. Analytics count the latest applicable final reconciliation once per scope, separate physical units and invoice types, and compute outstanding balances from charges less credits/payments. The current unpaid-invoice aggregation needs adjustment for partial payments.

## Decisions still needed

| Decision | Proposed planning assumption |
|---|---|
| Measurement scope | Cargo measurement/tally is the first scope, with scheduling included; separate vessel certification is not inferred from GRT/LOA fields. |
| Billing comparison | Retain declared and previously billed values; Finance selects the approved policy. No charge formula can be established from the scans alone. |
| Charge policy | Confirm excess/shortfall treatment, tolerances, rate basis/effective date, minimums, currency, tax/FX if applicable, payer and credit handling before enabling issuance. |
| Required parties and final authority | Configure per plan; record every relevant party, but do not assume every printed column or distribution recipient must approve. |
| Meaning of agreement | Paper-backed verification first; confirm which parties acknowledge the proposed figures and who may finalize or waive a requirement. |
| External access | Staff records returns on behalf of parties initially; scoped self-service submission/approval can follow. |
| Existing call workflow | New plans use explicit staged actions; completed historical inspections and invoices are preserved without invented approval history. |

No application behavior was changed by this review. This document is the implementation proposal to refine and execute once the business choices are settled.
