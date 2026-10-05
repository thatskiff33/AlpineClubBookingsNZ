-- #52: the lodge names the Alpine Central Server says this club owns, and when
-- that list was last received.
--
-- PURELY ADDITIVE EXPAND. Two new nullable columns on the "ServerNzSettings"
-- singleton, no default, no index. Nothing is renamed, retyped, dropped or
-- repurposed, and no existing row's values are rewritten. See
-- docs/BLUE_GREEN_MIGRATION_SAFETY.tsv for the blue/green analysis.
--
-- NOT DATA-REWRITING: no DML at all. The one existing row reads NULL for both,
-- and NULL is the truthful value: "the server has not yet said which lodge is
-- ours", which is exactly the state every deployment is in before its first
-- download from a server that sends the list.
--
-- OLD-CODE COMPATIBLE: the draining colour's generated client knows neither
-- column and never selects or writes them, so its reads are unaffected and its
-- upserts of the settings row leave them NULL.
--
-- LOCK IMPACT: ADD COLUMN with no default is catalog-only (no table rewrite),
-- taking ACCESS EXCLUSIVE on "ServerNzSettings" for the catalogue change alone.
-- The table holds one row and is not a hot table.

-- AlterTable
ALTER TABLE "ServerNzSettings"
  ADD COLUMN "otherLodgesOwnedNames" JSONB,
  ADD COLUMN "otherLodgesOwnedNamesAt" TIMESTAMP(3);
