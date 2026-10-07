-- #3580 (programme #3527 stage 4, child C1) — the booking money ledger's table.
--
-- ONE STATEMENT GROUP, ALL ADDITIVE: four new enum types, one new table, its
-- indexes, its three foreign keys and four CHECK constraints. Nothing existing
-- is altered, and no row anywhere is written or read by this migration.
--
-- PHASE: expand. OLD_CODE_COMPATIBLE: yes, in the strongest sense available —
-- the draining colour has never heard of this table, and nothing in the new
-- colour reads it either (C1 posts lines; the first reader is C5, #3584). A
-- table only one colour writes cannot break the other.
--
-- LOCK IMPACT: CREATE TYPE locks only the new types. CREATE TABLE locks only
-- the new table. The three foreign keys take a SHARE ROW EXCLUSIVE on the
-- referenced tables (Booking, Lodge, and this table itself) for the duration
-- of each constraint's creation only, and validate against an empty table, so
-- they scan nothing. BookingGuest and Member are NOT touched: the strand and
-- acting-member columns carry no key, for the reason stated beside them. The
-- whole migration is DDL on an empty table and runs in the ordinary window.
--
-- REVERSE: drop the table, then the four types. Nothing else is touched and no
-- data can be lost, because this migration creates the only rows that would
-- have been in it. `rollback.sql` beside this file is that, verbatim.
--
-- IDEMPOTENCY: not idempotent; Prisma's own ledger prevents replay.

-- CreateEnum
CREATE TYPE "LedgerSide" AS ENUM ('CHARGE', 'SETTLEMENT', 'ADJUSTMENT');

-- CreateEnum
CREATE TYPE "LedgerLineKind" AS ENUM ('GUEST_NIGHT', 'CHANGE_FEE', 'PROMOTION', 'GROUP_DISCOUNT', 'CARD_CAPTURE', 'BANK_RECEIPT', 'CREDIT_APPLIED', 'CASH_RECORDED', 'CARD_REFUND', 'BANK_REFUND', 'CREDIT_ISSUED', 'AGREED_ADJUSTMENT');

-- CreateEnum
CREATE TYPE "LedgerAnchorKind" AS ENUM ('CONFIRMATION', 'MODIFICATION', 'REVIEW_TASK', 'PAYMENT_TRANSACTION', 'PAYMENT_REFUND', 'MEMBER_CREDIT', 'CANCELLATION');

-- CreateEnum
CREATE TYPE "SettlementMethod" AS ENUM ('CARD', 'INTERNET_BANKING', 'ACCOUNT_CREDIT', 'CASH');

-- CreateTable
CREATE TABLE "BookingLedgerLine" (
    "id" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "side" "LedgerSide" NOT NULL,
    "kind" "LedgerLineKind" NOT NULL,
    "sign" INTEGER NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unitCents" INTEGER NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "bookingGuestId" TEXT,
    "nightStart" DATE,
    "nightEndExclusive" DATE,
    "rateMembershipTypeId" TEXT,
    "ageTier" "AgeTier",
    "guestNames" TEXT[],
    "anchorKind" "LedgerAnchorKind" NOT NULL,
    "anchorId" TEXT NOT NULL,
    "settlementMethod" "SettlementMethod",
    "reversesLineId" TEXT,
    "postedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "postedByMemberId" TEXT,
    "narration" TEXT NOT NULL,
    "lodgeId" TEXT NOT NULL DEFAULT default_lodge_id(),

    CONSTRAINT "BookingLedgerLine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BookingLedgerLine_reversesLineId_key" ON "BookingLedgerLine"("reversesLineId");

-- CreateIndex
CREATE INDEX "BookingLedgerLine_bookingId_postedAt_idx" ON "BookingLedgerLine"("bookingId", "postedAt");

-- CreateIndex
CREATE INDEX "BookingLedgerLine_anchorKind_anchorId_idx" ON "BookingLedgerLine"("anchorKind", "anchorId");

-- CreateIndex
CREATE INDEX "BookingLedgerLine_bookingGuestId_idx" ON "BookingLedgerLine"("bookingGuestId");

-- CreateIndex
CREATE INDEX "BookingLedgerLine_postedByMemberId_idx" ON "BookingLedgerLine"("postedByMemberId");

-- CreateIndex
CREATE INDEX "BookingLedgerLine_lodgeId_idx" ON "BookingLedgerLine"("lodgeId");

-- AddForeignKey
ALTER TABLE "BookingLedgerLine" ADD CONSTRAINT "BookingLedgerLine_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- `bookingGuestId` and `postedByMemberId` carry NO foreign key, exactly as
-- `AuditLog.actorMemberId` does: an append-only record names a row as DATA,
-- not as a live reference. A key would bring `SET NULL` with it, and a cascade
-- that blanked a posted line is the one mutation this table does not allow —
-- arriving through the database rather than through code, where the census
-- cannot see it. It would also have to be re-pointed when two members merge.

-- AddForeignKey
ALTER TABLE "BookingLedgerLine" ADD CONSTRAINT "BookingLedgerLine_reversesLineId_fkey" FOREIGN KEY ("reversesLineId") REFERENCES "BookingLedgerLine"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingLedgerLine" ADD CONSTRAINT "BookingLedgerLine_lodgeId_fkey" FOREIGN KEY ("lodgeId") REFERENCES "Lodge"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- THE THREE RULES THE DATABASE ITSELF HOLDS (#3580).
--
-- Prefer unrepresentable over policed: these are the shape rules a writer must
-- never be able to get wrong, so they are constraints rather than a lint arm
-- or a code review. A caller that computes an amount its own way, or posts a
-- charge line for nobody, is refused by Postgres.
--
-- 1. A sign is a direction, never a magnitude and never nothing.
ALTER TABLE "BookingLedgerLine" ADD CONSTRAINT "BookingLedgerLine_sign_is_a_direction" CHECK ("sign" IN (1, -1));

-- 2. The amount IS the arithmetic. There is no second way to compute a line's
--    figure, so a rounding or a sign mistake cannot be stored (INV-MONEY-001).
ALTER TABLE "BookingLedgerLine" ADD CONSTRAINT "BookingLedgerLine_amount_is_derived" CHECK ("amountCents" = "sign" * "unitCents" * "quantity" AND "unitCents" >= 0 AND "quantity" >= 0);

-- 3. A guest-night line names the strand AND the nights it prices; nothing
--    else names any of the three. Two constraints rather than one, because
--    one equality left a gap: a settlement line carrying a strand id and no
--    night fields satisfied `(kind = 'GUEST_NIGHT') = (all three present)`
--    while still claiming a strand it has no business naming (review of
--    #3580). The money a settlement moves belongs to the booking, not to one
--    guest, and so does a change fee, a promotion or a group discount.
ALTER TABLE "BookingLedgerLine" ADD CONSTRAINT "BookingLedgerLine_guest_nights_name_their_strand" CHECK (("kind" = 'GUEST_NIGHT') = ("bookingGuestId" IS NOT NULL AND "nightStart" IS NOT NULL AND "nightEndExclusive" IS NOT NULL));

ALTER TABLE "BookingLedgerLine" ADD CONSTRAINT "BookingLedgerLine_only_guest_nights_name_a_strand" CHECK ("kind" = 'GUEST_NIGHT' OR ("bookingGuestId" IS NULL AND "nightStart" IS NULL AND "nightEndExclusive" IS NULL));
