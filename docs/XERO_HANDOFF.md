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

The remaining Xero hardening/cleanup scope is now closed.

Implemented:

- the nightly Xero reconciliation report now distinguishes missing canonical links from richer drift states:
  mismatched canonical links, stale canonical links, and duplicate active canonical links
- the reconciliation report now flags unsupported `PARTIAL` operations separately and includes the local record plus repair-gap reason, so any future partial flow shows up explicitly instead of disappearing into the generic partial count
- added a source-audit regression test that fails if a new `xero.accountingApi.*` call is introduced outside `callXeroApi`, closing the remaining shared-wrapper audit item
- refreshed the reconciliation email template and hardening tests to cover the new drift/repair-gap categories

Primary files updated:

- `src/lib/xero-hardening.ts`
- `src/lib/email.ts`
- `src/lib/email-templates.ts`
- `src/lib/__tests__/xero-hardening.test.ts`
- `src/lib/__tests__/phase6b-notifications.test.ts`
- `src/lib/__tests__/xero-wrapper-audit.test.ts`

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

Closed in this pass.

Decisions now landed:

1. Reconciliation reporting now treats canonical-link drift as more than simple absence. Missing links, mismatched links, stale links, and duplicate active links are all surfaced separately.
2. Future unsupported `PARTIAL` operation shapes are now reported explicitly with the repair-gap reason and local record context until a dedicated retry handler is added.
3. Direct `accountingApi` usage is now guarded by test so new code has to stay behind `callXeroApi`.

No open Xero handoff items remain at the moment. Re-open this only if production evidence exposes a new reconciliation gap or a new outbound repair path.

## Verification Expectations

Run the most relevant targeted suites plus a full build before updating this file.

Executed in this pass:

- `npx vitest run src/lib/__tests__/xero-hardening.test.ts`
- `npx vitest run src/lib/__tests__/phase6b-notifications.test.ts`
- `npx vitest run src/lib/__tests__/xero-wrapper-audit.test.ts src/lib/__tests__/phase-c1.test.ts src/lib/__tests__/phase-c2.test.ts src/lib/__tests__/stripe.test.ts`
- `npx eslint src/lib/xero-hardening.ts src/lib/email.ts src/lib/email-templates.ts src/lib/__tests__/xero-hardening.test.ts src/lib/__tests__/phase6b-notifications.test.ts src/lib/__tests__/xero-wrapper-audit.test.ts src/lib/__tests__/phase-c1.test.ts src/lib/__tests__/phase-c2.test.ts src/lib/__tests__/stripe.test.ts`
- `npm run build`

Re-run as appropriate if further code changes land after this handoff:

- targeted `npx eslint ...`
- targeted `npx vitest run ...`
- `npm run build`

## Next Agent Checklist

1. Read this file first.
2. Treat booking-scoped Phase 7 work as closed unless new production evidence proves another gap.
3. Treat Phase 6 operator-triggered retry boundary work as closed unless a new repair path is added that bypasses the queue boundary.
4. Treat the hardening/cleanup scope as closed unless production evidence reopens it.
5. If a new `PARTIAL` flow is introduced, either add a repair handler in `src/lib/xero-operation-retry.ts` or expect the reconciliation report to surface it as an unsupported repair gap.
6. Keep any new `accountingApi` usage behind `callXeroApi`; `src/lib/__tests__/xero-wrapper-audit.test.ts` should stay green.
7. Compare any further change in `src/lib/xero.ts` against inbound recovery first, and prefer durable local state before adding more polling.
