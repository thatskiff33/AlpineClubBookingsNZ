-- Persist bed allocation mode so admins can choose auto-allocation or admin-only allocation.

CREATE TABLE IF NOT EXISTS "BedAllocationSettings" (
  "id" TEXT NOT NULL DEFAULT 'default',
  "autoAllocationEnabled" BOOLEAN NOT NULL DEFAULT true,
  "updatedByMemberId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BedAllocationSettings_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "BedAllocationSettings_updatedByMemberId_idx"
  ON "BedAllocationSettings"("updatedByMemberId");

INSERT INTO "BedAllocationSettings" ("id")
VALUES ('default')
ON CONFLICT ("id") DO NOTHING;
