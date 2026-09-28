-- #3643 (owner decision 28 Sep 2026, on the issue's DECISION RECORD comment).
-- INV-PAY-107 and INV-PAY-108.
--
-- An officer may cancel an internet banking booking as unpaid while Xero records
-- a payment against its invoice that the app cannot hand back as credit: the
-- booking belongs to an organisation, or Xero could not give the amount exactly
-- (the thread's ORCHESTRATOR DECISION 2). The owner asked for that cancel to
-- raise a task in the hand-back queue, so the Xero repair tool's manual-review
-- finding for the booking goes quiet once a treasurer has closed it. The task
-- carries NO amount to hand back - the club settles that money in Xero, and 0
-- may never mean unknown.
--
-- EIGHT STATEMENTS, ALL ADDITIVE, WIDENING, OR A NULL-SAFE RESTATEMENT:
--
--   1. "ManualRefundTask"."partPaymentReviewPaymentId" TEXT, nullable, no
--      default: the booking's Payment id on a part-payment review, NULL on every
--      other row.
--   2. "ManualRefundTask"."partPaymentReviewXeroPaidAt" TIMESTAMP(3) and
--      "partPaymentReviewXeroPaidCents" INTEGER, nullable, no default: on a
--      review only, when the inbound Xero sync learned the booking's invoice
--      was reported PAID, and the invoice's cash in cents at that read. While a
--      review exists, that sync credits and hands back NOTHING for the invoice
--      (ORCHESTRATOR DECISION 3 on #3643, INV-PAY-108); it writes these two
--      columns once, in its own transaction, and reopens a dismissed review, so
--      the treasurer's task - not a best-effort email - carries the fact.
--      Neither is an amount to hand back.
--   3. A UNIQUE index on the marker: one review per payment, whatever its
--      status, so a replayed cancel cannot raise a second. PostgreSQL treats
--      NULLs as distinct, so every existing row (all NULL) passes.
--   4. DROP/ADD "ManualRefundTask_non_edit_review_amount_present" with one more
--      arm: a row carrying the marker may have a NULL amount. STRICTLY WEAKER,
--      and weaker only for rows no existing row can be (the column is new), so
--      every stored row reaches the same verdict and the validating scan cannot
--      fail.
--   5. CHECK "ManualRefundTask_part_payment_review_shape": a marked row is a
--      CANCELLED_BOOKING_HAND_BACK with no amount, no raised amount and no
--      paymentId; only a marked row may carry the Xero-paid pair, the pair is
--      set together, and its cents are not negative. The kind test is spelled IS NOT DISTINCT FROM, as
--      20260903010000 and 20260910010000 spell theirs: "kind" is nullable, a
--      plain "=" is NULL for a NULL kind, and a CHECK accepts NULL. With
--      "ManualRefundTask_completed_amount_present" it makes a COMPLETED review
--      unrepresentable - a review is closed only by DISMISSED, since nothing in
--      the app moves money for it. THIS CHECK IS ALSO THE OVERLAP FENCE against
--      a direct API completion on the previous colour (below), so it must not be
--      "simplified" away. Every existing row is NULL in all three new columns,
--      so the validating scan cannot fail.
--   6-7. DROP/ADD #3639's "ManualRefundTask_late_capture_approval_kind"
--      (20261013010000), restated null-safe: its "kind" = '...' had the same
--      three-valued hole, so a marked row with a NULL kind passed it. That
--      migration is not edited in place, because an environment may already
--      have applied it; restating the CHECK here costs nothing more, since this
--      migration already needs the deploy override for statement 4. Only a
--      DELETED_BOOKING_LATE_CAPTURE row carries that marker on either colour,
--      so the validating scan cannot fail.
--
-- NO NEW ENUM LABEL, AND THAT IS THE COMPATIBILITY ARGUMENT (the one
-- 20261013010000 makes). The review reuses CANCELLED_BOOKING_HAND_BACK, which
-- the previous app version already deserializes. Its hand-back queue lists a row
-- of that kind with no amount (as "Awaiting pricing") and keeps the confirm
-- button of its "mark paid back" dialog disabled for a non-review row with no
-- amount, so its UI can list and dismiss the review but not close it as money
-- moved. Its completion door is NOT the fence: posted directly with a
-- confirmedAmountCents, it takes its final branch and writes that amount, and
-- the shape CHECK (statement 5) refuses the write - the transaction rolls back
-- before any money moves and the officer sees a generic error. The previous
-- colour neither selects nor writes the new columns: its inserts omit them
-- (NULL) and its reads never name them.
--
-- WHY "paymentId" IS NULL ON A REVIEW. The organisation late-cash arm of the
-- inbound Xero sync (#3369) dedupes its own sized hand-back on (booking,
-- payment, kind). The new colour's arm finds the review by its marker instead
-- and raises nothing while one exists, noting the event on the review. The
-- previous colour's arm cannot see the review, so during the overlap it may raise a
-- hand-back for the whole cash beside it, exactly as it does today; a
-- "paymentId" on the review would not make that safer, only silence it.
--
-- NO DML OF ANY KIND, so every existing row is byte-identical afterwards and the
-- data-migration verification gate classifies this as shape-only. No session
-- clock is needed because there is no payload.
--
-- DEPLOY: the two DROP CONSTRAINTs make the blue/green guard classify this
-- migration as breaking, so the release carrying it runs with
-- ALLOW_BREAKING_BLUE_GREEN_MIGRATIONS=1 and a reason. That override silences
-- the breaking warning for EVERY pending migration in the same run, so the
-- operator checks that each found_breaking line names a reviewed "yes" row in
-- docs/BLUE_GREEN_MIGRATION_SAFETY.tsv. PostgreSQL cannot widen a CHECK in
-- place, so there is no shape without the DROP.
--
-- LOCK IMPACT: ACCESS EXCLUSIVE on "ManualRefundTask" for three catalog-only ADD
-- COLUMNs, the unique index build, the two constraint DROPs and the three
-- validating scans. That table holds one row per hand-settled refund task in
-- the club's history, so milliseconds. No Booking, Payment, Member, capacity,
-- credit or provider row is read or written, so INV-LOCK-001 and INV-LOCK-002
-- are unaffected.
--
-- IDEMPOTENT: not wholly (ADD COLUMN, CREATE UNIQUE INDEX and the new ADD
-- CONSTRAINT raise on replay); Prisma's migration ledger prevents one. The
-- restated CHECKs are DROP ... IF EXISTS then ADD.
--
-- ROLLBACK. Routing traffic back to the previous colour needs NO schema
-- reverse: it never names the new columns, and every CHECK here accepts what
-- it writes. A schema reverse, only if one is ever wanted, runs in this order:
--   1. Drop "ManualRefundTask_part_payment_review_shape".
--   2. Drop "ManualRefundTask_non_edit_review_amount_present" and re-add the
--      20260910010000 predicate NOT VALID. A CHECK ignores status, so every
--      review row, OPEN or DISMISSED, fails the old predicate; NOT VALID
--      enforces it for new writes and keeps those rows. Never delete a review
--      row: it is the treasurer's record of money settled by hand.
--   3. Leave the null-safe "ManualRefundTask_late_capture_approval_kind" in
--      place: it is 20261013010000's rule, stricter only for a NULL kind.
--   4. Drop the unique index, then the three columns.
-- No rollback.sql is required because this is not windowed.

ALTER TABLE "ManualRefundTask" ADD COLUMN "partPaymentReviewPaymentId" TEXT;

ALTER TABLE "ManualRefundTask" ADD COLUMN "partPaymentReviewXeroPaidAt" TIMESTAMP(3);

ALTER TABLE "ManualRefundTask" ADD COLUMN "partPaymentReviewXeroPaidCents" INTEGER;

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
    (
      "partPaymentReviewPaymentId" IS NULL
      AND "partPaymentReviewXeroPaidAt" IS NULL
      AND "partPaymentReviewXeroPaidCents" IS NULL
    )
    OR (
      "partPaymentReviewPaymentId" IS NOT NULL
      AND "kind"::text IS NOT DISTINCT FROM 'CANCELLED_BOOKING_HAND_BACK'
      AND "amountCents" IS NULL
      AND "raisedAmountCents" IS NULL
      AND "paymentId" IS NULL
      AND ("partPaymentReviewXeroPaidAt" IS NULL) = ("partPaymentReviewXeroPaidCents" IS NULL)
      AND (
        "partPaymentReviewXeroPaidCents" IS NULL
        OR "partPaymentReviewXeroPaidCents" >= 0
      )
    )
  );

ALTER TABLE "ManualRefundTask"
  DROP CONSTRAINT IF EXISTS "ManualRefundTask_late_capture_approval_kind";

ALTER TABLE "ManualRefundTask"
  ADD CONSTRAINT "ManualRefundTask_late_capture_approval_kind" CHECK (
    "lateCaptureApprovalIntentId" IS NULL
    OR "kind"::text IS NOT DISTINCT FROM 'DELETED_BOOKING_LATE_CAPTURE'
  );
