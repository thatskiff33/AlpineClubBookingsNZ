-- #4514 (Ledger M2): financial history outlives its booking (#4482, owner
-- decision D1, 28 Oct 2026: RESTRICT on the financial relationships; a booking
-- with money is archived or soft-deleted, never hard-deleted).
--
-- A referential action runs with the rights of the referencing table's OWNER,
-- so `BookingLedgerLine.bookingId ON DELETE CASCADE` let an application role
-- that may only INSERT and SELECT ledger lines (#4453) delete them by deleting
-- their booking. Every key a ledger line holds, and the three booking links a
-- member-credit row holds (insert-only, INV-MONEY-035), now refuse instead:
-- ON DELETE RESTRICT ON UPDATE RESTRICT. The member-money journal's keys
-- (20261127010000) already are.
--
-- PostgreSQL cannot change a foreign key's action in place, so each is dropped
-- and re-added inside this one transaction: there is no moment without the key,
-- and a failure rolls every key back. Every existing row already satisfied the
-- same key, so re-adding it cannot fail.
--
-- Dropping a foreign key takes ACCESS EXCLUSIVE on BOTH its tables (measured on
-- PostgreSQL 16), so the transaction takes all five up front, parents first —
-- the order the booking writers take them in (a booking row, then its ledger
-- lines or credit rows) — so a writer mid-way through cannot hold a parent the
-- migration then waits for. They are held until COMMIT, through the re-added
-- keys' validation scans of "BookingLedgerLine" and "MemberCredit".
--
-- OLD CODE: its only booking hard deletes are DRAFT bookings (booking-delete.ts,
-- the draft-cleanup cron), and a DRAFT carries no ledger line or credit row, so
-- neither colour meets the refusal. No row changes: this is shape-only.
BEGIN;

LOCK TABLE "Booking", "Lodge", "BookingModification", "MemberCredit", "BookingLedgerLine" IN ACCESS EXCLUSIVE MODE;

ALTER TABLE "BookingLedgerLine" DROP CONSTRAINT "BookingLedgerLine_bookingId_fkey";
ALTER TABLE "BookingLedgerLine" DROP CONSTRAINT "BookingLedgerLine_lodgeId_fkey";
ALTER TABLE "BookingLedgerLine" DROP CONSTRAINT "BookingLedgerLine_reversesLineId_fkey";
ALTER TABLE "MemberCredit" DROP CONSTRAINT "MemberCredit_sourceBookingId_fkey";
ALTER TABLE "MemberCredit" DROP CONSTRAINT "MemberCredit_appliedToBookingId_fkey";
ALTER TABLE "MemberCredit" DROP CONSTRAINT "MemberCredit_sourceBookingModificationId_fkey";

ALTER TABLE "BookingLedgerLine" ADD CONSTRAINT "BookingLedgerLine_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "BookingLedgerLine" ADD CONSTRAINT "BookingLedgerLine_lodgeId_fkey" FOREIGN KEY ("lodgeId") REFERENCES "Lodge"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "BookingLedgerLine" ADD CONSTRAINT "BookingLedgerLine_reversesLineId_fkey" FOREIGN KEY ("reversesLineId") REFERENCES "BookingLedgerLine"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "MemberCredit" ADD CONSTRAINT "MemberCredit_sourceBookingId_fkey" FOREIGN KEY ("sourceBookingId") REFERENCES "Booking"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "MemberCredit" ADD CONSTRAINT "MemberCredit_appliedToBookingId_fkey" FOREIGN KEY ("appliedToBookingId") REFERENCES "Booking"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "MemberCredit" ADD CONSTRAINT "MemberCredit_sourceBookingModificationId_fkey" FOREIGN KEY ("sourceBookingModificationId") REFERENCES "BookingModification"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

COMMIT;
