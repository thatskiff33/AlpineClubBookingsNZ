-- ALP-653 (INV-MCP): AI app connections. A member approves an AI app (an MCP
-- client) to act as them through /api/mcp.
--
-- EXPAND, OLD-CODE COMPATIBLE. One defaulted column on the ClubModuleSettings
-- singleton, three new enums and five new empty tables. NO DML and no backfill.
--
-- Every read of ClubModuleSettings narrows to CLUB_MODULE_SETTINGS_COLUMN_SELECT,
-- so the draining release never names "mcpServer", and its upsert leaves the
-- column at its default of false: the feature stays off until an administrator
-- switches it on. The draining release never names the new tables or enums.
--
-- The one foreign key onto an existing table is McpGrant -> Member with ON
-- DELETE CASCADE, so a member merge or erasure run by either release removes
-- that member's connections with the member row rather than being refused.
--
-- McpSettings is a singleton that is never seeded here: a missing row reads as
-- the column defaults (members may connect, officers may not, view only, and
-- the three approved hosts claude.ai, claude.com and chatgpt.com).
--
-- Safe to run twice in a row: ADD COLUMN IF NOT EXISTS is a no-op the second
-- time. The CREATE statements are not repeatable; Prisma's _prisma_migrations
-- ledger is what stops a replay.

-- CreateEnum
CREATE TYPE "McpGrantScope" AS ENUM ('READ', 'READ_WRITE');

-- CreateEnum
CREATE TYPE "McpGrantStatus" AS ENUM ('ACTIVE', 'REVOKED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "McpTokenKind" AS ENUM ('ACCESS', 'REFRESH');

-- AlterTable
ALTER TABLE "ClubModuleSettings" ADD COLUMN IF NOT EXISTS "mcpServer" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "McpClient" (
    "id" TEXT NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "redirectUris" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "McpClient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "McpGrant" (
    "id" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "scope" "McpGrantScope" NOT NULL DEFAULT 'READ',
    "status" "McpGrantStatus" NOT NULL DEFAULT 'ACTIVE',
    "sessionIssuedAt" TIMESTAMP(3) NOT NULL,
    "twoFactorVerified" BOOLEAN NOT NULL DEFAULT false,
    "endedReason" VARCHAR(40),
    "endedAt" TIMESTAMP(3),
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "McpGrant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "McpAuthCode" (
    "id" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "grantId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "redirectUri" TEXT NOT NULL,
    "codeChallenge" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "McpAuthCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "McpToken" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "kind" "McpTokenKind" NOT NULL,
    "grantId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "McpToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "McpSettings" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "membersMayConnect" BOOLEAN NOT NULL DEFAULT true,
    "officersMayConnect" BOOLEAN NOT NULL DEFAULT false,
    "maxScope" "McpGrantScope" NOT NULL DEFAULT 'READ',
    "allowedRedirectHosts" TEXT[] DEFAULT ARRAY['claude.ai', 'claude.com', 'chatgpt.com']::TEXT[],
    "updatedByMemberId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "McpSettings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "McpClient_createdAt_idx" ON "McpClient"("createdAt");

-- CreateIndex
CREATE INDEX "McpGrant_memberId_status_idx" ON "McpGrant"("memberId", "status");

-- CreateIndex
CREATE INDEX "McpGrant_clientId_idx" ON "McpGrant"("clientId");

-- CreateIndex
CREATE INDEX "McpGrant_status_createdAt_idx" ON "McpGrant"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "McpAuthCode_codeHash_key" ON "McpAuthCode"("codeHash");

-- CreateIndex
CREATE INDEX "McpAuthCode_grantId_idx" ON "McpAuthCode"("grantId");

-- CreateIndex
CREATE INDEX "McpAuthCode_clientId_idx" ON "McpAuthCode"("clientId");

-- CreateIndex
CREATE INDEX "McpAuthCode_expiresAt_idx" ON "McpAuthCode"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "McpToken_tokenHash_key" ON "McpToken"("tokenHash");

-- CreateIndex
CREATE INDEX "McpToken_grantId_idx" ON "McpToken"("grantId");

-- CreateIndex
CREATE INDEX "McpToken_expiresAt_idx" ON "McpToken"("expiresAt");

-- CreateIndex
CREATE INDEX "McpSettings_updatedByMemberId_idx" ON "McpSettings"("updatedByMemberId");

-- AddForeignKey
ALTER TABLE "McpGrant" ADD CONSTRAINT "McpGrant_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "McpGrant" ADD CONSTRAINT "McpGrant_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "McpClient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "McpAuthCode" ADD CONSTRAINT "McpAuthCode_grantId_fkey" FOREIGN KEY ("grantId") REFERENCES "McpGrant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "McpAuthCode" ADD CONSTRAINT "McpAuthCode_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "McpClient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "McpToken" ADD CONSTRAINT "McpToken_grantId_fkey" FOREIGN KEY ("grantId") REFERENCES "McpGrant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

