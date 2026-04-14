# Xero Handoff

Last updated: 2026-04-14

This document replaces the previous Xero audit and reconciliation review docs. It is intended to be the single handoff for the next agent.

## Goal

Finish the remaining Xero work so TACBookings:

- stays comfortably below the 1000-calls-per-day Xero limit
- uses incremental sync and webhook-driven reconciliation instead of full scans
- keeps admin and member read paths local-only wherever practical
- preserves durable, replayable, auditable outbound and inbound Xero operations

## Current Baseline

Treat the following as already implemented unless there is a specific reason to change them:

- shared metered Xero wrapper and admin usage dashboard
- durable outbound operation ledger and object-link storage
- durable primary-write outbox for:
  - entrance-fee invoices
  - booking invoices
  - standard refund credit notes
  - unapplied account-credit notes
  - booking-modification supplementary invoices
  - booking-modification credit notes
- retry, requeue, and record-scoped Xero activity surfaces for supported outbound failures
- stored inbound-event persistence, replay, and linked-record reconciliation for:
  - `CONTACT`
  - `INVOICE`
  - `PAYMENT`
  - `CREDIT_NOTE`
- steady-state contact-link trust plus inline stale-contact repair for contact-dependent writes
- durable shared cache for admin chart-of-accounts and items reference data
- durable incremental membership invoice sync cursor with `If-Modified-Since` and retry carry-forward
- local-only member subscription status reads
- durable local cache tables for Xero contact groups and group memberships, plus operator-triggered refresh

## Recommended Execution Order

Build in this order:

1. Phase 4: incremental contact sync and group import
2. Phase 7 remaining reconciliation work
3. Phase 6 remaining outbox / repair decisions
4. Hardening, drift detection, and any new `PARTIAL` support
5. Phase 8 cleanup audit

## Completed In This Pass

### Phase 2: Replace full membership polling with incremental invoice sync

Implemented:

- added durable `XeroSyncCursor` state for the membership invoice sync window
- replaced full linked-member scans in `refreshAllMembershipStatuses()` with an incremental `getInvoices(..., If-Modified-Since=...)` pass scoped to the subscription season window
- mapped changed invoices back to local members through `Member.xeroContactId`
- carried failed/unfinished member refreshes forward on the cursor metadata instead of falling back to future full scans
- kept `checkMembershipStatus(...)` as the targeted repair/reconciliation path, but stopped unconditional `getOnlineInvoice(...)` fetches
- only refreshed online invoice URLs when first discovering a subscription invoice, when the matched subscription invoice changed, or when an explicit repair asks for it
- removed the member-facing `/api/member/subscription-status` fallback that read through to Xero on page load

Primary files updated:

- `src/lib/xero.ts`
- `src/app/api/member/subscription-status/route.ts`
- `prisma/schema.prisma`

### Phase 3: Move contact groups and group memberships to local cache tables

Implemented:

- added durable cache tables for Xero contact groups and group memberships
- made `/api/admin/xero/contact-groups` serve cache by default, with `?refresh=1` as the explicit operator-triggered refresh-from-Xero action
- moved `/api/admin/members` group filtering and list enrichment to local cache reads
- moved `/api/admin/members/[id]` group detail enrichment to local cache reads
- kept the existing feature-flag gate for member-page display, but the enabled path is now local-only instead of live Xero

Primary files updated:

- `src/lib/xero.ts`
- `src/app/api/admin/xero/contact-groups/route.ts`
- `src/app/api/admin/members/route.ts`
- `src/app/api/admin/members/[id]/route.ts`
- `src/app/(admin)/admin/xero/page.tsx`
- `src/app/(admin)/admin/members/page.tsx`
- `src/app/(admin)/admin/members/[id]/page.tsx`
- `prisma/schema.prisma`

## Remaining Work

### 1. Phase 4: Make contact sync and group import incremental

The current bulk contact/group workflows are still more expensive than they should be.

Required outcome:

- a second contact sync with no upstream changes is cheap
- default contact sync no longer performs one invoice lookup per contact
- group import can run from cached group/contact data instead of refetching everything live

Implementation direction:

- add a contact sync cursor and use `If-Modified-Since` in `syncContactsFromXero()`
- persist the Xero contact update marker locally
- separate “joined date from first invoice” into a repair/backfill path instead of the main sync
- rework group import to consume cached group membership and cached contact snapshots where available
- keep any full rescan as an explicit repair tool only

Primary files:

- `src/lib/xero.ts`
- `src/app/api/admin/xero/sync-contacts/route.ts`
- `src/app/api/admin/xero/import-members/route.ts`
- `src/app/(admin)/admin/xero/page.tsx`
- `prisma/schema.prisma`

### 2. Phase 7 remaining: make webhook and incremental reconcile the main source of truth

Inbound reconciliation is partly implemented, but it is not yet the main driver of all affected local business state.

Required outcome:

- webhook-triggered reconciliation advances the remaining business state that still depends on polling
- cached contact-group membership refreshes from inbound changes where applicable
- daily polling becomes a safety net, not the primary reconciliation path

Implementation direction:

- extend business-state application beyond current safe metadata/link backfills
- add incremental pull jobs where webhooks alone are insufficient
- consider whether bulk replay/filtering improvements are needed on the admin Xero screen after the main reconciliation paths land

Primary files:

- `src/lib/xero-inbound-reconciliation.ts`
- `src/app/api/webhooks/xero/route.ts`
- `src/app/api/cron/xero/route.ts`
- `src/instrumentation.ts`

### 3. Phase 6 remaining: finish the outbox boundary decisions

Most Phase 6 write-path reduction is done. The open work is narrower now.

Required outcome:

- any future contact-dependent write path stays on the shared stale-contact repair helper
- operator-triggered refund/account-credit repair routes have a clear, consistent execution model

Implementation direction:

- decide whether future operator-triggered refund/account-credit repair routes should also enqueue onto the durable outbox or stay intentionally synchronous
- preserve existing crash-recovery guarantees for any new automatic outbound write path

Primary files:

- `src/lib/xero.ts`
- `src/lib/xero-operation-outbox.ts`
- `src/lib/xero-operation-retry.ts`

### 4. Hardening and supportability

Core reconciliation hardening exists, but richer drift detection is still open.

Required outcome:

- nightly reporting covers more than canonical-link gaps
- support workflows can identify meaningful local-vs-Xero business-state drift
- any future partial outbound flow is explicitly repairable

Implementation direction:

- extend reconciliation reporting into richer business-state drift detection
- optionally add Xero history notes or attachments only if they materially improve operator support
- for any new `PARTIAL` state:
  - add a deterministic repair handler in `src/lib/xero-operation-retry.ts`
  - add any required helper path in `src/lib/xero.ts`
  - add explicit replay-safety tests

### 5. Phase 8 cleanup

The chart/item cache work is done. Only the audit/cleanup portion remains.

Required outcome:

- no remaining direct Xero SDK call should bypass the shared metered wrapper without a deliberate reason

Implementation direction:

- audit remaining direct SDK calls outside the shared wrapper
- decide whether any other low-priority reference-data reads deserve the same durable cache treatment

## Verification Expectations

At minimum, each pass should run the most relevant targeted suites plus a full build before updating this file.

Typical commands:

- `npx prisma generate`
- targeted `npx eslint ...`
- targeted `npx vitest run ...`
- `npm run build`

## Notes For The Next Agent

- Do not reopen already-completed Phase 6/7/8 work unless the remaining phases force a design change.
- The next biggest budget win is now Phase 4 contact sync and group import incrementalisation.
- Phase 3 should follow immediately after Phase 2 because the current member-group fallback is intentionally temporary.
