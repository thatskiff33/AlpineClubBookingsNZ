BEGIN;

-- #2929 (MAD epic #2725): carry an administrator's creation-time "do not email
-- the member" choice through to the Xero invoice email raised by that same
-- booking creation.
--
-- The invoice is not raised by the request that created the booking. The create
-- enqueues an outbox operation; a worker runs it later, and an operator retry
-- may run it later still. The choice therefore has to be PERSISTED on the
-- operation, or a retry hours afterwards cannot tell a deliberate withhold from
-- a caller flag that simply went out of scope -- and it would email the member
-- the officer chose not to email.
--
-- WHY A COLUMN AND NOT A requestPayload KEY. The booking-invoice handler
-- rewrites "requestPayload" wholesale with the Xero invoice request before its
-- first provider call, and the contact repair rewrites it again; both drop
-- every key the enqueue put there, which is exactly what the "queueType"
-- column's own comment records. A payload key would survive the happy path and
-- vanish on the one execution that needs it. Like "queueType", this column is
-- written once at enqueue and never updated.
--
-- EXPAND ONLY, and no stored value changes. The column is NULLABLE with no
-- DEFAULT, so every existing row keeps NULL, which the reader
-- (readXeroInvoiceEmailInstruction) treats as "no instruction was recorded" --
-- the honest state of every operation enqueued before this migration and of
-- every enqueuer that has no on-behalf email choice to express. NULL sends
-- exactly as today, so no deployment changes behaviour on deploy and no
-- backfill is owed.
--
-- OLD-CODE COMPATIBLE IN BOTH WINDOWS: Prisma names its columns explicitly, so
-- the draining colour's generated client never selects this column and its
-- INSERTs omit it, which a nullable column with no default accepts. An
-- operation enqueued by the new colour and dispatched by the old one loses the
-- withhold and emails the invoice -- which is the behaviour on main today, not
-- a new failure, and it cannot send a SECOND email either way because the
-- emailInvoice idempotency key is per invoice.
ALTER TABLE "XeroSyncOperation"
  ADD COLUMN "invoiceEmailDelivery" TEXT;

COMMIT;
