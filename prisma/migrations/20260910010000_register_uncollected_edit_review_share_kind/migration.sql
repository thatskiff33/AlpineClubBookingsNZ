-- #3213 (epic #2797). INV-PAY-051.
--
-- A settled review share that could NOT be added to its edit's Xero invoice --
-- because that invoice had been picked up for sending and could no longer be
-- raised -- becomes an item on the finance queue an officer closes by hand.
-- Owner decision, 4 Sep 2026: nothing is billed automatically, because a
-- mid-send job can still come back to the queue and be raised to the full
-- amount, so a second invoice raised now could bill the same money twice.
--
-- Until this release the fact was recorded only as an audit line
-- (booking.editFinancialReview.chargeShareUncollected, secondAsk 'withheld').
-- Audit rows here are append-only and are not a work queue, so nothing carried a
-- status a person could close -- and "an officer closed this" is a fact that
-- exists only because somebody did it, so it has to be stored.
--
-- THIS IS THE EXPAND HALF OF A TWO-RELEASE SEQUENCE, and the halves must not be
-- shipped together (docs/BLUE_GREEN_MIGRATION_POLICY.md -> "Required Sequence").
--
--   * THIS RELEASE registers the label, relaxes one CHECK so the label will be
--     usable, and NOTHING WRITES IT.
--     src/lib/__tests__/uncollected-edit-review-share-expand.test.ts fails the
--     build if any writer starts producing the value early.
--   * THE FOLLOWING RELEASE starts writing it (the runtime half).
--
-- WHY THE WAIT IS REAL AND NOT PAPERWORK, concretely. A production deploy runs
-- migrations BEFORE the new colour takes traffic, while the previous colour is
-- still serving (docs/PRODUCTION_UPGRADE_RUNBOOK.md step 17/20 is the cutover;
-- the new colour AND the `app` cron leader are warmed before it). That colour's
-- generated Prisma client knows "ManualRefundTaskKind" with four labels and
-- cannot deserialize a fifth. The finance queue's own loader selects this column
-- over EVERY OPEN row --
-- src/app/api/admin/payments/manual-refund-tasks/route.ts, select { kind: true }
-- on status OPEN -- so a single row carrying the new label during that window
-- would not degrade one card: it would fail the whole "money to settle by hand"
-- queue, including real hand-backs the club owes members. The completion door
-- (src/lib/manual-refund-task-resolution.ts) selects it too.
--
-- The same argument, on a lower-stakes surface, is why 20260909010000 split its
-- halves. Here one of the two writers is the payment-recovery drain, which the
-- cron leader runs -- so "the new code is not serving yet" is not a defence.
--
-- Registering the label breaks none of those reads: a client that never meets a
-- value of it is unaffected by its existence.
--
-- ================= 1. THE LABEL =================
--
-- Additive. ALTER TYPE ... ADD VALUE is deliberately not matched by
-- BREAKING_SQL_REGEX, unlike RENAME VALUE.
--
-- IDEMPOTENT: IF NOT EXISTS, so a replay is a no-op rather than a 42710.
-- IRREVERSIBLE BY DESIGN: PostgreSQL cannot remove an enum label, so the value
-- stays registered after a rollback. That is harmless while nothing writes it,
-- which is exactly the property this release preserves.
ALTER TYPE "ManualRefundTaskKind" ADD VALUE IF NOT EXISTS 'UNCOLLECTED_EDIT_REVIEW_SHARE';

-- ================= 2. AN AMOUNT IS NOT ALWAYS KNOWABLE =================
--
-- 20260903010000 added "ManualRefundTask_non_edit_review_amount_present": every
-- kind EXCEPT 'EDIT_FINANCIAL_REVIEW' must carry an amount, because those
-- amounts come from cancellation or capture policy and an operator closing the
-- task does not get to reprice them.
--
-- The new kind needs the same exemption, and for a reason that is about money
-- rather than convenience. There are two writers of a withheld share and only
-- one of them knows the figure:
--
--   * the settlement leg (src/lib/edit-financial-review-xero-leg.ts) holds THIS
--     task's own settled share, and that is the uncollected amount;
--   * the payment-recovery replay (src/lib/payment-recovery.ts) passes both the
--     review-task id and the share as NULL BY DESIGN. It re-derives the edit's
--     COMBINED total across every share and cannot say which part of it the sent
--     invoice already carries.
--
-- So on the replay's rows the uncollected amount is genuinely unknown. Forcing a
-- number there would mean storing the settled TOTAL in the money column of an
-- item whose sentence tells an officer to bill what is missing -- and an officer
-- who bills the total bills the member a second time for money already asked
-- for, which is the exact hazard #3193 and this issue exist to avoid. NULL says
-- "not knowable" and the card says so in words; 0 may never be used to mean it,
-- exactly as on 'EDIT_FINANCIAL_REVIEW'.
--
-- NOTE THE THREE-VALUED LOGIC, unchanged from 20260903010000 and still the whole
-- point of the spelling: written with <> or NOT IN, a row with kind IS NULL
-- evaluates to NULL, and a CHECK accepts anything that is not FALSE -- so
-- precisely the pre-#2797 shape would be exempt. IS NOT DISTINCT FROM is
-- null-safe. src/lib/__tests__/manual-refund-task-constraints.test.ts offers
-- Postgres a bad row of each shape and reads back the constraint name.
--
-- ::text ON THE COLUMN, DELIBERATELY. PostgreSQL refuses to USE a new enum label
-- in the same transaction that added it, and Prisma runs each migration in one.
-- Comparing the column as text never mentions the enum type, so statement 1 and
-- statement 3 can share a transaction.
--
-- NO ROW CAN VIOLATE THE NEW PREDICATE, so the validating scan cannot fail: it
-- is strictly WEAKER than the one it replaces, and weaker only for a label no
-- row can yet carry.
--
-- LOCK IMPACT: ACCESS EXCLUSIVE on "ManualRefundTask" for the DROP and for the
-- ADD's validating scan. That table holds one row per hand-settled refund task
-- in the club's history -- tens, not millions -- so the scan is milliseconds. No
-- Booking, Payment, Member, capacity, credit or provider record is read or
-- written, there is no DML of any kind, and this migration composes no
-- application writer, so INV-LOCK-001 and INV-LOCK-002 are unaffected.
--
-- IDEMPOTENT: DROP ... IF EXISTS then ADD, so a replay restates the same
-- predicate rather than failing 42710.
ALTER TABLE "ManualRefundTask"
  DROP CONSTRAINT IF EXISTS "ManualRefundTask_non_edit_review_amount_present";

ALTER TABLE "ManualRefundTask"
  ADD CONSTRAINT "ManualRefundTask_non_edit_review_amount_present" CHECK (
    "kind"::text IS NOT DISTINCT FROM 'EDIT_FINANCIAL_REVIEW'
    OR "kind"::text IS NOT DISTINCT FROM 'UNCOLLECTED_EDIT_REVIEW_SHARE'
    OR "amountCents" IS NOT NULL
  );

-- ================= 3. ONE ITEM PER WITHHELD SHARE =================
--
-- The duplicate fence on this table is @@unique("occurrenceKey"), and PostgreSQL
-- EXEMPTS NULL from a unique index -- so a row that leaves the key unset does not
-- collide with anything, including another row that also left it unset. A writer
-- that forgot the key would therefore raise a second item for the same withheld
-- share on every replay, silently, and the officer would be told twice to check
-- the same booking and could bill it twice.
--
-- 20260903010000 made that unrepresentable for 'EDIT_FINANCIAL_REVIEW' and only
-- for it, because it was the only kind then minting a key. The new kind mints one
-- too -- its writer arrives next release -- so it needs the same fence, and NOW is
-- the only moment the fence is free: no row can carry the label yet, so the
-- validating scan is provably trivial and can refuse nothing. Added after the
-- writer ships, the same constraint would have to be NOT VALID and would leave
-- exactly the rows it exists to police outside it.
--
-- STRICTLY STRONGER, AND ONLY FOR A LABEL NO ROW CAN CARRY. Every existing row
-- lands the same way as under the predicate this replaces:
--   * kind = 'EDIT_FINANCIAL_REVIEW'          -> still requires a key;
--   * any other non-null kind                 -> still exempt;
--   * kind IS NULL (rows predating the column) -> still exempt. The original
--     spelling reached that by three-valued logic (`<>` on NULL yields NULL, and
--     a CHECK accepts anything that is not FALSE); IS DISTINCT FROM reaches it by
--     answering TRUE. Same verdict on every stored row, and the null-safe form is
--     the one that stays right when a fourth arm is added.
--
-- ::text ON THE COLUMN for the reason statement 2 gives: PostgreSQL refuses to
-- USE a label in the transaction that added it, and Prisma runs one per
-- migration.
--
-- IDEMPOTENT: DROP ... IF EXISTS then ADD, so a replay restates the predicate.
--
-- LOCK IMPACT: the same ACCESS EXCLUSIVE window on "ManualRefundTask" already
-- taken by statement 2, on a table of tens of rows. No DML, no other table.
ALTER TABLE "ManualRefundTask"
  DROP CONSTRAINT IF EXISTS "ManualRefundTask_edit_review_occurrence_key_present";

ALTER TABLE "ManualRefundTask"
  ADD CONSTRAINT "ManualRefundTask_edit_review_occurrence_key_present" CHECK (
    (
      "kind"::text IS DISTINCT FROM 'EDIT_FINANCIAL_REVIEW'
      AND "kind"::text IS DISTINCT FROM 'UNCOLLECTED_EDIT_REVIEW_SHARE'
    )
    OR "occurrenceKey" IS NOT NULL
  );
