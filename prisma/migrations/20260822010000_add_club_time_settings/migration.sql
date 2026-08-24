-- The installation's one club timezone (CT-1, #2989; epic #2988).
--
-- PURELY ADDITIVE EXPAND. One brand-new empty table and one index on it. Nothing
-- is renamed, retyped, dropped or repurposed, no existing table is touched, and
-- no existing row's values are rewritten. See docs/BLUE_GREEN_MIGRATION_SAFETY.tsv
-- for the blue/green analysis.
--
-- NOT DATA-REWRITING: there is no DML at all — no INSERT, no UPDATE, no DELETE,
-- no data-modifying CTE, no DO block. A verification fixture ships anyway
-- (prisma/migration-verification/20260822010000_add_club_time_settings.ts),
-- because the SHAPE of this table is load-bearing: `timeZone` being NOT NULL is
-- what stops a row existing with no configured zone, and the id default being
-- exactly 'default' is what makes the app's `where: { id: "default" }` read find
-- the row at all.
--
-- NO SESSION CLOCK IN A PAYLOAD: there is no payload. `createdAt`/`updatedAt`
-- come from the columns' own DDL defaults, which the #1627 gate explicitly
-- permits.
--
-- THE ROW IS DELIBERATELY NOT SEEDED HERE. An existing deployment's current
-- effective timezone comes from its own `TZ` / `NEXT_PUBLIC_TZ` environment, and
-- SQL cannot read a process environment. Inserting 'Pacific/Auckland' here would
-- silently reassign the civil time of every club that runs on any other zone, so
-- the backfill is done at boot instead, by the create-if-absent
-- `clubTimeZoneSelfHealStep` in src/lib/config-self-heal.ts, from the value that
-- deployment is effectively using right now. Until that runs — and for any
-- install whose row is absent for any other reason — the canonical reader falls
-- back to the same environment value, so behaviour is unchanged either way.

-- CreateTable
CREATE TABLE "ClubTimeSettings" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "timeZone" VARCHAR(64) NOT NULL,
    "updatedByMemberId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClubTimeSettings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ClubTimeSettings_updatedByMemberId_idx" ON "ClubTimeSettings"("updatedByMemberId");
