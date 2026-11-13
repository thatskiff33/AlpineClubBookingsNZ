CREATE TABLE "PrivacyHostingSettings" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "hostingProvider" VARCHAR(120),
    "dataLocation" VARCHAR(120),
    "updatedByMemberId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PrivacyHostingSettings_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PrivacyHostingSettings_updatedByMemberId_idx" ON "PrivacyHostingSettings"("updatedByMemberId");
