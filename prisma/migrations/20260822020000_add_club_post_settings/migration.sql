
-- CreateTable
CREATE TABLE "ClubPostSettings" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "retentionDays" INTEGER NOT NULL DEFAULT 0,
    "cleanupStartedAt" TIMESTAMP(3),
    "lastCleanupAt" TIMESTAMP(3),
    "lastCleanupDeleted" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedByMemberId" TEXT,

    CONSTRAINT "ClubPostSettings_pkey" PRIMARY KEY ("id")
);

