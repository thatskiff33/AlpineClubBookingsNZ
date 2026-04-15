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

Phase 7 booking-scoped recovery is now closed.

Implemented:

- inbound `INVOICE` reconciliation now recovers missing booking-scoped `SUPPLEMENTARY_INVOICE` links from `XeroSyncOperation` when the original extra-link write was lost
- inbound `INVOICE` reconciliation now also rebuilds booking-scoped `SUPPLEMENTARY_INVOICE_PAYMENT` links from `invoice.payments` once the supplementary invoice link is recovered, so recovery no longer depends on a later `PAYMENT` webhook arriving after the invoice link exists
- inbound `CREDIT_NOTE` reconciliation now recovers missing booking-scoped `MODIFICATION_CREDIT_NOTE` links from `XeroSyncOperation`
- once the modification credit-note link is recovered, the existing inbound path rebuilds `MODIFICATION_CREDIT_NOTE_ALLOCATION` links and re-runs refunded-payment repair without needing any new pull job
- confirmed the existing `PARTIAL` retry path remains the fallback when the supplementary Xero payment write itself failed
- added focused regression coverage for the recovered supplementary payment-link path, the recovered modification credit-note path, and the partial supplementary payment retry path

Primary files updated:

- `src/lib/xero-inbound-reconciliation.ts`
- `src/lib/__tests__/xero-inbound-reconciliation.test.ts`
- `src/lib/__tests__/xero-operation-retry.test.ts`

## Remaining Work

### 1. Phase 7 status

No booking-scoped Phase 7 items remain open.

Decisions now landed:

1. `SUPPLEMENTARY_INVOICE_PAYMENT` does not need a separate ledger-only backfill step. Recovering `SUPPLEMENTARY_INVOICE` during inbound invoice reconciliation now also reconstructs the payment link from `invoice.payments`, and the existing outbound `PARTIAL` retry path is still the repair path when the Xero payment write itself failed.
2. No new webhook-free incremental pull was added for booking-scoped supplementary invoices or modification credit notes. Current stance is to rely on stored inbound webhook replay plus the recovered-link reconciliation paths above instead of adding another scheduled pull loop.

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
- `npx vitest run src/lib/__tests__/xero-operation-retry.test.ts`
- `npx eslint src/lib/xero-inbound-reconciliation.ts src/lib/__tests__/xero-inbound-reconciliation.test.ts src/lib/__tests__/xero-operation-retry.test.ts`
- `npm run build`

Re-run as appropriate if further code changes land after this handoff:

- targeted `npx eslint ...`
- targeted `npx vitest run ...`
- `npm run build`

## Next Agent Checklist

1. Read this file first.
2. Treat booking-scoped Phase 7 work as closed unless new production evidence proves another gap.
3. Keep the remaining scope on Phase 6 operator-triggered repair boundaries and on hardening/cleanup items only.
4. Compare any further change in `src/lib/xero.ts` against inbound recovery first, and prefer durable local state before adding more polling.
