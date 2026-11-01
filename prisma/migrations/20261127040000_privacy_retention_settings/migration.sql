-- Additive: the deployed client ignores this new, lazily populated singleton.
CREATE TABLE "PrivacyRetentionSettings" (
  "id" TEXT NOT NULL DEFAULT 'default',
  "emailLogRetentionYears" INTEGER NOT NULL DEFAULT 2,
  "rejectedApplicationRetentionYears" INTEGER NOT NULL DEFAULT 1,
  "formerMemberRetentionYears" INTEGER NOT NULL DEFAULT 7,
  "pruneLogsAndApplicationsEnabled" BOOLEAN NOT NULL DEFAULT false,
  "anonymiseMembersEnabled" BOOLEAN NOT NULL DEFAULT false,
  "sentryReplayEnabled" BOOLEAN NOT NULL DEFAULT false,
  "pruneStartedAt" TIMESTAMP(3),
  "anonymiseStartedAt" TIMESTAMP(3),
  "updatedByMemberId" TEXT,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PrivacyRetentionSettings_pkey" PRIMARY KEY ("id")
);
