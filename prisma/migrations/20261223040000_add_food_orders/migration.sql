-- Fork #121: food orders. Expand-only and additive: two new enums, one
-- defaulted module column on the ClubModuleSettings singleton, and three new
-- empty tables. The deployed client never names any of them (module reads
-- narrow to CLUB_MODULE_SETTINGS_COLUMN_SELECT), so it runs unchanged. No DML.
-- Food orders have never been deployed to a shared or production database, so
-- this one migration creates the final schema (item-by-item receipt, a unit per
-- line and decimal quantities included) rather than a chain of changes.

-- CreateEnum
CREATE TYPE "FoodOrderStatus" AS ENUM ('OPEN', 'RECEIVED');

-- CreateEnum
CREATE TYPE "FoodOrderUnit" AS ENUM ('ITEMS', 'GRAMS', 'KILOGRAMS', 'LITERS', 'LOAVES', 'PACKETS', 'BOTTLES', 'CANS', 'BAGS', 'BOXES', 'PUNNETS', 'MILLILITERS');

-- AlterTable
ALTER TABLE "ClubModuleSettings" ADD COLUMN     "foodOrders" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "FoodOrderSettings" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "officerEmail" VARCHAR(254),
    "officerLabel" VARCHAR(60) NOT NULL DEFAULT 'Food officer',
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedByMemberId" TEXT,

    CONSTRAINT "FoodOrderSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FoodOrder" (
    "id" TEXT NOT NULL,
    "lodgeId" TEXT NOT NULL,
    "memberId" TEXT,
    "neededBy" DATE NOT NULL,
    "notes" VARCHAR(1000),
    "status" "FoodOrderStatus" NOT NULL DEFAULT 'OPEN',
    "receivedAt" TIMESTAMP(3),
    "receivedById" TEXT,
    "priceCents" INTEGER,
    "priceUpdatedAt" TIMESTAMP(3),
    "priceUpdatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FoodOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FoodOrderItem" (
    "id" TEXT NOT NULL,
    "foodOrderId" TEXT NOT NULL,
    "description" VARCHAR(200) NOT NULL,
    "quantity" DECIMAL(7,2) NOT NULL,
    "unit" "FoodOrderUnit" NOT NULL DEFAULT 'ITEMS',
    "sortOrder" INTEGER NOT NULL,
    "receivedAt" TIMESTAMP(3),
    "receivedById" TEXT,

    CONSTRAINT "FoodOrderItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FoodOrder_status_neededBy_idx" ON "FoodOrder"("status", "neededBy");

-- CreateIndex
CREATE INDEX "FoodOrder_lodgeId_idx" ON "FoodOrder"("lodgeId");

-- CreateIndex
CREATE INDEX "FoodOrder_memberId_idx" ON "FoodOrder"("memberId");

-- CreateIndex
CREATE INDEX "FoodOrderItem_foodOrderId_sortOrder_idx" ON "FoodOrderItem"("foodOrderId", "sortOrder");

-- AddForeignKey
ALTER TABLE "FoodOrder" ADD CONSTRAINT "FoodOrder_lodgeId_fkey" FOREIGN KEY ("lodgeId") REFERENCES "Lodge"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FoodOrder" ADD CONSTRAINT "FoodOrder_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FoodOrderItem" ADD CONSTRAINT "FoodOrderItem_foodOrderId_fkey" FOREIGN KEY ("foodOrderId") REFERENCES "FoodOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Database backstops for the application's own validation: a quantity is more
-- than 0 and at most 99999.99 (two decimal places by the column type), and a
-- recorded price is never negative cents.
ALTER TABLE "FoodOrderItem" ADD CONSTRAINT "FoodOrderItem_quantity_positive" CHECK ("quantity" > 0 AND "quantity" <= 99999.99);

ALTER TABLE "FoodOrder" ADD CONSTRAINT "FoodOrder_priceCents_non_negative" CHECK ("priceCents" IS NULL OR "priceCents" >= 0);
