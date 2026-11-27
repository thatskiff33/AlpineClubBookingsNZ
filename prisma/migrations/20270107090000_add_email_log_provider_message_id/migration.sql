-- #5469 (owner decision D2, 27 Nov 2026): store the id the MAIL SERVER gave
-- each email it accepted, so a bounce or complaint report, which names the
-- message by that id, finds the one email it is about.
--
-- Blue/green EXPAND migration (see docs/BLUE_GREEN_MIGRATION_SAFETY.tsv): adds
-- one nullable column to EmailLog. Nothing is dropped, renamed, retyped,
-- backfilled or indexed; the lookup index is the next migration, in its own
-- file, so this file's ACCESS EXCLUSIVE lock is not held through a build.

-- AlterTable: nullable, no default, so PostgreSQL records catalog metadata only
-- and rewrites no heap. Every existing row reads NULL, which is right: nothing
-- before this release stored the id. The previous release's Prisma client
-- names its columns explicitly, so it neither reads nor writes this one.
ALTER TABLE "EmailLog" ADD COLUMN "providerMessageId" TEXT;
