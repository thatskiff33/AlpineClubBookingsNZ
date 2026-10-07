-- Member dietary/allergy profile field and its feature toggle (#2941, stage 1
-- of epic #3021; INV-PRIV-022).
--
-- PURELY ADDITIVE EXPAND. Two new columns, nothing renamed, retyped, dropped or
-- repurposed. See docs/BLUE_GREEN_MIGRATION_SAFETY.tsv for the blue/green
-- analysis.
--
-- NOT DATA-REWRITING: there is no DML at all - no INSERT, no UPDATE, no DELETE,
-- no data-modifying CTE, no DO block. "dietaryRequirements" is nullable with no
-- default, so every existing Member row reads NULL. "showDietaryRequirements"
-- carries a constant DDL default of false, which Postgres records in the catalog
-- without rewriting the table; an existing settings row therefore reads false,
-- which is the feature's required default (OFF).
--
-- NO SESSION CLOCK IN A PAYLOAD: there is no payload.
--
-- The explicit BEGIN/COMMIT envelope keeps both catalog changes in one short
-- DDL-only transaction, so a failure of the second rolls back the first.

BEGIN;

-- AlterTable
ALTER TABLE "Member" ADD COLUMN "dietaryRequirements" VARCHAR(500);

-- AlterTable
ALTER TABLE "MemberFieldsSettings" ADD COLUMN "showDietaryRequirements" BOOLEAN NOT NULL DEFAULT false;

COMMIT;
