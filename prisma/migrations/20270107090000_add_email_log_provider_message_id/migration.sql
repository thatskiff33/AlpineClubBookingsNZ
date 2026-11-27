-- #5469 (owner decision D2, 27 Nov 2026): store the id the MAIL SERVER gave
-- each email it accepted, so a bounce or complaint report, which names the
-- message by that id, finds the one email it is about.
--
-- Blue/green EXPAND migration (see docs/BLUE_GREEN_MIGRATION_SAFETY.tsv):
--  * adds one nullable column to EmailLog,
--  * adds one btree index on it.
-- Nothing is dropped, renamed, retyped or backfilled.

-- AlterTable: nullable, no default, so PostgreSQL records catalog metadata only
-- and rewrites no heap. Every existing row reads NULL, which is right: nothing
-- before this release stored the id. The previous release's Prisma client
-- names its columns explicitly, so it neither reads nor writes this one.
ALTER TABLE "EmailLog" ADD COLUMN "providerMessageId" TEXT;

-- The feedback handler's lookup. EmailLog is not on the deploy guard's
-- hot-table list; the same plain (non-concurrent) build as
-- "EmailLog_bookingId_createdAt_idx" in 20260727120000.
CREATE INDEX "EmailLog_providerMessageId_idx" ON "EmailLog"("providerMessageId");
