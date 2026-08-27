-- #3091 review findings 1, 2 and 5: federation reliability columns.
-- Additive only; constant defaults, so PostgreSQL 11+ records them in
-- pg_attribute without rewriting either table's heap.

-- Finding 5: a real attempt counter, so a permanently failing share stops at
-- the cap instead of retrying forever and starving newer posts.
ALTER TABLE "ClubPost" ADD COLUMN "shareAttempts" INTEGER NOT NULL DEFAULT 0;

-- Finding 1: the central server's confirmation of a takedown. Null with
-- "removedAt" set and "serverPostId" present marks a removal whose network
-- copy may still be live; the withdrawal sweep retries those.
ALTER TABLE "ClubPost" ADD COLUMN "withdrawnAt" TIMESTAMP(3);

-- Finding 2: poison-change tracking for the mirror ingest, so one bad change
-- from the central server is stepped over after three failed passes instead
-- of wedging the sync cursor permanently.
ALTER TABLE "ServerNzSettings" ADD COLUMN "commsPoisonChangeId" VARCHAR(64);
ALTER TABLE "ServerNzSettings" ADD COLUMN "commsPoisonCount" INTEGER NOT NULL DEFAULT 0;
