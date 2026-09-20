BEGIN;

-- #3530 stage 2a (programme #3527): the signed lines that make up a booking
-- edit's price delta - per guest category x rate x unit price x nights, plus
-- one promotion delta - computed at edit time from the before and after night
-- sets and stored on the modification row they belong to.
--
-- Until now every path from an edit to a document collapsed to
-- {priceDiffCents, changeFeeCents} before anything rendered, so a treasurer
-- reading "$80" had to believe it and a member asking why got a number. The
-- lines are NARRATION: `priceDiffCents` stays the figure every settlement
-- decision reads, idempotency keys stay amount-derived, and no reader in this
-- release changes a Xero document (2b does, with a fallback to today's single
-- line when the stored lines do not sum to what is billed).
--
-- NULL is a first-class value: "this edit has no itemisation" - a parked edit
-- (INV-MOD-028), a strand whose stored night prices are not exact, a credit
-- election, a price rebase, or any row written before this column existed.
-- Never an empty array standing in for it.
--
-- EXPAND ONLY, one nullable JSON column, no DML, no default: NULL is the
-- truthful value for every stored row, because no line has ever been
-- computed. A draining old colour omits the column on INSERT and never reads
-- it; a new-colour reader treats its NULL exactly as a legacy row.
--
-- LOCK IMPACT: ADD COLUMN with no default is catalog-only on PostgreSQL (no
-- table rewrite), taking ACCESS EXCLUSIVE on "BookingModification" for the
-- catalog change alone, inside this short DDL-only transaction. No index,
-- constraint, trigger or foreign key is added.
ALTER TABLE "BookingModification"
  ADD COLUMN "priceLines" JSONB;

COMMIT;
