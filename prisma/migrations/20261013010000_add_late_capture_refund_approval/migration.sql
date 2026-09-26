-- #3639 (owner decision 26 Sep 2026, on the issue's DECISION RECORD comment).
-- INV-PAY-102.
--
-- A genuine late capture on a cancelled booking (money Stripe took AFTER the
-- cancel) has always been refunded automatically by the webhook. The owner asked
-- for a club setting: refund automatically (the default, today's behaviour) or
-- have a treasurer approve the refund. This migration adds the setting and the
-- finance-queue item type the approve path raises.
--
-- THREE STATEMENTS, ALL ADDITIVE OR RESTATING A CHECK FOR A LABEL NO ROW CAN
-- CARRY YET:
--
--   1. "BookingDefaults"."lateCaptureRefundNeedsApproval" BOOLEAN NOT NULL
--      DEFAULT false. A single-row club settings table; false is today's
--      behaviour, so every existing club reads "refund automatically" without
--      any write.
--   2. ALTER TYPE "ManualRefundTaskKind" ADD VALUE 'LATE_CAPTURE_REFUND_APPROVAL'.
--   3. DROP/ADD "ManualRefundTask_edit_review_occurrence_key_present" so the new
--      label may NOT carry a null occurrence key. That is the duplicate fence:
--      the @@unique index on "occurrenceKey" exempts NULL, so a writer that
--      omitted the key could raise a second approval item for one capture and a
--      treasurer could be asked to refund it twice. Added now, while no row can
--      carry the label, so the validating scan is provably trivial. The label is
--      compared as text (as 20260910010000 does), so the new value is not USED
--      in the transaction that adds it.
--
-- OLD-COLOUR COMPATIBLE, AND WHY THE LABEL NEED NOT WAIT A RELEASE the way
-- 20260910010000's did. The previous colour's Prisma client cannot deserialize a
-- label it does not know, and the finance queue selects "kind" over every OPEN
-- row. 20260910010000 split its label from its writer because one writer was the
-- payment-recovery drain, which the cron leader runs before cutover. This label
-- has ONE writer, the late-capture webhook handler, and it writes only for a club
-- whose "lateCaptureRefundNeedsApproval" is true. Statement 1 makes it false for
-- every club, and only the new colour's admin screen can change it - which takes
-- no traffic until cutover. So no row carries the label while the previous colour
-- serves. The ledger row states the rollback caveat.
--
-- NO DML OF ANY KIND, so every existing row is byte-identical afterwards and the
-- data-migration verification gate classifies this as shape-only. No session
-- clock is needed because there is no payload.
--
-- LOCK IMPACT: ACCESS EXCLUSIVE on the one-row "BookingDefaults" for a
-- catalog-only ADD COLUMN; a brief lock on the TYPE; ACCESS EXCLUSIVE on
-- "ManualRefundTask" for the constraint DROP and the ADD's validating scan (one
-- row per hand-settled refund task in the club's history, so milliseconds). No
-- Booking, Payment, Member, capacity, credit or provider row is read or written,
-- so INV-LOCK-001 and INV-LOCK-002 are unaffected.

ALTER TABLE "BookingDefaults"
  ADD COLUMN "lateCaptureRefundNeedsApproval" BOOLEAN NOT NULL DEFAULT false;

ALTER TYPE "ManualRefundTaskKind" ADD VALUE IF NOT EXISTS 'LATE_CAPTURE_REFUND_APPROVAL';

ALTER TABLE "ManualRefundTask"
  DROP CONSTRAINT IF EXISTS "ManualRefundTask_edit_review_occurrence_key_present";
ALTER TABLE "ManualRefundTask"
  ADD CONSTRAINT "ManualRefundTask_edit_review_occurrence_key_present" CHECK (
    (
      "kind"::text IS DISTINCT FROM 'EDIT_FINANCIAL_REVIEW'
      AND "kind"::text IS DISTINCT FROM 'UNCOLLECTED_EDIT_REVIEW_SHARE'
      AND "kind"::text IS DISTINCT FROM 'LATE_CAPTURE_REFUND_APPROVAL'
    )
    OR "occurrenceKey" IS NOT NULL
  );
