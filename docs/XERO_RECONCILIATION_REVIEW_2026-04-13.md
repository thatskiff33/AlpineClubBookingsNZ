# Xero Reconciliation Review

## Scope

This review focuses on how TACBookings should reconcile booking and membership data with Xero, with an emphasis on:

- durable auditability of data pushed to and pulled from Xero
- deep links back to Xero objects
- failure visibility
- safe retry and re-push workflows

## Implementation Status (2026-04-13)

The review below started as a design and gap-analysis document. The codebase now has the reconciliation foundation, outbound operation ledgering, admin inspection, synchronous retry for supported failed operations, a queue-backed background replay path for queued retries, record-scoped Xero activity surfaces for the main admin workflows, repeated-failure alerting by correlation key, a nightly reconciliation report, an idempotent historical backfill for canonical Xero IDs into the new reconciliation tables, and dedicated repair flows for the `PARTIAL` outbound states the code currently emits. The remaining work is now mostly around full outbox execution for initial writes, webhook-driven/incremental inbound reconcile jobs, richer drift detection, and optional Xero-side history/attachment enrichment.

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
- added an admin operations endpoint and UI surface:
  - `src/app/api/admin/xero/operations/route.ts`
  - operations section on `src/app/(admin)/admin/xero/page.tsx`
- added synchronous admin retry support for supported failed operations:
  - `src/lib/xero-operation-retry.ts`
  - `src/app/api/admin/xero/operations/[id]/retry/route.ts`
  - retry controls in `src/app/(admin)/admin/xero/page.tsx`
- added queue-backed requeue and worker processing for supported failed operations:
  - `src/lib/xero-operation-queue.ts`
  - `src/app/api/admin/xero/operations/[id]/requeue/route.ts`
  - `PENDING` / `REQUEUE` controls and visibility in `src/app/(admin)/admin/xero/page.tsx`
  - scheduled replay worker in `src/instrumentation.ts`
  - manual cron support in `src/app/api/cron/xero/route.ts` via `task=retries`, `task=report`, `task=backfill`, or `task=all`
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
- `npm run build`

### Not yet implemented

The remaining work is now concentrated in four implementation tracks plus one maintenance note:

1. Move primary outbound writes to a true outbox flow.
2. Build inbound reconciliation on top of stored `XeroInboundEvent` rows.
3. Push remediation actions closer to the record-scoped Xero views.
4. Extend hardening from canonical-link health into richer drift detection and supportability.
5. Keep future/new `PARTIAL` operation types explicit, with dedicated repair handlers and tests.

For the next agent, the important baseline is:

- observability foundation: implemented
- deterministic outbound write tracking: implemented
- admin inspection of recent operations: implemented
- synchronous retry for supported failed outbound operations: implemented
- queue-backed replay for supported failed outbound operations: implemented
- dedicated repair flows for the currently emitted partial outbound operations: implemented
- repeated-failure alerting by correlation key: implemented
- nightly reconciliation reporting: implemented
- historical canonical-ID backfill into `XeroObjectLink` / `XeroSyncOperation`: implemented

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

### 1. Move primary outbound writes to a true outbox flow

Supported failed outbound operations can now be requeued durably from the admin UI, stored as `PENDING` replay rows, and processed by a worker path that runs both after-response and on a scheduled cron cadence. That closes the immediate gap around background replay for known-safe failed operations.

What is still missing is the same pattern for the initial outbound write itself:

- create the primary outbound operation row in `PENDING`, then execute that same operation from a worker
- recover automatically from crashes or timeouts that happen after local state commits but before the first Xero write attempt
- move more high-value initial write flows away from request-bound inline execution

Suggested first candidates:

- booking invoice creation
- refund credit note creation
- supplementary invoice creation
- modification credit note creation
- entrance fee invoice creation

### 2. Build inbound reconciliation on top of stored `XeroInboundEvent` rows

`src/app/api/webhooks/xero/route.ts` now persists webhook payloads into `XeroInboundEvent`, but the inbound side is still observability-first rather than reconciliation-first. The next layer should add:

- claim/dedupe processing tied to `ProcessedWebhookEvent`
- targeted reconcile jobs triggered from stored inbound events
- applying inbound invoice/contact changes back to TACBookings business state
- incremental pull jobs using `If-Modified-Since`

This is the main missing functional area if the goal is full two-way reconciliation rather than just outbound auditability.

### 3. Push remediation actions closer to the record-scoped Xero views

The admin Xero screen is no longer the only place operators can inspect reconciliation context. There is now a record-scoped Xero activity view that groups operations, links, and errors for:

- members and their subscriptions
- bookings and their related payment / modification records
- individual payments
- individual booking modifications

Entry points now exist from member detail, booking list, and payment list screens.

What is still missing operationally is broader remediation from those scoped views:

- direct retry / requeue / repair actions from the scoped views instead of relying on the central admin operations screen
- booking and payment areas still enter the scoped activity view from list screens because those admin areas do not currently have dedicated detail pages

The currently emitted `PARTIAL` cases are already covered. What remains is surfacing those actions where operators are already working.

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
- targeted partial-operation repair is implemented for the currently emitted invoice / credit-note follow-up states
- the remaining gap in this phase is moving retry / requeue / repair actions closer to the scoped record views

## Phase 4: Inbound reconciliation

- add `XeroInboundEvent`
- persist webhook payloads
- use webhooks plus targeted pull/reconcile jobs
- apply `If-Modified-Since` for incremental pull jobs

Status: partially implemented.

- `XeroInboundEvent` and webhook payload persistence were added
- targeted reconcile jobs and incremental pull work are still pending

## Phase 5: Hardening

- move high-value Xero writes to a background worker/outbox flow
- add alerting for repeated failures on the same correlation key
- add nightly reconciliation reports for missing local-to-Xero links

Status: partially implemented.

- repeated-failure alerting by correlation key is implemented
- nightly reconciliation reports for canonical-link gaps and stale/repeated failures are implemented
- canonical-field backfill into the reconciliation ledger/link tables is implemented
- move high-value Xero writes to a background worker/outbox flow is still pending
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
- `src/lib/__tests__/xero-operation-retry.test.ts`
- `src/lib/__tests__/xero-record-activity.test.ts`
- `src/lib/__tests__/xero-hardening.test.ts`
- `src/lib/__tests__/xero-cron-route.test.ts`
