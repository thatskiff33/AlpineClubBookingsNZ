-- #4514 (Ledger M2): financial history outlives its booking (#4482, owner
-- decision D1, 28 Oct 2026: RESTRICT on the financial relationships; a booking
-- with money is archived or soft-deleted, never hard-deleted).
--
-- A referential action runs with the rights of the referencing table's OWNER,
-- so `BookingLedgerLine.bookingId ON DELETE CASCADE` let an application role
-- that may only INSERT and SELECT ledger lines (#4453) delete them by deleting
-- their booking. These keys now refuse instead, ON DELETE RESTRICT ON UPDATE
-- RESTRICT: every key a ledger line holds; the three booking links a
-- member-credit row holds (insert-only, INV-MONEY-035); and a group
-- settlement's group key, so deleting an organiser's booking no longer takes
-- the organiser's Stripe payment, Xero invoice and amount with it. The
-- member-money journal's keys (20261127010000) already are RESTRICT.
--
-- PostgreSQL cannot change a foreign key's action in place, so each is dropped
-- and re-added inside this one transaction: there is no moment without the key,
-- and a failure rolls every key back. Every existing row already satisfied the
-- same key, so re-adding it cannot fail.
--
-- Dropping a foreign key takes ACCESS EXCLUSIVE on BOTH its tables (measured on
-- PostgreSQL 16), so the transaction takes all seven up front, parents first —
-- the order the booking writers take them in (a booking or group row, then its
-- ledger lines, credit rows or settlement) — so a writer mid-way through cannot
-- hold a parent the migration then waits for. They are held until COMMIT,
-- through the re-added keys' validation scans.
--
-- Also: an index on MemberMoneyObligation.memberId, which member hard delete
-- now counts (journal debtor, INV-MONEY-043). The journal is empty until M3.
-- Its table is locked in the same statement, last, so the index build waits
-- for no lock after the seven are held.
--
-- Each of those eight lock waits is at most one second (SET LOCAL
-- lock_timeout; PostgreSQL bounds each acquisition separately), so in the worst
-- case Booking, taken first, is held about seven seconds before a busy table
-- stops the deploy with nothing applied, rather than queueing Booking traffic
-- behind it.
--
-- OLD CODE: its only booking hard deletes are DRAFT bookings (booking-delete.ts,
-- the draft-cleanup cron); a DRAFT carries no ledger line or credit row, and is
-- never a group organiser (a group opens only on a PAID, CONFIRMED or
-- PAYMENT_PENDING booking, and no status returns to DRAFT). Nothing deletes a
-- GroupBooking or a settlement directly. So neither colour meets the refusal.
-- No row changes: this is shape-only.
BEGIN;

SET LOCAL lock_timeout = '1s';

LOCK TABLE "Booking", "Lodge", "BookingModification", "GroupBooking", "MemberCredit", "BookingLedgerLine", "GroupBookingSettlement", "MemberMoneyObligation" IN ACCESS EXCLUSIVE MODE;

ALTER TABLE "BookingLedgerLine" DROP CONSTRAINT "BookingLedgerLine_bookingId_fkey";
ALTER TABLE "BookingLedgerLine" DROP CONSTRAINT "BookingLedgerLine_lodgeId_fkey";
ALTER TABLE "BookingLedgerLine" DROP CONSTRAINT "BookingLedgerLine_reversesLineId_fkey";
ALTER TABLE "MemberCredit" DROP CONSTRAINT "MemberCredit_sourceBookingId_fkey";
ALTER TABLE "MemberCredit" DROP CONSTRAINT "MemberCredit_appliedToBookingId_fkey";
ALTER TABLE "MemberCredit" DROP CONSTRAINT "MemberCredit_sourceBookingModificationId_fkey";
ALTER TABLE "GroupBookingSettlement" DROP CONSTRAINT "GroupBookingSettlement_groupBookingId_fkey";

ALTER TABLE "BookingLedgerLine" ADD CONSTRAINT "BookingLedgerLine_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "BookingLedgerLine" ADD CONSTRAINT "BookingLedgerLine_lodgeId_fkey" FOREIGN KEY ("lodgeId") REFERENCES "Lodge"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "BookingLedgerLine" ADD CONSTRAINT "BookingLedgerLine_reversesLineId_fkey" FOREIGN KEY ("reversesLineId") REFERENCES "BookingLedgerLine"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "MemberCredit" ADD CONSTRAINT "MemberCredit_sourceBookingId_fkey" FOREIGN KEY ("sourceBookingId") REFERENCES "Booking"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "MemberCredit" ADD CONSTRAINT "MemberCredit_appliedToBookingId_fkey" FOREIGN KEY ("appliedToBookingId") REFERENCES "Booking"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "MemberCredit" ADD CONSTRAINT "MemberCredit_sourceBookingModificationId_fkey" FOREIGN KEY ("sourceBookingModificationId") REFERENCES "BookingModification"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "GroupBookingSettlement" ADD CONSTRAINT "GroupBookingSettlement_groupBookingId_fkey" FOREIGN KEY ("groupBookingId") REFERENCES "GroupBooking"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE INDEX "MemberMoneyObligation_memberId_idx" ON "MemberMoneyObligation"("memberId");

COMMIT;
