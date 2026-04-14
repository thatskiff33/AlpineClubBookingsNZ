CREATE TABLE "XeroContactCache" (
    "id" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "name" TEXT,
    "firstName" TEXT,
    "lastName" TEXT,
    "emailAddress" TEXT,
    "companyNumber" TEXT,
    "contactStatus" TEXT NOT NULL DEFAULT 'ACTIVE',
    "phoneCountryCode" TEXT,
    "phoneAreaCode" TEXT,
    "phoneNumber" TEXT,
    "streetAddressLine1" TEXT,
    "streetAddressLine2" TEXT,
    "streetCity" TEXT,
    "streetRegion" TEXT,
    "streetPostalCode" TEXT,
    "streetCountry" TEXT,
    "postalAddressLine1" TEXT,
    "postalAddressLine2" TEXT,
    "postalCity" TEXT,
    "postalRegion" TEXT,
    "postalPostalCode" TEXT,
    "postalCountry" TEXT,
    "sourceUpdatedAt" TIMESTAMP(3),
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "XeroContactCache_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "XeroContactCache_contactId_key" ON "XeroContactCache"("contactId");
CREATE INDEX "XeroContactCache_emailAddress_idx" ON "XeroContactCache"("emailAddress");
CREATE INDEX "XeroContactCache_contactStatus_idx" ON "XeroContactCache"("contactStatus");
CREATE INDEX "XeroContactCache_sourceUpdatedAt_idx" ON "XeroContactCache"("sourceUpdatedAt");
CREATE INDEX "XeroContactCache_fetchedAt_idx" ON "XeroContactCache"("fetchedAt");
