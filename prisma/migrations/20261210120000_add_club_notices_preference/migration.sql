-- #4987: a member's "Club notices" preference - club-business bulk email from
-- Communications and emailed Notices, which members receive unless they turn
-- it off (INV-PRIV-023). Newsletters keep the opt-in "marketingEmails" column,
-- whose default this migration does not touch.
--
-- PURELY ADDITIVE EXPAND. One constant-defaulted column; nothing renamed,
-- retyped, dropped or repurposed. See docs/BLUE_GREEN_MIGRATION_SAFETY.tsv.
--
-- NOT DATA-REWRITING: no DML at all. Every existing row reads the constant
-- default true, which is the owner-decided default for club notices; there is
-- no backfill of rows for members who have none.
--
-- OLD-CODE COMPATIBLE: the draining colour's generated client never names the
-- column, so its reads are unaffected and its preference inserts receive the
-- default.
--
-- LOCK IMPACT: ADD COLUMN with a constant default is catalog-only on
-- PostgreSQL 11 and later (no table rewrite). "NotificationPreference" is not a
-- hot table.

-- AlterTable
ALTER TABLE "NotificationPreference"
  ADD COLUMN "clubNotices" BOOLEAN NOT NULL DEFAULT true;
