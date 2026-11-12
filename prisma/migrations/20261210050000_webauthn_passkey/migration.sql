-- #4617: additive. Two new tables only the new code reads and writes; the
-- deployed client never names them, and twoFactorEnabled is unchanged.
CREATE TYPE "WebAuthnChallengePurpose" AS ENUM ('registration', 'authentication');

CREATE TABLE "WebAuthnCredential" (
    "id" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "credentialId" TEXT NOT NULL,
    "publicKey" BYTEA NOT NULL,
    "counter" INTEGER NOT NULL DEFAULT 0,
    "transports" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "name" TEXT NOT NULL DEFAULT 'Passkey',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3),

    CONSTRAINT "WebAuthnCredential_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "WebAuthnChallenge" (
    "id" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "challenge" TEXT NOT NULL,
    "purpose" "WebAuthnChallengePurpose" NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebAuthnChallenge_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "WebAuthnCredential_credentialId_key" ON "WebAuthnCredential"("credentialId");

CREATE INDEX "WebAuthnCredential_memberId_idx" ON "WebAuthnCredential"("memberId");

CREATE UNIQUE INDEX "WebAuthnChallenge_challenge_key" ON "WebAuthnChallenge"("challenge");

CREATE INDEX "WebAuthnChallenge_memberId_idx" ON "WebAuthnChallenge"("memberId");

CREATE INDEX "WebAuthnChallenge_expiresAt_idx" ON "WebAuthnChallenge"("expiresAt");

ALTER TABLE "WebAuthnCredential" ADD CONSTRAINT "WebAuthnCredential_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "WebAuthnChallenge" ADD CONSTRAINT "WebAuthnChallenge_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE CASCADE ON UPDATE CASCADE;
