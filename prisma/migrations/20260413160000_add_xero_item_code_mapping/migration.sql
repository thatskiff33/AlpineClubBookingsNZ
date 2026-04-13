-- CreateEnum
CREATE TYPE "EntranceFeeCategory" AS ENUM ('ADULT', 'YOUTH', 'CHILD', 'FAMILY');

-- CreateTable
CREATE TABLE "XeroItemCodeMapping" (
    "id" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "ageTier" "AgeTier",
    "seasonType" "SeasonType",
    "isMember" BOOLEAN,
    "entranceFeeCategory" "EntranceFeeCategory",
    "itemCode" TEXT NOT NULL,
    "amountCents" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "XeroItemCodeMapping_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "XeroItemCodeMapping_category_idx" ON "XeroItemCodeMapping"("category");

-- CreateUniqueIndex (hut fee lookups)
CREATE UNIQUE INDEX "XeroItemCodeMapping_category_ageTier_seasonType_isMember_key" ON "XeroItemCodeMapping"("category", "ageTier", "seasonType", "isMember");

-- CreateUniqueIndex (entrance fee lookups)
CREATE UNIQUE INDEX "XeroItemCodeMapping_category_entranceFeeCategory_key" ON "XeroItemCodeMapping"("category", "entranceFeeCategory");
