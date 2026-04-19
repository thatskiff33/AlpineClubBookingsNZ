# Xero Handoff

Last updated: 2026-04-19

Use this file as the source of truth for any future Xero follow-up.

## Status

No open Xero implementation items remain on `main` at the moment.

Keep this handoff closed unless production evidence exposes a new reconciliation gap, a new unsupported `PARTIAL` repair flow, or a new write path that bypasses the shared queue/metering boundaries.

## What Landed

The Xero work that was still open in the earlier Phase 7 / Phase 6 handoff is now closed:

- booking-scoped inbound reconciliation now recovers missing `SUPPLEMENTARY_INVOICE`, `SUPPLEMENTARY_INVOICE_PAYMENT`, and `MODIFICATION_CREDIT_NOTE` links from durable local state plus the outbound operation ledger where needed
- existing inbound replay continues from those recovered roots to rebuild modification allocations and refunded-payment state without adding a new scheduled pull loop
- operator-triggered Xero retries now use the same queued/background execution boundary as other durable Xero repair flows instead of issuing live writes inline from admin requests
- hardening/reporting now distinguishes richer canonical-link drift states and explicitly reports unsupported `PARTIAL` repair gaps
- wrapper-audit coverage now guards against introducing new direct `xero.accountingApi.*` usage outside `callXeroApi`

Recent closing commits:

- `a27d4a6` `Close Xero booking payment recovery gap`
- `2d67710` `Queue Xero operator retries through background worker`
- `0dc54f6` `Close remaining Xero hardening gaps`

## What Is Left

Nothing is currently queued as remaining Xero work.

Re-open this handoff only if one of these happens:

1. Production evidence shows a missed webhook / replay path that current inbound reconciliation does not repair.
2. A new outbound flow introduces a `PARTIAL` state without a retry handler in `src/lib/xero-operation-retry.ts`.
3. New Xero code bypasses `callXeroApi`, the queue boundary, or durable local link state.

## Current Baseline

Treat these as already landed:

- metered Xero wrapper and usage dashboard
- durable outbound `XeroSyncOperation` ledger plus `XeroObjectLink` storage
- durable outbox coverage for booking invoices, entrance-fee invoices, refund credit notes, account-credit notes, supplementary invoices, and modification credit notes
- stored inbound-event persistence, replay, and batched reconciliation for `CONTACT`, `INVOICE`, `PAYMENT`, and `CREDIT_NOTE`
- incremental membership invoice reconciliation with linked invoice/payment refresh
- incremental contact sync plus local `XeroContactCache`
- local cache tables for Xero contact groups and memberships
- local-only member subscription reads
- account-credit note, account-credit allocation, and refund-state repairs in inbound `CREDIT_NOTE` reconciliation

## Verification Reference

The final closing pass previously ran:

- `npx vitest run src/lib/__tests__/xero-hardening.test.ts`
- `npx vitest run src/lib/__tests__/phase6b-notifications.test.ts`
- `npx vitest run src/lib/__tests__/xero-wrapper-audit.test.ts src/lib/__tests__/phase-c1.test.ts src/lib/__tests__/phase-c2.test.ts src/lib/__tests__/stripe.test.ts`
- `npx eslint src/lib/xero-hardening.ts src/lib/email.ts src/lib/email-templates.ts src/lib/__tests__/xero-hardening.test.ts src/lib/__tests__/phase6b-notifications.test.ts src/lib/__tests__/xero-wrapper-audit.test.ts src/lib/__tests__/phase-c1.test.ts src/lib/__tests__/phase-c2.test.ts src/lib/__tests__/stripe.test.ts`
- `npm run build`

## Next Agent Checklist

1. Read this file first.
2. Assume Xero work is closed unless current evidence proves otherwise.
3. If a new Xero gap appears, compare `src/lib/xero.ts` against inbound recovery first and prefer durable local state before adding more polling.
4. Keep new `accountingApi` usage behind `callXeroApi`.
