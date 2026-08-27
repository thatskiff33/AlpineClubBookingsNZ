-- Communication Portal federation (epic #2992): the mirror-sync cursor and its
-- single-flight claim.
--
-- EXPAND PHASE. Four nullable ADD COLUMNs on "ServerNzSettings", a singleton
-- table holding at most one row. Nothing is dropped, renamed or retyped, no
-- row is rewritten, and null is the meaningful initial state: a cursor that
-- has never synced asks the server for a full sync, which sends visible posts
-- and no tombstone backlog.
ALTER TABLE "ServerNzSettings" ADD COLUMN "commsCursorSince" VARCHAR(64);
ALTER TABLE "ServerNzSettings" ADD COLUMN "commsCursorSinceId" VARCHAR(64);
ALTER TABLE "ServerNzSettings" ADD COLUMN "commsSyncStartedAt" TIMESTAMP(3);
ALTER TABLE "ServerNzSettings" ADD COLUMN "commsLastSyncAt" TIMESTAMP(3);
