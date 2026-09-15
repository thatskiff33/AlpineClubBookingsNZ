-- #2940: the NON-SECRET half of the club's MiroTalk video-meeting configuration,
-- moved out of the environment and into Admin -> Integrations. The JWT key and
-- the MiroTalk host username/password are NOT here — they go into the existing
-- encrypted "IntegrationCredential" table under provider 'mirotalk'.
--
-- EXPAND ONLY: one brand-new, cold, one-row settings table with no foreign key
-- and no seed row. Every column is nullable, which is the environment-fallback
-- contract rather than laxness: a null column means "the club has not set this
-- in the database", and src/lib/mirotalk-config.ts then reads the existing
-- MIROTALK_URL / MIRO_* environment variable exactly as it did before this
-- migration. Nothing copies an environment value into this table, so an
-- environment-only install behaves identically on deploy and after it, with no
-- row here at all.

-- CreateTable
CREATE TABLE "MirotalkSettings" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "baseUrl" VARCHAR(500),
    "presenterEnabled" BOOLEAN,
    "tokenLifetime" VARCHAR(16),
    "updatedByMemberId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MirotalkSettings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MirotalkSettings_updatedByMemberId_idx" ON "MirotalkSettings"("updatedByMemberId");
