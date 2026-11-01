-- #69: two Other lodges may share a name; the central server's id is what
-- makes them distinct (owner decision, 15 Oct 2026). The partial unique index
-- on visible names (#58) is replaced by a plain index, kept for the download's
-- and the committee sync's lookups by name.
--
-- One index swap. NO DML.
--
-- OLD-CODE COMPATIBLE: the draining colour speaks central server API 2.4, so
-- against a 2.5 server its sync is paused and it neither uploads nor
-- downloads. Its other writers (an administrator's edit, Hide) never rely on
-- the index; a rename onto a taken name simply succeeds instead of answering
-- 409. The new colour no longer reads "ServerNzSettings"."otherLodgesOwnedNames"
-- but leaves it as last written, so the draining colour's owned-lodge answer
-- (its edit route and committee booking-officer sync) stays as it was.
--
-- LOCK IMPACT: brief ACCESS EXCLUSIVE locks on "OtherLodge", a small admin
-- registry, not a hot table; the new index builds over its few hundred rows.

-- A lodge name is no longer unique, among visible lodges or any.
DROP INDEX "OtherLodge_name_visible_key";
CREATE INDEX "OtherLodge_name_idx" ON "OtherLodge"("name");
