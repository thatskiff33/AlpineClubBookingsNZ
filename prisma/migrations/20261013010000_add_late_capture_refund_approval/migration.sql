-- #3639 (owner decision 26 Sep 2026, on the issue's DECISION RECORD comment).
-- INV-PAY-102.
--
-- A genuine late capture on a cancelled booking (money Stripe took AFTER the
-- cancel) has always been refunded automatically by the webhook. The owner asked
-- for a club setting: refund automatically (the default, today's behaviour) or
-- have a treasurer approve the refund. This migration adds the setting and the
-- marker the approve path puts on its finance-queue task.
--
-- FOUR STATEMENTS, ALL ADDITIVE:
--
--   1. "BookingDefaults"."lateCaptureRefundNeedsApproval" BOOLEAN NOT NULL
--      DEFAULT false. A single-row club settings table; false is today's
--      behaviour, so every existing club reads "refund automatically" without
--      any write.
--   2. "ManualRefundTask"."lateCaptureApprovalIntentId" TEXT, nullable, no
--      default: the late capture's Stripe payment intent on a task held for a
--      treasurer, NULL on every other row.
--   3. A UNIQUE index on it: one approval task per capture. PostgreSQL treats
--      NULLs as distinct, so the index constrains only the rows that carry the
--      marker and every existing row (all NULL) passes.
--   4. CHECK "ManualRefundTask_late_capture_approval_kind": only a
--      DELETED_BOOKING_LATE_CAPTURE row may carry the marker. Every existing row
--      is NULL there, so the validating scan cannot fail.
--
-- NO NEW ENUM LABEL, AND THAT IS THE COMPATIBILITY ARGUMENT. The approval task
-- reuses the DELETED_BOOKING_LATE_CAPTURE kind (#2700), which the previous app
-- version already reads and renders as an open late-capture question. Unlike
-- 20260910010000, whose new label the previous colour cannot deserialize, a row
-- the new colour writes here is one the previous colour can list, count and
-- close, during the blue/green overlap and after a rollback alike. The previous
-- colour neither selects nor writes the new column: its inserts omit it (NULL)
-- and its reads never name it.
--
-- NO DML OF ANY KIND, so every existing row is byte-identical afterwards and the
-- data-migration verification gate classifies this as shape-only. No session
-- clock is needed because there is no payload.
--
-- LOCK IMPACT: ACCESS EXCLUSIVE on the one-row "BookingDefaults" and on
-- "ManualRefundTask" for two catalog-only ADD COLUMNs; the unique index build and
-- the CHECK's validating scan hold a lock on "ManualRefundTask" (one row per
-- hand-settled refund task in the club's history, so milliseconds). No Booking,
-- Payment, Member, capacity, credit or provider row is read or written, so
-- INV-LOCK-001 and INV-LOCK-002 are unaffected.

ALTER TABLE "BookingDefaults"
  ADD COLUMN "lateCaptureRefundNeedsApproval" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "ManualRefundTask" ADD COLUMN "lateCaptureApprovalIntentId" TEXT;

CREATE UNIQUE INDEX "ManualRefundTask_lateCaptureApprovalIntentId_key"
  ON "ManualRefundTask"("lateCaptureApprovalIntentId");

ALTER TABLE "ManualRefundTask"
  ADD CONSTRAINT "ManualRefundTask_late_capture_approval_kind" CHECK (
    "lateCaptureApprovalIntentId" IS NULL
    OR "kind" = 'DELETED_BOOKING_LATE_CAPTURE'
  );
