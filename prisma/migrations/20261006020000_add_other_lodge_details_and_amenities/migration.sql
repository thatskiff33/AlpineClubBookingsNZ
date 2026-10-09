-- #50: the fourteen lodge-detail columns the Alpine Central Server now carries
-- for every registry entry, and the Amenity table that goes with them.
--
-- PURELY ADDITIVE EXPAND. Fourteen new columns on "OtherLodge" (every one
-- nullable or carrying a constant default), one brand-new empty table, its
-- unique index and its foreign key. Nothing is renamed, retyped, dropped or
-- repurposed, and no existing row's values are rewritten. See
-- docs/BLUE_GREEN_MIGRATION_SAFETY.tsv for the blue/green analysis.
--
-- NOT DATA-REWRITING: no DML at all. The yes/no columns take their DEFAULT false
-- from the catalogue, which on PostgreSQL 11 and later is recorded as a missing
-- value rather than written into each row, so the table is not rewritten and
-- every existing row stays byte-identical. Old rows therefore read as "no" for
-- every yes/no detail and as empty for every text and date detail, which is the
-- behaviour the issue asks for.
--
-- OLD-CODE COMPATIBLE: the draining colour's generated client knows none of
-- these columns and never selects or writes them, so its reads are unaffected
-- and its inserts receive the defaults. It never touches "Amenity".
--
-- LOCK IMPACT: ADD COLUMN with a constant default or no default is catalog-only
-- (no table rewrite), taking ACCESS EXCLUSIVE on "OtherLodge" for the catalogue
-- change alone. CREATE TABLE locks only the relation it creates; the index and
-- the foreign key are on that same empty table. "OtherLodge" is a small admin
-- registry, not a hot table.

-- AlterTable
ALTER TABLE "OtherLodge"
  ADD COLUMN "siteUrl" VARCHAR(500),
  ADD COLUMN "bookingPath" VARCHAR(300),
  ADD COLUMN "requiresLodgeCustodian" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "freeWifi" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "quietRoom" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "dryingRoom" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "sharedKitchen" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "wheelchairAccessible" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "breakfastIncluded" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "lunchIncluded" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "dinnerIncluded" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "cancellationPeriod" VARCHAR(200),
  ADD COLUMN "winterSeasonStart" DATE,
  ADD COLUMN "summerSeasonStart" DATE;

-- CreateTable
CREATE TABLE "Amenity" (
    "id" TEXT NOT NULL,
    "otherLodgeId" TEXT NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "description" VARCHAR(1000),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Amenity_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Amenity_otherLodgeId_name_key" ON "Amenity"("otherLodgeId", "name");

-- AddForeignKey
ALTER TABLE "Amenity" ADD CONSTRAINT "Amenity_otherLodgeId_fkey" FOREIGN KEY ("otherLodgeId") REFERENCES "OtherLodge"("id") ON DELETE CASCADE ON UPDATE CASCADE;
