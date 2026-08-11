-- Registry of external / partner lodges the club recognises for the reciprocal
-- "other club member" rate (#2749). Purely additive EXPAND: one brand-new,
-- empty table with no backfill — every reader treats an empty table as "no
-- partner lodges configured" until an admin adds rows under Admin -> Lodges.
-- See docs/BLUE_GREEN_MIGRATION_SAFETY.tsv for the blue/green analysis.
--
-- bedCapacity is INFORMATIONAL only (a fact about the partner lodge); it is
-- never this system's booking capacity, which is derived from Lodge rooms/beds.

-- CreateTable
CREATE TABLE "OtherLodge" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "location" VARCHAR(300),
    "bookingOfficerName" VARCHAR(200),
    "bookingOfficerEmail" VARCHAR(320),
    "bookingOfficerPhone" VARCHAR(50),
    "bedCapacity" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OtherLodge_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OtherLodge_name_key" ON "OtherLodge"("name");
