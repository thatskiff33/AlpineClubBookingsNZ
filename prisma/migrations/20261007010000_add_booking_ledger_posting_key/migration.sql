-- #3595 — every booking-ledger posting carries an idempotency key.
--
-- TWO STATEMENTS, BOTH ADDITIVE: one nullable column and one unique index on
-- a table (#3580) that nothing reads yet. No existing row is changed.
--
-- WHY: a booking can pass the settle's PAID claim twice — an officer marks it
-- paid, reverses the mark-paid (which restores a payable status), and the
-- member then pays by card — and every settlement writer is an upsert a
-- provider replays. Without a key the same event posts its lines twice. With
-- one, the write door inserts with ON CONFLICT DO NOTHING and a repeat is a
-- no-op: not a duplicate line, and not a refused statement that would abort
-- the caller's transaction.
--
-- PHASE: expand. OLD_CODE_COMPATIBLE: yes. The column is nullable, so the
-- draining colour's inserts — which do not name it — succeed and store NULL,
-- and Postgres treats NULLs as distinct under a unique index. The new colour
-- always supplies a key (the write door's type requires it).
--
-- LOCK IMPACT: ADD COLUMN with no default is catalog-only. CREATE UNIQUE INDEX
-- (not CONCURRENTLY: the table is a few rows at most, written only by the
-- settle, and CONCURRENTLY cannot run inside Prisma's migration transaction)
-- takes a SHARE lock on BookingLedgerLine for the duration of a build over an
-- empty or near-empty table. BookingLedgerLine is not a hot table.
--
-- REVERSE: drop the index, then the column. Only the keys are lost; the lines
-- themselves are untouched. rollback.sql beside this file is that, verbatim.
--
-- IDEMPOTENCY: not idempotent; Prisma's ledger prevents replay.

-- AlterTable
ALTER TABLE "BookingLedgerLine" ADD COLUMN "postingKey" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "BookingLedgerLine_postingKey_key" ON "BookingLedgerLine"("postingKey");
