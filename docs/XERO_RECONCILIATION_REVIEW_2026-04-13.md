# Xero Reconciliation Review

## Scope

This review focuses on how TACBookings should reconcile booking and membership data with Xero, with an emphasis on:

- durable auditability of data pushed to and pulled from Xero
- deep links back to Xero objects
- failure visibility
- safe retry and re-push workflows

## Implementation Status (2026-04-14)

The review below started as a design and gap-analysis document. The codebase now has the reconciliation foundation, outbound operation ledgering, admin inspection, synchronous retry for supported failed operations, a queue-backed background replay path for queued retries, record-scoped Xero activity surfaces for the main admin workflows, repeated-failure alerting by correlation key, a nightly reconciliation report, an idempotent historical backfill for canonical Xero IDs into the new reconciliation tables, dedicated repair flows for the `PARTIAL` outbound states the code currently emits, webhook-driven inbound reconciliation for linked contact, invoice, payment, and credit-note events, operator-facing admin tooling for inspecting and replaying stored inbound events both centrally and from the record-scoped activity view, a Phase 6 steady-state reduction that now trusts persisted member contact links by default, lets retry/replay flows explicitly relink stale contacts, and auto-repairs stale contact references on the first steady-state write failure, and now durable initial-write outbox paths for entrance-fee invoices, automatic booking invoices, standard allocated refund credit notes, unapplied account-credit notes, booking-modification supplementary invoices, and booking-modification credit notes. The remaining work is now mostly around incremental pull support, richer business-state drift detection, optional Xero-side history/attachment enrichment, and deciding which intentionally operator-triggered repair routes should also converge on the outbox.

### Completed in this session

- extended the initial-write outbox in `src/lib/xero-operation-outbox.ts` from refund-credit-note coverage to unapplied account-credit notes
  - added an `ACCOUNT_CREDIT_NOTE` queue payload beside the existing entrance-fee, booking-invoice, refund-credit-note, supplementary-invoice, and modification-credit-note payloads
  - the outbox worker now claims and executes queued account-credit notes on the same durable `XeroSyncOperation` row used for queueing
- updated `createUnappliedXeroCreditNote()` in `src/lib/xero.ts` so it can execute against an existing pending outbox row instead of always creating a fresh `XeroSyncOperation`
  - queued runs now complete successfully when the account-credit note is already linked instead of attempting a duplicate create
  - successful writes now backfill the matching `MemberCredit.xeroCreditNoteId` row after the Xero credit note is created
- moved the credit-cancellation path in `src/lib/booking-cancel.ts` onto the durable outbox flow
  - the local `MemberCredit` ledger row is created first so the member-facing credit balance is available immediately
  - the Xero-side open credit note is then queued and kicked best-effort instead of being created inline inside the request
- added focused coverage for the account-credit-note outbox extension and cancellation rewiring:
  - `src/lib/__tests__/xero-operation-outbox.test.ts`
  - `src/lib/__tests__/booking-cancel.test.ts`
- extended the initial-write outbox in `src/lib/xero-operation-outbox.ts` from refund-credit-note coverage to the booking-modification write paths
  - added `SUPPLEMENTARY_INVOICE` and `MODIFICATION_CREDIT_NOTE` queue payloads beside the existing entrance-fee, booking-invoice, and refund-credit-note payloads
  - the outbox worker now claims and executes queued supplementary invoices and queued modification credit notes on the same durable `XeroSyncOperation` row used for queueing
- updated `createXeroSupplementaryInvoice()` and `createXeroCreditNoteForModification()` in `src/lib/xero.ts` so they can execute against an existing pending outbox row instead of always creating a fresh `XeroSyncOperation`
  - queued no-op cases now complete successfully when there is no original Xero invoice or no billable/refundable amount instead of leaving the claimed row in `RUNNING`
- moved the booking-modification trigger paths onto the durable outbox flow:
  - date-change modifications in `src/app/api/bookings/[id]/modify-dates/route.ts`
  - batch booking modifications in `src/app/api/bookings/[id]/modify/route.ts`
  - guest-add modifications in `src/app/api/bookings/[id]/guests/route.ts`
  - guest-removal modifications in `src/app/api/bookings/[id]/guests/[guestId]/route.ts`
- added focused coverage for the modification-write outbox extension and trigger rewiring:
  - `src/lib/__tests__/xero-operation-outbox.test.ts`
  - `src/lib/__tests__/fix-mod-payment.test.ts`
  - `src/lib/__tests__/batch-modify-payment.test.ts`
  - `src/lib/__tests__/phase8b-booking-mods.test.ts`
- extended the initial-write outbox in `src/lib/xero-operation-outbox.ts` from invoices to the standard refund-credit-note path
  - added a `REFUND_CREDIT_NOTE` queue payload beside the existing entrance-fee and booking-invoice payloads
  - the outbox worker now claims and executes queued refund credit notes on the same durable `XeroSyncOperation` row used for queueing
- updated `createXeroCreditNote()` in `src/lib/xero.ts` so it can execute against an existing pending outbox row instead of always creating a fresh `XeroSyncOperation`
  - when the refund credit note is already linked by the time a queued worker picks it up, the claimed operation is now completed successfully instead of being left running
- moved the standard allocated refund-credit-note trigger paths onto the durable outbox flow:
  - Stripe `charge.refunded` handling in `src/app/api/webhooks/stripe/route.ts`
  - card-refund booking cancellations in `src/lib/booking-cancel.ts`
  - approved admin refund appeals in `src/app/api/admin/refund-requests/[id]/route.ts`
- added focused coverage for the refund-credit-note outbox extension and trigger rewiring:
  - `src/lib/__tests__/xero-operation-outbox.test.ts`
  - `src/lib/__tests__/stripe-webhook-alerts.test.ts`
  - `src/lib/__tests__/admin-refund-request-review-route.test.ts`
- extended the initial-write outbox in `src/lib/xero-operation-outbox.ts` from entrance-fee invoices to booking invoices
  - added a `BOOKING_INVOICE` queue payload beside the existing entrance-fee payload
  - the outbox worker now claims and executes both queued entrance-fee invoices and queued booking invoices
  - automatic booking-invoice writes now reuse the same durable `XeroSyncOperation` row for claim, request payload update, execution, and final success/failure state
- updated `createXeroInvoiceForBooking()` in `src/lib/xero.ts` so it can execute against an existing pending outbox row instead of always creating a fresh `XeroSyncOperation`
- moved the automatic booking-invoice trigger paths onto the durable outbox flow:
  - zero-dollar booking creation in `src/app/api/bookings/route.ts`
  - draft confirmation in `src/app/api/bookings/[id]/confirm-draft/route.ts`
  - zero-dollar waitlist confirmation in `src/app/api/bookings/[id]/waitlist-confirm/route.ts`
  - saved-card charging in `src/app/api/payments/charge-saved-method/route.ts`
  - successful Stripe payment webhooks in `src/app/api/webhooks/stripe/route.ts`
  - pending-booking confirmation cron in `src/lib/cron-confirm-pending.ts`
- explicitly left the admin repair path synchronous for now:
  - `src/app/api/admin/payments/[id]/generate-invoice/route.ts` still creates the invoice inline so an operator-triggered repair returns an immediate result rather than just queueing work
- added focused coverage for the booking-invoice outbox extension and trigger rewiring:
  - `src/lib/__tests__/xero-operation-outbox.test.ts`
  - `src/lib/__tests__/charge-saved-method-route.test.ts`
  - `src/lib/__tests__/cron-confirm-pending.test.ts`
  - `src/lib/__tests__/stripe-webhook-alerts.test.ts`
  - `src/lib/__tests__/zero-dollar-booking.test.ts`
  - `src/lib/__tests__/admin-book-on-behalf.test.ts`
  - `src/lib/__tests__/issue7-8-draft-subscription.test.ts`
  - `src/lib/__tests__/phase2-guest-subscription.test.ts`
- added the first true initial-write outbox flow in `src/lib/xero-operation-outbox.ts`
  - entrance-fee invoice creation is now queued as a `PENDING` primary `XeroSyncOperation` row instead of running only as fire-and-forget inline work
  - the worker claims that same row, executes the outbound write, and completes/fails the same ledger entry rather than creating a separate wrapper operation
- updated `createXeroEntranceFeeInvoice()` in `src/lib/xero.ts` so it can execute against an existing pending operation row and reuse the precomputed entrance-fee context stored in the queue payload
- moved the two current entrance-fee creation triggers onto the durable outbox path:
  - admin member creation in `src/app/api/admin/members/route.ts`
  - membership approval in `src/lib/nomination.ts`
- added best-effort immediate outbox kicks plus durable scheduled/manual draining:
  - `processQueuedXeroOutboxOperations()` is now run from `src/instrumentation.ts` alongside the retry worker
  - `/api/cron/xero` now supports `task=outbox` and includes outbox processing in `task=all`
- added focused coverage for the new outbox path and updated related tests:
  - `src/lib/__tests__/xero-operation-outbox.test.ts`
  - `src/lib/__tests__/xero-cron-route.test.ts`
  - `src/lib/__tests__/membership-nomination.test.ts`
  - `src/lib/__tests__/phase3-admin-members.test.ts`
  - `src/lib/__tests__/phase4-address-dependent.test.ts`
- removed the steady-state `getContact()` verification read from `findOrCreateXeroContact()` in `src/lib/xero.ts`
  - normal invoice / credit-note / entrance-fee write paths now trust `member.xeroContactId` directly and avoid the extra Xero read when the local canonical link already exists
  - `findOrCreateXeroContact()` now also supports an explicit repair/relookup mode that re-searches by email and relinks stale contacts when a retry/replay path opts in
- wired retry/replay flows in `src/lib/xero-operation-retry.ts` to opt into that explicit relink mode before recreating:
  - booking invoices
  - refund credit notes
  - account-credit notes
  - supplementary invoices
  - modification credit notes
  - entrance-fee invoices
- added focused coverage for the new contact-link trust and retry-repair behavior in:
  - `src/lib/__tests__/xero-find-or-create-contact.test.ts`
  - `src/lib/__tests__/xero-operation-retry.test.ts`
- added inline stale-contact repair on the initial steady-state write paths in `src/lib/xero.ts`
  - new shared stale-contact detection and one-shot relink/retry helper now repairs the member contact link automatically when Xero rejects a stale contact reference
  - first-pass steady-state writes now auto-repair for contact updates, booking invoices, refund credit notes, unapplied account-credit notes, supplementary invoices, modification credit notes, and entrance-fee invoices
  - when a repair changes the target contact ID mid-flight, the running `XeroSyncOperation` request payload is updated before retry so the reconciliation ledger reflects the repaired write target
- added focused helper coverage for the new inline repair path in:
  - `src/lib/__tests__/xero.test.ts`
- extended stored inbound reconciliation in `src/lib/xero-inbound-reconciliation.ts` to handle Xero-side `PAYMENT` and `CREDIT_NOTE` events
  - payment events now restore payment object links from linked invoice / credit-note context, refresh local `Payment.xeroInvoiceId` / `xeroInvoiceNumber` metadata where safe, and trigger linked membership subscription refresh for subscription invoices
  - credit-note events now restore canonical refund credit-note links, rebuild allocation links from Xero allocations, restore refund-payment links from Xero payment data, and backfill `Payment.xeroRefundCreditNoteId` where safe
- extended the record-scoped Xero activity surface so operators can inspect and replay matching stored inbound events from `src/components/admin/xero-record-activity-panel.tsx`, backed by the enriched `src/lib/xero-record-activity.ts` payload
- added focused coverage for the new inbound handlers and record-scoped inbound-event surface in:
  - `src/lib/__tests__/xero-inbound-reconciliation.test.ts`
  - `src/lib/__tests__/xero-record-activity.test.ts`

### Delivered to date

- added durable reconciliation tables in `prisma/schema.prisma`:
  - `XeroSyncOperation`
  - `XeroObjectLink`
  - `XeroInboundEvent`
- added migration `prisma/migrations/20260413210000_add_xero_reconciliation_foundation/`
- added shared helpers:
  - `src/lib/xero-sync.ts` for operation logging, object-link persistence, inbound-event persistence, and deterministic idempotency helpers
  - `src/lib/xero-links.ts` for centralized Xero deep-link generation
- instrumented outbound Xero write paths in `src/lib/xero.ts` to:
  - generate deterministic idempotency keys
  - use `withXeroRetry()` on write calls as well as reads
  - persist request and response payloads
  - record `SUCCEEDED`, `FAILED`, and `PARTIAL` outcomes
  - persist reusable `XeroObjectLink` rows for created or linked objects
- covered these business flows in the ledger:
  - member contact create and update
  - booking invoice creation
  - refund credit note creation
  - unapplied credit note creation for account credit
  - credit note allocations
  - supplementary invoices for booking modifications
  - modification credit notes for booking reductions
  - entrance fee invoices
  - membership subscription refresh / fetch
- updated modification routes so Xero artifacts can be tied to the specific `BookingModification` row, not only the parent booking
- updated manual member link / unlink routes to maintain `XeroObjectLink`
- updated `src/app/api/webhooks/xero/route.ts` to persist inbound webhook payloads into `XeroInboundEvent`
- added the first stored-event inbound reconciliation worker:
  - `src/lib/xero-inbound-reconciliation.ts`
  - `ProcessedWebhookEvent` claim / dedupe for Xero inbound events using the stored correlation key
  - linked contact reconciliation that safely backfills missing member canonical/contact fields and restores `XeroObjectLink`
  - linked invoice reconciliation that refreshes payment invoice metadata and triggers membership subscription refresh for linked records
  - linked payment reconciliation that restores payment links, refreshes linked payment invoice metadata, and refreshes subscription status via the linked invoice when applicable
  - linked credit-note reconciliation that restores canonical refund credit-note links, allocation links, and refund-payment links for already-linked local records
  - after-response worker kick from `src/app/api/webhooks/xero/route.ts`
  - manual and scheduled safety-net execution via `src/app/api/cron/xero/route.ts` and `src/instrumentation.ts`
- hardened inbound event persistence in `src/lib/xero-sync.ts` so duplicate webhook deliveries do not reset already `PROCESSING` / `PROCESSED` rows back to `RECEIVED`
- added operator-facing inbound event inspection and targeted replay:
  - `src/app/api/admin/xero/inbound-events/route.ts`
  - `src/app/api/admin/xero/inbound-events/[id]/replay/route.ts`
  - inbound events section on `src/app/(admin)/admin/xero/page.tsx`
  - explicit single-event replay helper in `src/lib/xero-inbound-reconciliation.ts` that clears the stored dedupe claim before reprocessing
- added an admin operations endpoint and UI surface:
  - `src/app/api/admin/xero/operations/route.ts`
  - operations section on `src/app/(admin)/admin/xero/page.tsx`
- added synchronous admin retry support for supported failed operations:
  - `src/lib/xero-operation-retry.ts`
  - `src/app/api/admin/xero/operations/[id]/retry/route.ts`
  - retry controls in `src/app/(admin)/admin/xero/page.tsx`
- hardened those retry paths so contact-dependent outbound replays can explicitly relink a stale `member.xeroContactId` before retrying the write, rather than repeating the stale reference indefinitely
- hardened the steady-state outbound write paths so the first stale-contact failure now auto-repairs inline rather than waiting for an explicit retry/replay action
- added queue-backed requeue and worker processing for supported failed operations:
  - `src/lib/xero-operation-queue.ts`
  - `src/lib/xero-operation-outbox.ts` for the current primary-write outbox paths
  - `src/app/api/admin/xero/operations/[id]/requeue/route.ts`
  - `PENDING` / `REQUEUE` controls and visibility in `src/app/(admin)/admin/xero/page.tsx`
  - scheduled replay worker in `src/instrumentation.ts`
  - manual cron support in `src/app/api/cron/xero/route.ts` via `task=outbox`, `task=retries`, `task=report`, `task=backfill`, or `task=all`
- added dedicated repair handling for the currently emitted `PARTIAL` outbound flows:
  - retry metadata and repair dispatch in `src/lib/xero-operation-retry.ts`
  - helper paths in `src/lib/xero.ts` to record missing invoice payments, record missing refund payments, and replay missing credit-note allocations against already-created Xero objects
  - admin retry / requeue flows can now repair:
    - booking invoice payment recording after invoice creation
    - supplementary invoice payment recording after invoice creation
    - refund credit note allocation and refund-payment follow-up
    - modification credit note allocation
- added record-scoped Xero activity views and shared resolution helpers:
  - `src/lib/xero-record-links.ts`
  - `src/lib/xero-record-types.ts`
  - `src/lib/xero-record-activity.ts`
  - `src/app/api/admin/xero/records/[localModel]/[localId]/route.ts`
  - `src/app/(admin)/admin/xero/records/[localModel]/[localId]/page.tsx`
  - `src/components/admin/xero-record-activity-panel.tsx`
- extended the record-scoped Xero activity surface with matching stored inbound events and replay controls:
  - the record-activity payload now includes inbound events that match the scope's linked Xero object IDs
  - the record-activity panel can replay those events without returning to the central Xero admin screen
- exposed record-scoped activity entry points from the main admin workflows:
  - inline member Xero activity card on `src/app/(admin)/admin/members/[id]/page.tsx`
  - booking activity links on `src/app/(admin)/admin/bookings/page.tsx`
  - payment activity links on `src/app/(admin)/admin/payments/page.tsx`
- added hardening/reporting helpers and operational alerts:
  - `src/lib/xero-hardening.ts`
  - repeated-failure admin alerting by correlation key, triggered from `src/lib/xero-sync.ts`
  - nightly reconciliation report email covering missing canonical links, stale operations, and repeated failures
  - manual/scheduled cron support for `task=report` and `task=backfill` in `src/app/api/cron/xero/route.ts` and `src/instrumentation.ts`
- added historical canonical-link backfill into the reconciliation tables:
  - member contact links from `Member.xeroContactId`
  - payment invoice links from `Payment.xeroInvoiceId`
  - payment refund credit-note links from `Payment.xeroRefundCreditNoteId`
  - subscription invoice links from `MemberSubscription.xeroInvoiceId`
  - synthetic `BACKFILL_LINK` ledger rows so these historical objects are visible in `XeroSyncOperation`

### Verified to date

- `npx vitest run src/lib/__tests__/xero.test.ts src/lib/__tests__/xero-member-management.test.ts src/lib/__tests__/phase8c-integrations.test.ts src/lib/__tests__/phone-address-sync.test.ts src/lib/__tests__/phase3b-member-detail-edit.test.ts`
- `npx vitest run src/lib/__tests__/xero-operation-retry.test.ts`
- `npx vitest run src/lib/__tests__/xero-operation-retry.test.ts src/lib/__tests__/xero-operation-queue.test.ts`
- `npx vitest run src/lib/__tests__/xero-record-activity.test.ts src/lib/__tests__/xero-operation-retry.test.ts src/lib/__tests__/xero-operation-queue.test.ts`
- `npx vitest run src/lib/__tests__/xero-hardening.test.ts src/lib/__tests__/xero-cron-route.test.ts src/lib/__tests__/phase6b-notifications.test.ts`
- `npx vitest run src/lib/__tests__/xero.test.ts src/lib/__tests__/xero-member-management.test.ts src/lib/__tests__/phase8c-integrations.test.ts src/lib/__tests__/phone-address-sync.test.ts src/lib/__tests__/phase3b-member-detail-edit.test.ts src/lib/__tests__/xero-operation-retry.test.ts src/lib/__tests__/xero-operation-queue.test.ts src/lib/__tests__/xero-record-activity.test.ts src/lib/__tests__/xero-hardening.test.ts src/lib/__tests__/xero-cron-route.test.ts src/lib/__tests__/phase6b-notifications.test.ts`
- `npx vitest run src/lib/__tests__/xero-operation-retry.test.ts src/lib/__tests__/xero-operation-queue.test.ts src/lib/__tests__/xero-record-activity.test.ts src/lib/__tests__/xero-hardening.test.ts src/lib/__tests__/xero-cron-route.test.ts`
- `npx vitest run src/lib/__tests__/xero-sync.test.ts src/lib/__tests__/xero-inbound-reconciliation.test.ts src/lib/__tests__/xero-cron-route.test.ts`
- `npx vitest run src/lib/__tests__/xero-inbound-reconciliation.test.ts src/lib/__tests__/xero-inbound-events-routes.test.ts src/lib/__tests__/xero-cron-route.test.ts`
- `npx vitest run src/lib/__tests__/xero.test.ts src/lib/__tests__/xero-api-usage.test.ts src/lib/__tests__/xero-member-management.test.ts src/lib/__tests__/member-subscription-status.test.ts src/lib/__tests__/xero-operation-retry.test.ts src/lib/__tests__/xero-operation-queue.test.ts src/lib/__tests__/xero-hardening.test.ts src/lib/__tests__/xero-cron-route.test.ts src/lib/__tests__/xero-sync.test.ts src/lib/__tests__/xero-inbound-reconciliation.test.ts`
- `npx vitest run src/lib/__tests__/xero-inbound-reconciliation.test.ts src/lib/__tests__/xero-record-activity.test.ts src/lib/__tests__/xero-inbound-events-routes.test.ts src/lib/__tests__/xero-cron-route.test.ts`
- `npx vitest run src/lib/__tests__/xero.test.ts src/lib/__tests__/xero-find-or-create-contact.test.ts src/lib/__tests__/xero-operation-retry.test.ts`
- `npx vitest run src/lib/__tests__/xero-operation-outbox.test.ts src/lib/__tests__/charge-saved-method-route.test.ts src/lib/__tests__/cron-confirm-pending.test.ts src/lib/__tests__/stripe-webhook-alerts.test.ts src/lib/__tests__/zero-dollar-booking.test.ts src/lib/__tests__/admin-book-on-behalf.test.ts src/lib/__tests__/issue7-8-draft-subscription.test.ts src/lib/__tests__/phase2-guest-subscription.test.ts`
- `npx vitest run src/lib/__tests__/xero-operation-outbox.test.ts src/lib/__tests__/stripe-webhook-alerts.test.ts src/lib/__tests__/admin-refund-request-review-route.test.ts`
- `npx vitest run src/lib/__tests__/xero-operation-outbox.test.ts src/lib/__tests__/fix-mod-payment.test.ts src/lib/__tests__/batch-modify-payment.test.ts src/lib/__tests__/phase8b-booking-mods.test.ts`
- `npx vitest run src/lib/__tests__/xero-operation-outbox.test.ts src/lib/__tests__/booking-cancel.test.ts src/lib/__tests__/xero-operation-retry.test.ts`
- `npx eslint src/lib/xero-operation-outbox.ts src/lib/xero.ts src/app/api/bookings/[id]/modify-dates/route.ts src/app/api/bookings/[id]/modify/route.ts src/app/api/bookings/[id]/guests/route.ts src/app/api/bookings/[id]/guests/[guestId]/route.ts src/lib/__tests__/xero-operation-outbox.test.ts src/lib/__tests__/fix-mod-payment.test.ts src/lib/__tests__/batch-modify-payment.test.ts src/lib/__tests__/phase8b-booking-mods.test.ts`
- `npx eslint src/lib/xero-operation-outbox.ts src/lib/xero.ts src/lib/booking-cancel.ts src/lib/__tests__/xero-operation-outbox.test.ts src/lib/__tests__/booking-cancel.test.ts`
- `npx eslint src/lib/xero.ts src/lib/__tests__/xero.test.ts`
- `npm run build`

### Not yet implemented

The remaining work is now concentrated in two implementation tracks plus two maintenance notes:

1. Decide which intentionally operator-triggered repair/generation paths should also converge on the primary outbound outbox flow.
2. Extend inbound reconciliation beyond the current linked contact / invoice / payment / credit-note handlers.
3. Extend hardening from canonical-link health into richer drift detection and supportability.
4. Keep future/new `PARTIAL` operation types explicit, with dedicated repair handlers and tests.

For the next agent, the important baseline is:

- observability foundation: implemented
- deterministic outbound write tracking: implemented
- admin inspection of recent operations: implemented
- synchronous retry for supported failed outbound operations: implemented
- queue-backed replay for supported failed outbound operations: implemented
- dedicated repair flows for the currently emitted partial outbound operations: implemented
- stored inbound event claim / dedupe and webhook-driven contact / invoice / payment / credit-note reconcile handlers: implemented
- operator-facing inbound event inspection / replay, including record-scoped replay surfaces: implemented
- repeated-failure alerting by correlation key: implemented
- nightly reconciliation reporting: implemented
- historical canonical-ID backfill into `XeroObjectLink` / `XeroSyncOperation`: implemented
- primary-write outbox for entrance-fee invoices, automatic booking invoices, standard allocated refund credit notes, unapplied account-credit notes, booking-modification supplementary invoices, and booking-modification credit notes: implemented
- incremental pull / richer drift application beyond the current contact / invoice / payment / credit-note handlers: pending

## Current State

The codebase already has a solid base:

- encrypted Xero OAuth token storage in `prisma/schema.prisma` (`XeroToken`)
- Xero rate-limit handling for many read paths in `src/lib/xero.ts` via `withXeroRetry()`
- generic local audit logging in `prisma/schema.prisma` (`AuditLog`) and `src/lib/audit.ts`
- webhook delivery monitoring in `prisma/schema.prisma` (`WebhookLog`) and `src/lib/webhook-log.ts`
- canonical Xero links stored for some objects:
  - member contact link via `Member.xeroContactId`
  - booking invoice link via `Payment.xeroInvoiceId` and `xeroInvoiceNumber`
  - subscription invoice link via `MemberSubscription.xeroInvoiceId`, `xeroInvoiceNumber`, `xeroOnlineInvoiceUrl`

There is also some manual remediation already:

- admins can generate a missing booking invoice through `src/app/api/admin/payments/[id]/generate-invoice/route.ts`
- admins can manually push and link contacts through the member admin UI and Xero routes

## Current Remaining Gaps

Before the larger tracks below, the Phase 6 contact-link trust baseline is now in place:

- steady-state write paths no longer spend a separate `getContact()` read just to verify an existing `member.xeroContactId`
- retry/replay paths can now explicitly relink stale contacts before reissuing contact-dependent writes
- the initial steady-state write attempt now auto-repairs once when Xero rejects a stale contact reference

The remaining contact-link work is now mostly maintenance:

- keep any future/new contact-dependent write path on the shared inline repair helper so the Phase 6 behavior does not regress

### 1. Move primary outbound writes to a true outbox flow

Supported failed outbound operations can now be requeued durably from the admin UI, stored as `PENDING` replay rows, and processed by a worker path that runs both after-response and on a scheduled cron cadence. In addition, the same durable primary-write outbox pattern now covers:

- entrance-fee invoice creation
- automatic booking invoice creation across booking creation, draft confirmation, waitlist confirmation, saved-card charging, Stripe payment webhooks, and pending-confirmation cron
- standard allocated refund credit note creation across Stripe refund webhooks, card-refund booking cancellations, and approved admin refund appeals
- unapplied account-credit note creation on credit cancellations
- booking-modification supplementary invoice creation across date-change, batch-modify, guest-add, and guest-remove flows
- booking-modification credit note creation across date-change, batch-modify, and guest-remove flows

The remaining work in this track is now mostly about where to draw the line between backgrounded primary writes and intentionally request-bound repair flows:

- keep creating the primary outbound operation row in `PENDING` and executing that same operation from a worker for any new automatic write path
- preserve the crash-recovery guarantees now in place whenever a new automatic write path is introduced
- decide which intentionally operator-triggered repair/generation paths should stay request-bound and which should also enqueue

Suggested next decisions:

- decide whether `src/app/api/admin/payments/[id]/generate-invoice/route.ts` and any future operator-triggered refund/account-credit repair routes should remain explicit synchronous repair paths or also enqueue onto the outbox

### 2. Extend inbound reconciliation on top of stored `XeroInboundEvent` rows

The inbound side is no longer observability-only. Stored events are now claimed and deduped against `ProcessedWebhookEvent`, processed after the webhook response as well as on a scheduled/manual safety-net path, and reconciled into local state through the first linked-record handlers.

What is implemented now:

- `CONTACT` webhook events for linked members can safely:
  - preserve canonical `xeroContactId` linkage where missing
  - backfill missing local date-of-birth, phone, address, and joined-date fields
  - restore canonical `XeroObjectLink` rows
- `INVOICE` webhook events can now:
  - refresh linked `Payment.xeroInvoiceId` / `xeroInvoiceNumber` metadata
  - refresh linked `XeroObjectLink` invoice numbers / URLs
  - trigger targeted membership subscription refresh for linked subscription/contact records
- `PAYMENT` webhook events can now:
  - restore payment object links from existing invoice / credit-note linkage
  - refresh linked `Payment.xeroInvoiceId` / `xeroInvoiceNumber` metadata where that canonical link is still missing locally
  - trigger targeted membership subscription refresh for linked subscription invoices
- `CREDIT_NOTE` webhook events can now:
  - restore canonical refund credit-note links for linked payment records
  - rebuild synthetic allocation links from Xero allocation data
  - restore refund-payment links from the Xero credit-note payment payload where present

What still remains in this track:

- richer business-state application beyond the current safe backfill / refresh handlers
- incremental pull jobs using `If-Modified-Since`
- richer operator workflows on top of the new replay surface, such as bulk replay or more advanced scoped filtering / batching from the central admin Xero screen

### 3. Push remediation actions closer to the record-scoped Xero views

The admin Xero screen is no longer the only place operators can inspect reconciliation context. There is now a record-scoped Xero activity view that groups operations, links, and errors for:

- members and their subscriptions
- bookings and their related payment / modification records
- individual payments
- individual booking modifications

Entry points now exist from member detail, booking list, and payment list screens.

This track is mostly complete now.

- direct retry / requeue controls are available from the scoped record activity panel, not only the central admin operations screen
- the currently emitted `PARTIAL` cases remain covered through those same supported repair paths
- matching stored inbound events are now visible and replayable from the scoped record activity panel as well as the central admin Xero screen

The remaining UX gap here is narrower:

- booking and payment areas still enter the scoped activity view from list screens because those admin areas do not currently have dedicated detail pages
- additional record-specific shortcuts may still be worthwhile where operators spend most of their time

### 4. Extend hardening from canonical-link health into richer drift detection

The hardening layer is now materially better than the original review baseline:

- repeated-failure alerting by correlation key is implemented
- nightly reconciliation reports for missing canonical links and stale/repeated failures are implemented
- historical backfill of canonical member/payment/subscription Xero IDs into `XeroObjectLink` and synthetic `BACKFILL_LINK` ledger rows is implemented

What still remains in this area is:

- broadening the nightly report from canonical-link gaps into richer business-state drift detection
- reconstructing more legacy history than the currently backfilled canonical IDs
- optional Xero history notes or attachments where they materially improve supportability

### 5. Keep future/new `PARTIAL` handlers explicit

The currently emitted partial outbound states are covered. If new outbound flows later introduce `PARTIAL` outcomes, each one will still need:

- a deterministic repair handler in `src/lib/xero-operation-retry.ts`
- any supporting helper path in `src/lib/xero.ts`
- tests that prove the repair path is safe and replayable

## Recommended Design

## A. Add a dedicated Xero sync operations table

Best practice here is to introduce a durable per-operation ledger, for example `XeroSyncOperation`.

Suggested shape:

- `id`
- `direction`: `OUTBOUND` | `INBOUND`
- `entityType`: `CONTACT` | `INVOICE` | `PAYMENT` | `CREDIT_NOTE` | `ALLOCATION` | `SUBSCRIPTION`
- `operationType`: `CREATE` | `UPDATE` | `ALLOCATE` | `FETCH` | `WEBHOOK_RECONCILE`
- `localModel`: `Member` | `Booking` | `Payment` | `MemberSubscription` | `BookingModification`
- `localId`
- `status`: `PENDING` | `RUNNING` | `SUCCEEDED` | `FAILED` | `PARTIAL` | `CANCELLED`
- `idempotencyKey`
- `correlationKey`
- `attemptCount`
- `replayable`
- `lastErrorCode`
- `lastErrorMessage`
- `requestPayload` (JSON)
- `responsePayload` (JSON)
- `xeroObjectType`
- `xeroObjectId`
- `xeroObjectNumber`
- `xeroObjectUrl`
- `createdByMemberId` (nullable)
- `startedAt`
- `completedAt`
- `createdAt`
- `updatedAt`

This should become the audit trail for every Xero push and every meaningful Xero pull/webhook reconciliation.

## B. Keep canonical link fields, but add a reusable object-link table

The current `Member.xeroContactId`, `Payment.xeroInvoiceId`, and `MemberSubscription.xeroInvoiceId` fields are still useful as fast canonical pointers.

But for reconciliation and replay, add a normalized table such as `XeroObjectLink` so the system can store multiple related Xero objects per local record:

- one booking payment may have:
  - an invoice
  - one or more Xero payments
  - one or more credit notes
  - one or more allocations
- one booking modification may create:
  - a supplementary invoice
  - a modification credit note

Suggested fields:

- `localModel`
- `localId`
- `xeroObjectType`
- `xeroObjectId`
- `xeroObjectNumber`
- `xeroObjectUrl`
- `role` such as `PRIMARY_INVOICE`, `REFUND_CREDIT_NOTE`, `SUPPLEMENTARY_INVOICE`, `ALLOCATION`, `CONTACT`
- `active`

## C. Move outbound Xero writes behind an outbox-style service

For anything financially important, prefer this flow:

1. Complete the local database transaction first.
2. Insert a `XeroSyncOperation` row in `PENDING`.
3. Let a worker execute the Xero call.
4. Persist returned Xero IDs and links.
5. Mark the operation `SUCCEEDED` or `FAILED`.

This prevents request/response timing issues from becoming silent data drift and gives you a safe place to retry from.

For user-triggered actions where you still want an inline response, you can execute immediately but still write the same `XeroSyncOperation` row before and after the call.

## D. Use deterministic idempotency keys on every Xero write

Every outbound create/update/allocation call should have a deterministic idempotency key derived from the local action, for example:

- `booking:{bookingId}:invoice:v1`
- `payment:{paymentId}:refund-credit-note:{refundAmountCents}:v1`
- `booking-mod:{modificationId}:supplementary-invoice:v1`
- `member:{memberId}:contact:create:v1`

The key should be stored on `XeroSyncOperation` and reused for retries. That makes replay safe when the original write reached Xero but the local process failed afterward.

## E. Store raw inbound payloads and reconcile asynchronously

For Xero webhooks and incremental pull jobs:

- store the raw payload on a dedicated inbound events table such as `XeroInboundEvent`
- claim and dedupe by event ID or a derived correlation key
- enqueue reconciliation work from that stored event
- update the event row to `processed` / `failed`

This keeps inbound handling inspectable and replayable, and avoids losing the event context after the request completes.

## F. Add an admin Xero operations view

The admin Xero screen should gain an operations tab that supports:

- filtering by status: `FAILED`, `RUNNING`, `PENDING`, `SUCCEEDED`
- filtering by object type: contact, invoice, payment, credit note, allocation
- viewing local record, request payload, response payload, error, attempts
- deep links to the Xero object when present
- `Retry` / `Requeue` for replayable failures
- `Open local record` and `Open Xero object`

That is the operational UI the system is currently missing.

## G. Add Xero history notes and attachments selectively

Where helpful, write a lightweight history note into Xero and attach a document when it materially improves auditability.

Examples:

- invoice history note: `Created by TACBookings for booking abc12345`
- credit note history note: `Refund created from TACBookings payment pmt_123`
- attach booking summary PDF or exported receipt only when it solves a real support problem

This should complement the TACBookings sync ledger, not replace it.

## What To Persist Per Business Flow

### Booking invoice creation

Persist:

- Xero invoice ID
- Xero invoice number
- online invoice URL if available
- Xero payment ID for the recorded Stripe settlement
- operation log row

### Refund / credit note

Persist:

- Xero credit note ID
- Xero allocation outcome
- Xero refund payment ID if created
- operation log row

### Booking modification

Persist:

- supplementary invoice ID when price increases
- modification credit note ID when price decreases
- any associated payment/allocation IDs
- operation log row tied to the specific `BookingModification`

### Membership subscription refresh

Persist:

- the invoice checked
- the pull timestamp
- the comparison result
- the local status before and after
- operation log row per member refresh

## Repo-Specific Phase Plan

## Phase 1: Observability foundation

- add `XeroSyncOperation`
- add centralized Xero URL builder helper
- start logging all existing create/update calls into the new table
- add deep links for all already-known Xero IDs

Status: implemented in this pass.

## Phase 2: Safe outbound writes

- add deterministic idempotency keys to all Xero write calls in `src/lib/xero.ts`
- persist supplementary invoice and modification credit note links
- capture response payloads and error payloads

Status: implemented for the main existing Xero write flows in `src/lib/xero.ts`.

## Phase 3: Replay and manual repair

- add admin Xero operations UI
- add retry / requeue endpoints
- make booking/payment/member detail screens show related Xero operations

Status: mostly implemented.

- admin operations API and UI were added to the Xero admin screen
- synchronous retry support for supported failed operations is implemented
- queue-backed requeue / worker retry for supported failed operations is implemented
- record-scoped Xero activity surfaces are now available from member, booking, and payment admin workflows
- scoped record activity panels now expose retry / requeue controls for supported operations
- targeted partial-operation repair is implemented for the currently emitted invoice / credit-note follow-up states
- the remaining gap in this phase is mainly around broader navigation / entry-point polish, not the core retry capability itself

## Phase 4: Inbound reconciliation

- add `XeroInboundEvent`
- persist webhook payloads
- use webhooks plus targeted pull/reconcile jobs
- apply `If-Modified-Since` for incremental pull jobs

Status: partially implemented.

- `XeroInboundEvent` and webhook payload persistence were added
- stored inbound events are now claimed / deduped and processed through a worker path
- webhook-triggered linked contact, invoice, payment, and credit-note reconciliation is implemented
- admin inspection and targeted replay for stored inbound events is implemented centrally and from the record-scoped Xero activity view
- targeted incremental pull work and any additional inbound categories beyond the current handlers are still pending

## Phase 5: Hardening

- move high-value Xero writes to a background worker/outbox flow
- add alerting for repeated failures on the same correlation key
- add nightly reconciliation reports for missing local-to-Xero links

Status: partially implemented.

- repeated-failure alerting by correlation key is implemented
- nightly reconciliation reports for canonical-link gaps and stale/repeated failures are implemented
- canonical-field backfill into the reconciliation ledger/link tables is implemented
- move high-value Xero writes to a background worker/outbox flow is implemented for entrance-fee invoices, automatic booking invoices, standard allocated refund credit notes, unapplied account-credit notes, booking-modification supplementary invoices, and booking-modification credit notes
- the remaining inline primary writes are now the intentionally synchronous admin invoice-generation repair path and any future operator-triggered repair routes that we decide should stay request-bound
- richer drift reporting and optional Xero-side history/attachments are still pending

## Best-Practice Notes

- Do not rely on a generic audit log for accounting reconciliation. Financial integrations need a purpose-built sync ledger.
- Do not rely on UI-only manual repair. Persist enough metadata so retries can be deterministic and safe.
- Keep canonical foreign keys for the "main" Xero object, but use a normalized link table for one-to-many Xero artifacts.
- Make every outbound write idempotent and every inbound event replayable.
- Prefer incremental pull plus webhook-triggered reconciliation over full rescans whenever possible.
- Capture links to Xero objects at creation time so support staff can jump directly from TACBookings into Xero.

## Relevant Source Files

- `src/lib/xero.ts`
- `src/app/api/webhooks/xero/route.ts`
- `src/app/api/admin/payments/[id]/generate-invoice/route.ts`
- `src/app/api/bookings/[id]/modify/route.ts`
- `src/app/api/bookings/[id]/modify-dates/route.ts`
- `src/app/api/bookings/[id]/guests/route.ts`
- `src/app/api/bookings/[id]/guests/[guestId]/route.ts`
- `src/lib/audit.ts`
- `src/lib/webhook-log.ts`
- `prisma/schema.prisma`
- `src/lib/xero-sync.ts`
- `src/lib/xero-inbound-reconciliation.ts`
- `src/app/api/admin/xero/inbound-events/route.ts`
- `src/app/api/admin/xero/inbound-events/[id]/replay/route.ts`
- `src/lib/xero-operation-retry.ts`
- `src/lib/xero-links.ts`
- `src/lib/xero-hardening.ts`
- `src/lib/xero-record-links.ts`
- `src/lib/xero-record-types.ts`
- `src/lib/xero-record-activity.ts`
- `src/app/api/admin/xero/operations/route.ts`
- `src/app/api/admin/xero/operations/[id]/retry/route.ts`
- `src/app/api/admin/xero/records/[localModel]/[localId]/route.ts`
- `src/app/(admin)/admin/xero/page.tsx`
- `src/app/(admin)/admin/xero/records/[localModel]/[localId]/page.tsx`
- `src/components/admin/xero-record-activity-panel.tsx`
- `src/lib/__tests__/xero-sync.test.ts`
- `src/lib/__tests__/xero-inbound-reconciliation.test.ts`
- `src/lib/__tests__/xero-inbound-events-routes.test.ts`
- `src/lib/__tests__/xero-operation-retry.test.ts`
- `src/lib/__tests__/xero-record-activity.test.ts`
- `src/lib/__tests__/xero-hardening.test.ts`
- `src/lib/__tests__/xero-cron-route.test.ts`
