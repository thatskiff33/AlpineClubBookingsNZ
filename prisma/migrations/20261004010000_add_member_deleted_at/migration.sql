BEGIN;

-- #3541: give approved self-service account deletion a structural timestamp.
--
-- EXPAND ONLY: one nullable column with no default and no data rewrite. Existing
-- rows remain byte-identical apart from the table catalogue. The draining old
-- colour does not select or write this field, while the new colour stamps it in
-- the existing anonymisation transaction. No reader consumes it in this stage.
--
-- LOCK IMPACT: ADD COLUMN with no default is catalog-only on PostgreSQL
-- (no table rewrite), taking ACCESS EXCLUSIVE on "Member" for this short
-- DDL-only transaction. No index, constraint, trigger or foreign key is added.
ALTER TABLE "Member"
  ADD COLUMN "deletedAt" TIMESTAMP(3);

COMMIT;
