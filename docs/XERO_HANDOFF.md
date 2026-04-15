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

Phase 6 operator-triggered repair boundaries are now closed.

Implemented:

- operator-triggered outbound Xero retries no longer execute live writes inline from the admin request path
- `/api/admin/xero/operations/[id]/retry` now queues the retry into `xero-operation-queue`, returns `202`, and kicks the queue worker after the response, matching the durable execution model that `/requeue` already used
- the dedicated `/requeue` route remains as a compatibility alias over the same queued retry flow
- the admin Xero operations UI and record activity panel now expose a single `Retry in background` action instead of separate `Retry` and `Requeue` buttons, so operators no longer have to choose between inconsistent execution models
- added route-level regression coverage for both admin retry endpoints so the queued behavior stays locked down

Primary files updated:

- `src/app/api/admin/xero/operations/[id]/retry/route.ts`
- `src/app/(admin)/admin/xero/page.tsx`
- `src/components/admin/xero-record-activity-panel.tsx`
- `src/lib/__tests__/xero-operation-routes.test.ts`

## Remaining Work

### 1. Phase 7 status

No booking-scoped Phase 7 items remain open.

Decisions now landed:

1. `SUPPLEMENTARY_INVOICE_PAYMENT` does not need a separate ledger-only backfill step. Recovering `SUPPLEMENTARY_INVOICE` during inbound invoice reconciliation now also reconstructs the payment link from `invoice.payments`, and the existing outbound `PARTIAL` retry path is still the repair path when the Xero payment write itself failed.
2. No new webhook-free incremental pull was added for booking-scoped supplementary invoices or modification credit notes. Current stance is to rely on stored inbound webhook replay plus the recovered-link reconciliation paths above instead of adding another scheduled pull loop.

### 2. Phase 6 status

Closed in this pass.

Decisions now landed:

1. Operator-triggered outbound retries now use the same queued execution boundary as other durable Xero repair flows instead of issuing live writes inline from the admin request path.
2. Refund/account-credit repair entrypoints therefore follow the same background retry model as the rest of the Xero operation queue.
3. This keeps crash recovery tied to stored `XeroSyncOperation` rows instead of whichever button an operator happened to click.

### 3. Hardening and cleanup

Still open:

- richer drift reporting beyond canonical-link gaps
- explicit repair handling for any future `PARTIAL` state
- final audit of direct Xero SDK calls that still bypass the shared metered wrapper

## Verification Expectations

Run the most relevant targeted suites plus a full build before updating this file.

Executed in this pass:

- `npx vitest run src/lib/__tests__/xero-operation-routes.test.ts`
- `npx vitest run src/lib/__tests__/xero-operation-queue.test.ts`
- `npx eslint 'src/app/api/admin/xero/operations/[id]/retry/route.ts' 'src/app/(admin)/admin/xero/page.tsx' src/components/admin/xero-record-activity-panel.tsx src/lib/__tests__/xero-operation-routes.test.ts`
- `npm run build`

Re-run as appropriate if further code changes land after this handoff:

- targeted `npx eslint ...`
- targeted `npx vitest run ...`
- `npm run build`

## Next Agent Checklist

1. Read this file first.
2. Treat booking-scoped Phase 7 work as closed unless new production evidence proves another gap.
3. Treat Phase 6 operator-triggered retry boundary work as closed unless a new repair path is added that bypasses the queue boundary.
4. Keep the remaining scope on hardening/cleanup items only.
5. Compare any further change in `src/lib/xero.ts` against inbound recovery first, and prefer durable local state before adding more polling.
