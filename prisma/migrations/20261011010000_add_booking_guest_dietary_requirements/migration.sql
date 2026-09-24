-- Booking-guest dietary/allergy snapshot (#3029, stage 2 of epic #3021;
-- INV-PRIV-022, INV-MOD-059).
--
-- PURELY ADDITIVE EXPAND. One new nullable column, nothing renamed, retyped,
-- dropped or repurposed. See docs/BLUE_GREEN_MIGRATION_SAFETY.tsv for the
-- blue/green analysis, including the drain-window limit.
--
-- NOT DATA-REWRITING: there is no DML at all - no INSERT, no UPDATE, no DELETE,
-- no data-modifying CTE, no DO block. The column is nullable with no default,
-- so every existing BookingGuest row reads NULL. Nothing is backfilled: a
-- booking value is seeded only when a guest row is first created, never by a
-- migration.
--
-- NO SESSION CLOCK IN A PAYLOAD: there is no payload.

-- AlterTable
ALTER TABLE "BookingGuest" ADD COLUMN "dietaryRequirements" VARCHAR(500);
