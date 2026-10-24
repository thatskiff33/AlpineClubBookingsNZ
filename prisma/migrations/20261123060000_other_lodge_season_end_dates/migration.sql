-- #75: each Other lodge season gets an END date, its last day (owner,
-- 16 Oct 2026; central server API 2.6). Seasons recur: only day and month
-- count. Unset, a season runs up to the other season's start, as before.
--
-- Two nullable DATE columns with no default. NO DML.
--
-- OLD-CODE COMPATIBLE: the draining colour never names these columns; its
-- inserts and updates leave them NULL, which reads as "no end date yet".
--
-- LOCK IMPACT: a brief ACCESS EXCLUSIVE lock on "OtherLodge", a small admin
-- registry, not a hot table; adding nullable columns rewrites nothing.

-- AlterTable
ALTER TABLE "OtherLodge" ADD COLUMN "winterSeasonEnd" DATE,
ADD COLUMN "summerSeasonEnd" DATE;
