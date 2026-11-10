-- #4616: additive. A new table only the new code reads and writes; the
-- deployed client never names it.
CREATE TABLE "SessionReauthChallenge" (
    "id" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SessionReauthChallenge_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SessionReauthChallenge_tokenHash_key" ON "SessionReauthChallenge"("tokenHash");

CREATE INDEX "SessionReauthChallenge_memberId_idx" ON "SessionReauthChallenge"("memberId");

CREATE INDEX "SessionReauthChallenge_expiresAt_idx" ON "SessionReauthChallenge"("expiresAt");

ALTER TABLE "SessionReauthChallenge" ADD CONSTRAINT "SessionReauthChallenge_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE CASCADE ON UPDATE CASCADE;
