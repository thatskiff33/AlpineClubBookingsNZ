-- #4616 (INV-AUTH-008): additive, expand-only. A new, empty table only the new
-- code reads and writes: the single-use step-up challenge the jwt callback
-- consumes before it refreshes a session's lastAuthenticatedAt. The draining
-- release never names the table or the model. No existing row or column
-- changes; the foreign key only validates against the empty new table.

-- CreateTable
CREATE TABLE "SessionReauthChallenge" (
    "id" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SessionReauthChallenge_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SessionReauthChallenge_tokenHash_key" ON "SessionReauthChallenge"("tokenHash");

-- CreateIndex
CREATE INDEX "SessionReauthChallenge_memberId_idx" ON "SessionReauthChallenge"("memberId");

-- CreateIndex
CREATE INDEX "SessionReauthChallenge_expiresAt_idx" ON "SessionReauthChallenge"("expiresAt");

-- AddForeignKey
ALTER TABLE "SessionReauthChallenge" ADD CONSTRAINT "SessionReauthChallenge_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE CASCADE ON UPDATE CASCADE;
