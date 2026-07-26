#!/usr/bin/env bash
set -euo pipefail

: "${PGHOST:?PGHOST is required}"
: "${PGDATABASE:?PGDATABASE is required}"
: "${PGUSER:?PGUSER is required}"
: "${PGPASSFILE:?PGPASSFILE is required}"

psql \
  --no-psqlrc \
  --tuples-only \
  --no-align \
  --set ON_ERROR_STOP=1 <<'SQL'
SELECT jsonb_pretty(
  jsonb_build_object(
    'schemaVersion', 1,
    'counts', jsonb_build_object(
      'organizations', (SELECT count(*) FROM organizations_organization),
      'users', (SELECT count(*) FROM accounts_user),
      'vesselCalls', (SELECT count(*) FROM operations_vesselcall),
      'inspections', (SELECT count(*) FROM operations_inspection),
      'invoices', (SELECT count(*) FROM billing_invoice),
      'payments', (SELECT count(*) FROM billing_payment)
    ),
    'financialTotals', jsonb_build_object(
      'dues', (SELECT coalesce(sum(dues), 0)::text FROM billing_invoice),
      'commissionUsd', (
        SELECT coalesce(sum(commission_usd), 0)::text FROM billing_invoice
      ),
      'commissionNgn', (
        SELECT coalesce(sum(commission_ngn), 0)::text FROM billing_invoice
      ),
      'activePayments', (
        SELECT coalesce(sum(amount) FILTER (WHERE reversed_at IS NULL), 0)::text
        FROM billing_payment
      )
    ),
    'foreignKeyOrphans', jsonb_build_object(
      'usersOrganization', (
        SELECT count(*)
        FROM accounts_user child
        LEFT JOIN organizations_organization parent ON parent.id = child.organization_id
        WHERE child.organization_id IS NOT NULL AND parent.id IS NULL
      ),
      'callsOrganization', (
        SELECT count(*)
        FROM operations_vesselcall child
        LEFT JOIN organizations_organization parent ON parent.id = child.organization_id
        WHERE parent.id IS NULL
      ),
      'inspectionsCall', (
        SELECT count(*)
        FROM operations_inspection child
        LEFT JOIN operations_vesselcall parent ON parent.id = child.vessel_call_id
        WHERE parent.id IS NULL
      ),
      'invoicesInspection', (
        SELECT count(*)
        FROM billing_invoice child
        LEFT JOIN operations_inspection parent ON parent.id = child.inspection_id
        WHERE parent.id IS NULL
      ),
      'paymentsInvoice', (
        SELECT count(*)
        FROM billing_payment child
        LEFT JOIN billing_invoice parent ON parent.id = child.invoice_id
        WHERE parent.id IS NULL
      )
    ),
    'migrations', (
      SELECT coalesce(
        jsonb_agg(app || ':' || name ORDER BY app, name),
        '[]'::jsonb
      )
      FROM django_migrations
    )
  )
);
SQL
