-- #3643 (owner decision 28 Sep 2026, on the issue's DECISION RECORD comment).
-- INV-PAY-107.
--
-- An officer may cancel an internet banking booking as unpaid while Xero records
-- a payment against its invoice that the app cannot hand back as credit: the
-- booking belongs to an organisation, or Xero could not give the amount exactly
-- (the thread's ORCHESTRATOR DECISION 2). The owner asked for that cancel to
-- raise a task in the hand-back queue, so the Xero repair tool's manual-review
-- finding for the booking goes quiet once a treasurer has closed it. The task
-- carries NO amount - the app does not know it, and 0 may never mean unknown.
--
-- FOUR STATEMENTS, ALL ADDITIVE OR WIDENING:
--
--   1. "ManualRefundTask"."partPaymentReviewPaymentId" TEXT, nullable, no
--      default: the booking's Payment id on a part-payment review, NULL on every
--      other row.
--   2. A UNIQUE index on it: one review per payment, whatever its status, so a
--      replayed cancel cannot raise a second. PostgreSQL treats NULLs as
--      distinct, so every existing row (all NULL) passes.
--   3. DROP/ADD "ManualRefundTask_non_edit_review_amount_present" with one more
--      arm: a row carrying the marker may have a NULL amount. STRICTLY WEAKER,
--      and weaker only for rows no existing row can be (the column is new), so
--      every stored row reaches the same verdict and the validating scan cannot
--      fail.
--   4. CHECK "ManualRefundTask_part_payment_review_shape": a marked row is a
--      CANCELLED_BOOKING_HAND_BACK with no amount, no raised amount and no
--      paymentId. With "ManualRefundTask_completed_amount_present" that makes a
--      COMPLETED review unrepresentable - it is closed only by DISMISSED, since
--      nothing in the app moves money for it. Every existing row is NULL in the
--      new column, so the validating scan cannot fail.
--
-- NO NEW ENUM LABEL, AND THAT IS THE COMPATIBILITY ARGUMENT (the one
-- 20261013010000 makes). The review reuses CANCELLED_BOOKING_HAND_BACK, which
-- the previous app version already deserializes. Its hand-back queue lists a row
-- of that kind with no amount (as "Awaiting pricing"), keeps the confirm button
-- of its "mark paid back" dialog disabled for a non-review row with no amount,
-- and its completion door refuses a completion with no amount; so the previous
-- colour can list the review and dismiss it, and cannot close it as money moved.
-- It neither selects nor writes the new column: its inserts omit it (NULL) and
-- its reads never name it.
--
-- WHY "paymentId" IS NULL ON A REVIEW. The previous colour's organisation
-- late-cash arm (the inbound Xero sync, #3369) raises its own sized hand-back
-- unless a CANCELLED_BOOKING_HAND_BACK already exists for the same booking AND
-- payment. Leaving "paymentId" NULL keeps a review from suppressing that sized
-- task on either colour; the payment is named by the marker instead.
--
-- NO DML OF ANY KIND, so every existing row is byte-identical afterwards and the
-- data-migration verification gate classifies this as shape-only. No session
-- clock is needed because there is no payload.
--
-- LOCK IMPACT: ACCESS EXCLUSIVE on "ManualRefundTask" for a catalog-only ADD
-- COLUMN, the unique index build, the constraint DROP and the two validating
-- scans. That table holds one row per hand-settled refund task in the club's
-- history, so milliseconds. No Booking, Payment, Member, capacity, credit or
-- provider row is read or written, so INV-LOCK-001 and INV-LOCK-002 are
-- unaffected.
--
-- IDEMPOTENT: not wholly (ADD COLUMN, CREATE UNIQUE INDEX and the final ADD
-- CONSTRAINT raise on replay); Prisma's migration ledger prevents one. The
-- restated CHECK is DROP ... IF EXISTS then ADD.
--
-- REVERSE: drop the shape CHECK, restore the 20260910010000 predicate, drop the
-- index and the column. Marked rows then read as ordinary hand-backs with no
-- amount, which the restored predicate refuses - so dismiss or delete any OPEN
-- review first. No rollback.sql is required because this is not windowed.

ALTER TABLE "ManualRefundTask" ADD COLUMN "partPaymentReviewPaymentId" TEXT;

CREATE UNIQUE INDEX "ManualRefundTask_partPaymentReviewPaymentId_key"
  ON "ManualRefundTask"("partPaymentReviewPaymentId");

ALTER TABLE "ManualRefundTask"
  DROP CONSTRAINT IF EXISTS "ManualRefundTask_non_edit_review_amount_present";

ALTER TABLE "ManualRefundTask"
  ADD CONSTRAINT "ManualRefundTask_non_edit_review_amount_present" CHECK (
    "kind"::text IS NOT DISTINCT FROM 'EDIT_FINANCIAL_REVIEW'
    OR "kind"::text IS NOT DISTINCT FROM 'UNCOLLECTED_EDIT_REVIEW_SHARE'
    OR "partPaymentReviewPaymentId" IS NOT NULL
    OR "amountCents" IS NOT NULL
  );

ALTER TABLE "ManualRefundTask"
  ADD CONSTRAINT "ManualRefundTask_part_payment_review_shape" CHECK (
    "partPaymentReviewPaymentId" IS NULL
    OR (
      "kind" = 'CANCELLED_BOOKING_HAND_BACK'
      AND "amountCents" IS NULL
      AND "raisedAmountCents" IS NULL
      AND "paymentId" IS NULL
    )
  );
