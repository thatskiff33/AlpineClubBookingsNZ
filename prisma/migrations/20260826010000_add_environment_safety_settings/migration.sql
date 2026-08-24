-- The installation's environment-safety override (ENV-SAFETY 1, #3034; epic #2986).
--
-- PURELY ADDITIVE EXPAND. One brand-new empty table and one index on it. Nothing
-- is renamed, retyped, dropped or repurposed, no existing table is touched, and
-- no existing row's values are rewritten. The deployed OLD code reads nothing
-- here and is completely unaffected, which is what makes this readable by the
-- draining colour during a blue/green cutover. See
-- docs/BLUE_GREEN_MIGRATION_SAFETY.tsv for the analysis.
--
-- NOT DATA-REWRITING: there is no DML at all — no INSERT, no UPDATE, no DELETE,
-- no data-modifying CTE, no DO block — so no verification fixture is required
-- (scripts/check-data-migration-verification.sh).
--
-- THE SHAPE IS THE SAFETY GUARANTEE (INV-CONFIG-003). There is deliberately no
-- column that can assert production. `forceNonProduction` is the only lever and
-- it only ever moves the resolved role towards the safer NON_PRODUCTION state;
-- production is declared by the deployment environment (APP_ENVIRONMENT_ROLE)
-- and by nothing that lives in this database. A restored production dump
-- therefore cannot carry "I am production" into a staging copy, because there is
-- no column in which that claim could travel.
--
-- THE ROW IS DELIBERATELY NOT SEEDED. Absent means "no override", which is the
-- same answer as forceNonProduction = false, so nothing has to be inserted for
-- the resolver to work and no read path ever has to create a row. An INSERT here
-- would also be the wrong shape for the safer-only rule: seeding `false` would
-- write a row asserting "no override wanted" onto an installation nobody has
-- asked yet.

-- CreateTable
CREATE TABLE "EnvironmentSafetySettings" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "forceNonProduction" BOOLEAN NOT NULL DEFAULT false,
    "updatedByMemberId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EnvironmentSafetySettings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EnvironmentSafetySettings_updatedByMemberId_idx" ON "EnvironmentSafetySettings"("updatedByMemberId");
