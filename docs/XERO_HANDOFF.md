# Xero Handoff

Last updated: 2026-04-15

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

### Phase 4: Make contact sync and group import incremental

Implemented:

- added a durable `CONTACT_SYNC` cursor and switched `syncContactsFromXero()` to incremental `getContacts(..., If-Modified-Since=...)` reads with retry carry-forward for failed contact records
- added durable `XeroContactCache` snapshots so changed contacts persist their current Xero email/name/status/phone/address fields plus `updatedDateUTC` locally
- stopped doing first-invoice lookups in the default contact sync path
- kept joined-date backfill available only as an explicit repair/backfill mode on the sync route (`POST /api/admin/xero/sync-contacts` with JSON flags such as `{"backfillJoinedDates":true}` and optionally `{"fullResync":true}`)
- reworked `importMembersFromXeroGroups()` to consume cached group membership and cached contact snapshots by default instead of refetching every group and contact live from Xero
- added explicit repair mode for cached import gaps (`repairMissingContactCache`) that fetches only missing contact snapshots, while keeping full group rescans on the existing explicit `contact-groups?refresh=1` path

Primary files updated:

- `src/lib/xero.ts`
- `src/app/api/admin/xero/sync-contacts/route.ts`
- `src/app/api/admin/xero/import-members/route.ts`
- `prisma/schema.prisma`

### Phase 7: Partial follow-on in this pass

Implemented:

- `CONTACT` inbound reconciliation now refreshes `XeroContactCache` as part of webhook/replay handling, so the new durable contact snapshot cache is no longer maintained only by operator-triggered contact sync

Primary files updated:

- `src/lib/xero-inbound-reconciliation.ts`

### Phase 7: Inbound reconciliation now drives membership-state catch-up

Implemented:

- added a shared inbound reconciliation cycle that drains stored Xero inbound events in batches instead of treating webhook follow-up as a single small batch
- made that reconciliation cycle run the existing durable incremental membership invoice cursor immediately after stored inbound events, so webhook/incremental reconcile is now the main driver for `MemberSubscription` state catch-up
- switched the webhook after-response worker to trigger the full inbound reconciliation cycle instead of only replaying one stored-events batch
- switched the 15-minute inbound cron/instrumentation path to run the same stored-event + incremental-membership cycle
- left the daily/manual membership refresh entrypoints in place as safety-net wrappers around the same incremental invoice cursor, instead of as the primary driver

Primary files updated:

- `src/lib/xero-inbound-reconciliation.ts`
- `src/app/api/webhooks/xero/route.ts`
- `src/app/api/cron/xero/route.ts`
- `src/instrumentation.ts`

### Phase 7: Contact-driven cache refresh now extends into cached group memberships

Implemented:

- added a shared contact-cache refresh helper that updates `XeroContactCache` and selectively refreshes cached Xero contact-group memberships from a changed contact snapshot when Xero includes `contactGroups`
- switched `CONTACT` inbound reconciliation to use that shared helper, so webhook/replay processing now refreshes touched contact-group membership cache rows and group counts without requiring an operator-triggered full group rescan
- switched incremental `syncContactsFromXero()` to use the same helper, so any contact-sync pass can keep touched group membership cache state warm alongside `XeroContactCache`
- kept `GET /api/admin/xero/contact-groups?refresh=1` as the deliberate full-rescan safety net for untouched groups, missed webhook drift, or cache seeding

Primary files updated:

- `src/lib/xero.ts`
- `src/lib/xero-inbound-reconciliation.ts`

### Phase 7: Inbound reconciliation now includes incremental contact-sync safety net

Implemented:

- extended the shared inbound reconciliation cycle to run the existing incremental `CONTACT_SYNC` cursor as a throttled safety-net step after stored inbound events and before membership reconciliation
- kept that contact-sync pass summarized/throttled so webhook bursts do not repeatedly re-run it, while the 15-minute inbound cron can still catch missed or non-webhook contact/group drift
- kept operator-triggered `sync-contacts` and full contact-group refresh as repair/safety-net tools, but they are no longer the only way to advance missed contact-cache or touched group-membership state

Primary files updated:

- `src/lib/xero-inbound-reconciliation.ts`

### Phase 7: Membership invoice cursor now refreshes linked invoice/payment state

Implemented:

- extended the shared inbound reconciliation cycle so changed invoices discovered by the existing incremental membership cursor also run invoice-linked reconciliation, instead of stopping at `MemberSubscription` catch-up
- reused the existing membership invoice cursor output to refresh linked invoice/payment metadata and object-link state for those changed invoices, without introducing a separate invoice polling job
- skipped the redundant subscription refresh inside that invoice-linked pass because the membership cursor has already advanced `MemberSubscription` state for the same invoice set

Primary files updated:

- `src/lib/xero.ts`
- `src/lib/xero-inbound-reconciliation.ts`

### Phase 7: Credit-note reconciliation now repairs local account-credit ledger links

Implemented:

- extended inbound `CREDIT_NOTE` reconciliation so `ACCOUNT_CREDIT_NOTE` payment links now backfill missing `MemberCredit.xeroCreditNoteId` values for matching cancellation-credit rows
- exposed account-credit repair counts in the stored reconciliation result payload, so admin/support can see when webhook replay repaired local credit-note linkage instead of only refreshing object links
- kept refund credit-note handling unchanged; this pass only closes the remaining local account-credit linkage gap

Primary files updated:

- `src/lib/xero-inbound-reconciliation.ts`
- `src/lib/__tests__/xero-inbound-reconciliation.test.ts`

### Phase 7: Credit-note allocations now repair local account-credit application state

Implemented:

- extended inbound `CREDIT_NOTE` reconciliation so account-credit note allocations now repair local `MemberCredit` `BOOKING_APPLIED` rows for the allocated booking invoice, creating missing applied-credit rows or backfilling the Xero credit-note link when the local ledger lags behind Xero
- recomputed `Payment.creditAppliedCents` from the repaired applied-credit ledger during the same inbound pass, so local cancellation restore logic and account-credit balance reads catch up directly from webhook/replay processing
- exposed applied-credit repair counts in the stored reconciliation result payload, so admin/support can distinguish allocation-driven business-state repairs from ordinary allocation-link refreshes

Primary files updated:

- `src/lib/xero-inbound-reconciliation.ts`
- `src/lib/__tests__/xero-inbound-reconciliation.test.ts`

### Phase 7: Credit-note reconciliation now repairs local refund settlement state

Implemented:

- extended inbound `CREDIT_NOTE` reconciliation so linked refund credit notes, account-credit notes, and modification credit-note allocations now recompute local `Payment.refundedAmountCents` from current Xero credit-note state instead of leaving booking/payment reads dependent on earlier local write timing
- updated local `Payment.status` to `PARTIALLY_REFUNDED` / `REFUNDED` during the same inbound pass, and reset previously-refunded payments back to `SUCCEEDED` when the current Xero credit-note state no longer indicates a refund
- kept the repair idempotent by replacing the current credit note's contribution in the derived local refund total instead of blindly incrementing local refund fields on every replay/webhook delivery
- excluded voided/deleted modification credit-note allocations from that derived refund total, so replay of reversal events now clears stale local refunded state instead of preserving it

Primary files updated:

- `src/lib/xero-inbound-reconciliation.ts`
- `src/lib/__tests__/xero-inbound-reconciliation.test.ts`

### Phase 7: Account-credit credit-note reconciliation now recovers missing payment links from local ledger state

Implemented:

- extended inbound `CREDIT_NOTE` reconciliation so `ACCOUNT_CREDIT_NOTE` payment links can be recovered from local `MemberCredit.xeroCreditNoteId` plus `sourceBookingId`, even when the original outbound extra-link write was lost
- kept the recovered link on the same payment-scoped role used by later account-credit allocation and refund-state repairs, so replay/webhook processing can still advance local business state without depending on the original write path finishing all local link persistence

Primary files updated:

- `src/lib/xero-inbound-reconciliation.ts`
- `src/lib/__tests__/xero-inbound-reconciliation.test.ts`

## Remaining Work

### 1. Phase 7 remaining: finish the last non-membership reconciliation gaps

Inbound reconciliation is now the primary driver for:

- membership subscription catch-up
- contact cache and touched group-membership drift
- membership-invoice-linked payment metadata
- credit-note-driven refund settlement and account-credit ledger repairs
- recovery of missing `ACCOUNT_CREDIT_NOTE` payment links from local `MemberCredit` state

The next remaining gap is narrower: booking and booking-modification outbound paths still rely on outbound extra-link persistence more than inbound replay should.

Next steps:

1. Compare `createXeroSupplementaryInvoice()` and `createXeroCreditNoteForModification()` in `src/lib/xero.ts` against inbound `INVOICE` / `CREDIT_NOTE` reconciliation and identify which `Booking` / `BookingModification` links still cannot be recovered when the original extra-link write is lost.
2. Add deterministic recovery for those remaining links using durable local state that already exists, or the outbound operation ledger if no canonical local field exists.
3. Only add a new incremental pull step if a webhook-free gap remains after that link-recovery work.

Primary files:

- `src/lib/xero.ts`
- `src/lib/xero-inbound-reconciliation.ts`
- `src/lib/xero-operation-outbox.ts`
- `src/lib/xero-operation-retry.ts`

### 2. Phase 6 remaining: finish the outbox boundary decisions

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

### 3. Hardening and supportability

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

### 4. Phase 8 cleanup

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

## Next Agent Checklist

- Read this file first, then compare the remaining `Booking` / `BookingModification` Xero write paths in `src/lib/xero.ts` against the inbound recovery logic in `src/lib/xero-inbound-reconciliation.ts`.
- Do not reopen completed work around membership reconciliation, contact/group cache sync, membership-invoice-linked metadata refresh, or the landed credit-note refund/account-credit repairs unless the remaining link-recovery work forces a design change.
- Keep operator-triggered admin routes as repair/safety-net tools, not the primary reconciliation path.
