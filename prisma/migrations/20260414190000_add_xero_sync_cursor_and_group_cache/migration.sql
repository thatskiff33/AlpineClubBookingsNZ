CREATE TABLE "XeroSyncCursor" (
    "id" TEXT NOT NULL,
    "resourceType" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "cursorDateTime" TIMESTAMP(3),
    "lastSuccessfulSyncAt" TIMESTAMP(3),
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "XeroSyncCursor_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "XeroContactGroupCache" (
    "id" TEXT NOT NULL,
    "contactGroupId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "contactCount" INTEGER NOT NULL DEFAULT 0,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sourceUpdatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "XeroContactGroupCache_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "XeroContactGroupMembershipCache" (
    "id" TEXT NOT NULL,
    "contactGroupId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "contactName" TEXT,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "XeroContactGroupMembershipCache_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "XeroSyncCursor_resourceType_scope_key" ON "XeroSyncCursor"("resourceType", "scope");
CREATE INDEX "XeroSyncCursor_resourceType_lastSuccessfulSyncAt_idx" ON "XeroSyncCursor"("resourceType", "lastSuccessfulSyncAt");

CREATE UNIQUE INDEX "XeroContactGroupCache_contactGroupId_key" ON "XeroContactGroupCache"("contactGroupId");
CREATE INDEX "XeroContactGroupCache_name_idx" ON "XeroContactGroupCache"("name");
CREATE INDEX "XeroContactGroupCache_fetchedAt_idx" ON "XeroContactGroupCache"("fetchedAt");

CREATE UNIQUE INDEX "XeroContactGroupMembershipCache_group_contact_key" ON "XeroContactGroupMembershipCache"("contactGroupId", "contactId");
CREATE INDEX "XeroContactGroupMembershipCache_contactGroupId_idx" ON "XeroContactGroupMembershipCache"("contactGroupId");
CREATE INDEX "XeroContactGroupMembershipCache_contactId_idx" ON "XeroContactGroupMembershipCache"("contactId");

ALTER TABLE "XeroContactGroupMembershipCache"
ADD CONSTRAINT "XeroContactGroupMembershipCache_contactGroupId_fkey"
FOREIGN KEY ("contactGroupId")
REFERENCES "XeroContactGroupCache"("contactGroupId")
ON DELETE CASCADE
ON UPDATE CASCADE;
