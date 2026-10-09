-- #49: pause Alpine Central Server syncing when the server's API version
-- differs from the one this site was built for.
--
-- PURELY ADDITIVE EXPAND. Two new nullable columns on the "ServerNzSettings"
-- singleton (the server's last reported version and when it was asked) and one
-- constant-defaulted preference column on "NotificationPreference" (the Daily
-- digest's "central server version" entry, offered to Lodge Operations editors).
-- Nothing is renamed, retyped, dropped or repurposed, and no existing row's
-- values are rewritten. See docs/BLUE_GREEN_MIGRATION_SAFETY.tsv.
--
-- NOT DATA-REWRITING: no DML at all. The settings row reads NULL for both new
-- columns, and NULL is the truthful value: "the server has not been asked yet",
-- which is the state of every deployment before its first check. The mismatch
-- itself is never stored - it is computed from the stored version and the
-- site's own constant on every read. The preference column takes the catalogue
-- default of true, the same as every other admin alert preference.
--
-- OLD-CODE COMPATIBLE: the draining colour's generated client knows none of the
-- three columns and never selects or writes them, so its reads are unaffected,
-- its upserts of the settings row leave the two nullable columns NULL, and its
-- inserts of a preference row receive the default.
--
-- LOCK IMPACT: ADD COLUMN with no default, or with a constant default, is
-- catalog-only on PostgreSQL 11 and later (no table rewrite), taking ACCESS
-- EXCLUSIVE on each table for the catalogue change alone. "ServerNzSettings"
-- holds one row; "NotificationPreference" holds one row per member who saved a
-- preference and is not a hot table.

-- AlterTable
ALTER TABLE "ServerNzSettings"
  ADD COLUMN "serverVersion" VARCHAR(16),
  ADD COLUMN "serverVersionCheckedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "NotificationPreference"
  ADD COLUMN "adminServerVersion" BOOLEAN NOT NULL DEFAULT true;
