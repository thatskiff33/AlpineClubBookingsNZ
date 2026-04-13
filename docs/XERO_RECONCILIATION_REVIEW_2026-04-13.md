# Xero Reconciliation Review

## Scope

This review focuses on how TACBookings should reconcile booking and membership data with Xero, with an emphasis on:

- durable auditability of data pushed to and pulled from Xero
- deep links back to Xero objects
- failure visibility
- safe retry and re-push workflows

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

## Main Gaps

### 1. No durable Xero sync ledger

`AuditLog` is generic and `WebhookLog` only tracks webhook delivery health. There is no single source of truth for:

- what local record triggered a Xero write
- the exact outbound payload
- the Xero response
- whether the action succeeded, partially succeeded, or failed
- whether the action is safe to replay

This means the system cannot answer operational questions like:

- "Did we already try to create the invoice?"
- "Which Xero object was created for this booking modification?"
- "Was the payment created but the local DB update failed afterward?"

### 2. Xero write calls are not consistently idempotent

The code makes direct write calls in `src/lib/xero.ts` such as:

- `createContacts`
- `updateContact`
- `createInvoices`
- `createPayment` / `createPayments`
- `createCreditNotes`
- `createCreditNoteAllocation`

Those calls currently do not pass Xero idempotency keys, and most are not wrapped in the same retry discipline used for reads. If a network timeout or process crash happens after Xero accepts a write but before TACBookings persists the returned Xero ID, a retry can create duplicates or leave TACBookings unsure about the real outcome.

### 3. Only some Xero object IDs are persisted

The base booking invoice is persisted on `Payment`, and subscription invoices are persisted on `MemberSubscription`. But modification-related Xero objects are not durably linked:

- supplementary invoices returned by `createXeroSupplementaryInvoice()`
- modification credit notes returned by `createXeroCreditNoteForModification()`
- Xero payment records created against invoices
- Xero allocation records created for credit notes

Those functions are often called fire-and-forget from booking modification routes, and the returned Xero IDs are not stored anywhere reusable.

### 4. Inbound Xero activity is not reconciled into business state

`src/app/api/webhooks/xero/route.ts` verifies signatures and records webhook delivery status, but it does not:

- persist raw payloads for investigation
- mark events as processed using `ProcessedWebhookEvent`
- update local booking or membership state from webhook data
- enqueue a targeted reconciliation job

So the webhook endpoint is currently observability-only, not a reconciliation mechanism.

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

## Phase 2: Safe outbound writes

- add deterministic idempotency keys to all Xero write calls in `src/lib/xero.ts`
- persist supplementary invoice and modification credit note links
- capture response payloads and error payloads

## Phase 3: Replay and manual repair

- add admin Xero operations UI
- add retry / requeue endpoints
- make booking/payment/member detail screens show related Xero operations

## Phase 4: Inbound reconciliation

- add `XeroInboundEvent`
- persist webhook payloads
- use webhooks plus targeted pull/reconcile jobs
- apply `If-Modified-Since` for incremental pull jobs

## Phase 5: Hardening

- move high-value Xero writes to a background worker/outbox flow
- add alerting for repeated failures on the same correlation key
- add nightly reconciliation reports for missing local-to-Xero links

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
