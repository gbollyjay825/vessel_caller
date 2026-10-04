# Entering a voyage measurement sheet

The measurement screens follow the cargo rows and agency columns in the NPA
voyage reconciliation sheets. The owner's baseline declaration, independent
agency observations and the reconciled result remain distinct records.

Before starting a voyage, an administrator can open **Settings → Agency setup**
to maintain the reusable agency list. For this UI-only preview, the directory is
saved in this browser and scoped to the current organization. It is not synced
between users or browsers. Agencies can be edited, archived and reactivated;
existing voyage sheets retain the agency details copied when they were created.

The creation form has four steps:

1. **Vessel & voyage.** Select a vessel, then the specific voyage from its recorded
   vessel calls. Check the voyage reference, ETA and berth. A vessel with several
   voyages requires an explicit choice. Each owner's declaration belongs to that
   voyage. Changing voyages clears the declaration and measurement arrangements
   after confirmation when they have been edited.
2. **Record the owner's baseline declaration.** Choose the cargo type and copy
   the owner-provided quantities into the matching cargo rows.
   Containers use six import categories: 20, 40 and 45 ft, separated into
   laden/empty. Include only applicable categories. Vehicle presets
   include the paper categories Cars, Buses, Trucks and Mafi Trailer / HDV.
   Tanker rows identify the product carried, such as petroleum, chemicals or gas.
   Mixed cargo keeps separate rows and units for each category.
   Enter a shared vessel declaration reference once; a row-specific
   reference overrides it. Blank is unknown; 0 is an explicit NIL declaration.
   Container details can be expanded when the preset needs editing. Changing
   an edited cargo template requires an explicit replacement choice.
3. **Select agencies.** Choose from the saved directory and confirm the
   representative for this voyage. Admin users can open agency setup without
   losing the form. This selects the sources of later independent measurements;
   it does not enter their readings.
4. **Review & arrange.** Review the vessel, voyage, owner declaration and selected
   agencies. Set the schedule, berth, survey lead and measurement method.
   New declarations use import/discharge throughout. Additional planning details
   are available in a disclosure instead of interrupting declaration entry.

After creating the voyage sheet:

5. **Record each independent agency reading.** Select its reporting agency, enter the source
   reference and all included cargo rows, and attach evidence. Use 0 for NIL.
   An N/A reading needs a reason. Unsaved drafts and selected evidence remain
   separate for each agency while the form is open; they are not stored after
   closing the form. Mobile entry uses labelled cargo cards.
6. **Review NPA reconciliation.** After the required agency readings are received,
   the sheet shows the owner's baseline declaration, each
   agency reading, the proposed/final tally and the difference in that row's
   unit. Agency readings are not averaged or overwritten. Saved versions use
   their original declaration and return snapshots. NPA can follow its review
   process using the existing proposal, acknowledgement and independent Admin
   finalization actions.
7. **Continue to disparity billing.** Existing assessment and invoicing rules
   apply to the stored final reconciliation. Count, tonnes and m3 are never
   combined into one cargo total.

## Voyage log

The measurements worklist opens on a vessel-grouped voyage log. Each recorded
voyage shows its own cargo sheets, owner declaration, progress of agency readings,
final NPA tally and difference for each cargo item. Plans join strictly by vessel
call ID. Unmatched historical plans remain visible separately. Saved final
versions retain their original declaration snapshots, including unknown values,
and mixed units are never added together. Historical export records remain
visible and retain their existing entry and reconciliation behavior.

## Current access boundary

This change updates the frontend only. Admin and Operations users with the
existing measurement permission can record a return for any listed party in
their organization. The reporting agency identifies the source; the server
records the actual signed-in user separately. Participant roles do not grant
application permissions.

Agency-linked accounts, a shared agency directory, collaboration between separate
organization tenants, and NPA-only reconciliation permissions require a later
backend change. Vessel grouping uses the name and flag on existing call records;
a persistent vessel registry with stable vessel IDs also requires backend work.
This UI does not enforce or claim those capabilities.

## Release impact

There are no API, schema, migration, permission or billing-rule changes.
Validation covers form payloads, draft isolation, exact decimal comparisons,
saved snapshots, browser/mobile layout and the existing frontend tests.
Rollback a regression through the normal signed release process; no data or
schema rollback is introduced by this change.
