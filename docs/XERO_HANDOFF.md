# Xero Handoff

Last updated: 2026-04-15

Use this file as the source of truth for the remaining Xero work.

## Goal

Finish the remaining Xero work so TACBookings:

- stays below the 1000-calls-per-day Xero limit
- uses webhook-driven and incremental reconciliation instead of full scans
- keeps admin and member read paths local-first wherever practical
- preserves durable, replayable outbound and inbound Xero operations

## Current Baseline

Treat these as already landed unless the next task forces a design change:

- metered Xero wrapper, usage dashboard, and shared auth/contact-repair helpers
- durable outbound operation ledger plus `XeroObjectLink` storage
- durable primary-write outbox for booking invoices, entrance-fee invoices, standard refund credit notes, account-credit notes, supplementary invoices, and modification credit notes
- stored inbound-event persistence, replay, and batched reconciliation for `CONTACT`, `INVOICE`, `PAYMENT`, and `CREDIT_NOTE`
- incremental membership invoice cursor with linked invoice/payment refresh
- incremental contact sync plus local `XeroContactCache`
- local cache tables for Xero contact groups and memberships
- local-only member subscription reads
- account-credit note, account-credit allocation, and refund-state repairs in inbound `CREDIT_NOTE` reconciliation

## Landed In This Pass

Phase 7 link recovery is narrower now.

Implemented:

- inbound `INVOICE` reconciliation now recovers missing booking-scoped `SUPPLEMENTARY_INVOICE` links from `XeroSyncOperation` when the original extra-link write was lost
- inbound `CREDIT_NOTE` reconciliation now recovers missing booking-scoped `MODIFICATION_CREDIT_NOTE` links from `XeroSyncOperation`
- once the modification credit-note link is recovered, the existing inbound path rebuilds `MODIFICATION_CREDIT_NOTE_ALLOCATION` links and re-runs refunded-payment repair without needing any new pull job
- added focused regression coverage for both recovered-link paths

Primary files updated:

- `src/lib/xero-inbound-reconciliation.ts`
- `src/lib/__tests__/xero-inbound-reconciliation.test.ts`

## Remaining Work

### 1. Phase 7 remaining

Do not reopen the membership/contact/account-credit work above. The remaining Phase 7 scope is only the last booking-scoped gaps.

Open questions:

1. Decide whether `SUPPLEMENTARY_INVOICE_PAYMENT` needs an explicit ledger-based backfill, or whether recovering `SUPPLEMENTARY_INVOICE` plus the existing inbound `PAYMENT` handler is sufficient.
2. Decide whether any webhook-free pull is still needed for booking-scoped supplementary invoices or modification credit notes after observing the recovered-link path. This pass did not add a new incremental pull step.

Relevant files:

- `src/lib/xero.ts`
- `src/lib/xero-inbound-reconciliation.ts`
- `src/lib/xero-operation-outbox.ts`
- `src/lib/xero-operation-retry.ts`

### 2. Phase 6 remaining

Finish the outbox-boundary decisions for operator-triggered repair paths.

Required outcome:

- future contact-dependent writes stay on the shared stale-contact repair helper
- refund/account-credit repair entrypoints have one consistent execution model
- any new automatic outbound flow preserves crash-recovery guarantees

### 3. Hardening and cleanup

Still open:

- richer drift reporting beyond canonical-link gaps
- explicit repair handling for any future `PARTIAL` state
- final audit of direct Xero SDK calls that still bypass the shared metered wrapper

## Verification Expectations

Run the most relevant targeted suites plus a full build before updating this file.

Executed in this pass:

- `npx vitest run src/lib/__tests__/xero-inbound-reconciliation.test.ts`

Still required whenever code changes:

- targeted `npx eslint ...`
- targeted `npx vitest run ...`
- `npm run build`

## Next Agent Checklist

1. Read this file first.
2. Keep the scope on the remaining booking-scoped Phase 7 gap; do not reopen the landed membership/contact/account-credit reconciliation work.
3. Compare any further change in `src/lib/xero.ts` against inbound recovery first, and prefer durable local state before adding more polling.
