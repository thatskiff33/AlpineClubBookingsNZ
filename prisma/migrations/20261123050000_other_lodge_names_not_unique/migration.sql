-- #69: two Other lodges may share a name; the central server's id is what
-- makes them distinct (owner decision, 15 Oct 2026). The partial unique index
-- on visible names (#58) is replaced by a plain index, kept for the download's
-- and the committee sync's lookups by name.
--
-- One index swap. NO DML.
--
-- WINDOWED: The preceding migration removes full name uniqueness required by old API 2.1; this step also permits duplicate visible names.
-- Stop every old web app and worker and drain other app-database clients before
-- migrating, using the existing deploy gate. Prevent reconnects/restarts until
-- new code is ready. Back up immediately before migration. Reverse in descending
-- order: reconcile duplicate visible names before names_not_unique reversal and
-- ALL duplicate names before hidden_at reversal and restarting old code.
--
-- LOCK IMPACT: brief ACCESS EXCLUSIVE locks on "OtherLodge", a small admin
-- registry, not a hot table; the new index builds over its few hundred rows.

-- A lodge name is no longer unique, among visible lodges or any.
DROP INDEX "OtherLodge_name_visible_key";
CREATE INDEX "OtherLodge_name_idx" ON "OtherLodge"("name");
