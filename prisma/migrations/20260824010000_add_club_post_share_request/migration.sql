-- Communication Portal federation (epic #2992): the "share this post" request,
-- kept separately from the fact of it having been shared.
--
-- EXPAND PHASE. Two nullable ADD COLUMNs on "ClubPost", which is not a hot
-- table. Nothing is dropped, renamed or retyped and no row is rewritten, so
-- every existing post is byte-identical afterwards.
--
-- WHY TWO COLUMNS AND NOT ONE: "sharedAt" already records that the central
-- server took a post. It cannot also mean "the member asked for it to go",
-- because the interesting state is exactly the gap between the two -- asked
-- for, not yet accepted -- which is what the retry pass looks for. Collapsing
-- them would make a failed share indistinguishable from one never requested,
-- and the post would sit local forever with nobody able to tell why.
ALTER TABLE "ClubPost" ADD COLUMN "shareRequestedAt" TIMESTAMP(3);
ALTER TABLE "ClubPost" ADD COLUMN "shareError" VARCHAR(300);

-- The retry pass asks for "requested, not yet shared". A PARTIAL index would
-- suit that better, but Prisma cannot express one, and an index that exists
-- only in raw SQL reads as drift to `prisma migrate diff` -- the drift check
-- would fail every build. A plain index on the request timestamp is declared
-- in the schema, so migrations and schema agree, and it is selective enough:
-- the column is null for every post nobody asked to share, which is nearly all
-- of them, and PostgreSQL does not index nulls in a btree.
CREATE INDEX "ClubPost_shareRequestedAt_idx" ON "ClubPost"("shareRequestedAt");
