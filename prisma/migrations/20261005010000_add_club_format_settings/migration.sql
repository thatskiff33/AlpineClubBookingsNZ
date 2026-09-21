-- The installation's one currency and locale (stage 1 of programme #3205,
-- #3563; INV-CONFIG-006).
--
-- PURELY ADDITIVE EXPAND. One brand-new empty table and one index on it. Nothing
-- is renamed, retyped, dropped or repurposed, no existing table is touched, and
-- no existing row's values are rewritten. See docs/BLUE_GREEN_MIGRATION_SAFETY.tsv
-- for the blue/green analysis.
--
-- NOT DATA-REWRITING: there is no DML at all — no INSERT, no UPDATE, no DELETE,
-- no data-modifying CTE, no DO block. No verification fixture ships, following
-- 20260826010000_add_environment_safety_settings: the shape assertions a fixture
-- would make are the ones Prisma's own migration-drift check already makes
-- against schema.prisma, and there is no pre-state for a fixture to have an
-- opinion about.
--
-- NO SESSION CLOCK IN A PAYLOAD: there is no payload. `createdAt`/`updatedAt`
-- come from the columns' own DDL defaults, which the #1627 gate explicitly
-- permits.
--
-- THE ROW IS DELIBERATELY NOT SEEDED HERE, and this is the trap the club-time
-- migration recorded in words that transfer exactly. An existing deployment's
-- current effective currency and locale come from its own CURRENCY / LOCALE
-- (or NEXT_PUBLIC_*) environment, and SQL cannot read a process environment.
-- Inserting 'NZD' and 'en-NZ' here would silently re-denominate and re-format
-- every club running on anything else, with no error anywhere. The backfill is
-- done at boot instead, by the create-if-absent `clubFormatSelfHealStep` in
-- src/lib/config-self-heal.ts, from the values that deployment is effectively
-- using right now. Until that runs — and for any install whose row is absent
-- for any other reason — the canonical reader falls back to the same
-- environment values, so behaviour is unchanged either way.

-- CreateTable
CREATE TABLE "ClubFormatSettings" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "currencyCode" VARCHAR(3) NOT NULL,
    "locale" VARCHAR(64) NOT NULL,
    "updatedByMemberId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClubFormatSettings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ClubFormatSettings_updatedByMemberId_idx" ON "ClubFormatSettings"("updatedByMemberId");
