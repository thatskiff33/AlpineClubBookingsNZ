-- Durable proof that a Xero contact's stored email has been contained on this
-- installation (ENV-SAFETY 3, #3036; epic #2986; INV-CONFIG-005).
--
-- PURELY ADDITIVE EXPAND. Two statements: one brand-new empty table, and the
-- unique index Prisma generates for its `@unique` column. Nothing is renamed,
-- retyped, dropped or repurposed; no existing table is read, altered or locked;
-- no existing row's values are rewritten. The deployed OLD code has no reference
-- to this table, so the draining blue/green colour neither reads nor writes it
-- and cannot be affected between migrate and cutover. See
-- docs/BLUE_GREEN_MIGRATION_SAFETY.tsv for the full analysis.
--
-- NOT DATA-REWRITING: there is no DML at all — no INSERT, no UPDATE, no DELETE,
-- no data-modifying CTE, no DO block — so no verification fixture is required
-- (scripts/check-data-migration-verification.sh).
--
-- NOTHING IS SEEDED, AND THAT IS THE SAFE DIRECTION. An absent row means "this
-- contact has not been proved contained", which is exactly what makes a restored
-- copy contain every contact it is about to invoice. Seeding rows would assert
-- containment nobody has established, which is the one claim this table must
-- never make falsely.
--
-- PRODUCTION LEAVES THIS TABLE EMPTY FOR EVER. Containment runs only on a
-- confirmed NON_PRODUCTION installation, so on the club's live site no row is
-- ever written. The table therefore costs the live site one empty relation.

-- CreateTable
CREATE TABLE "XeroSandboxContactContainment" (
    "id" TEXT NOT NULL,
    "xeroContactId" TEXT NOT NULL,
    "containedEmail" TEXT NOT NULL,
    "rewroteAddress" BOOLEAN NOT NULL,
    "containedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rewrittenAt" TIMESTAMP(3),

    CONSTRAINT "XeroSandboxContactContainment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "XeroSandboxContactContainment_xeroContactId_key" ON "XeroSandboxContactContainment"("xeroContactId");
