-- Add optional room/bed inventory and current per-night guest allocations.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'BedAllocationSource') THEN
        CREATE TYPE "BedAllocationSource" AS ENUM ('AUTO', 'MANUAL');
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS "LodgeRoom" (
    "id" TEXT NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "notes" VARCHAR(500),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LodgeRoom_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "LodgeBed" (
    "id" TEXT NOT NULL,
    "roomId" TEXT NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LodgeBed_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "BedAllocation" (
    "id" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "bookingGuestId" TEXT NOT NULL,
    "roomId" TEXT NOT NULL,
    "bedId" TEXT NOT NULL,
    "stayDate" DATE NOT NULL,
    "source" "BedAllocationSource" NOT NULL DEFAULT 'AUTO',
    "approvedByMemberId" TEXT,
    "approvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BedAllocation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "LodgeRoom_name_key" ON "LodgeRoom"("name");
CREATE INDEX IF NOT EXISTS "LodgeRoom_active_sortOrder_idx" ON "LodgeRoom"("active", "sortOrder");

CREATE UNIQUE INDEX IF NOT EXISTS "LodgeBed_roomId_name_key" ON "LodgeBed"("roomId", "name");
CREATE UNIQUE INDEX IF NOT EXISTS "LodgeBed_id_roomId_key" ON "LodgeBed"("id", "roomId");
CREATE INDEX IF NOT EXISTS "LodgeBed_roomId_active_sortOrder_idx" ON "LodgeBed"("roomId", "active", "sortOrder");

CREATE UNIQUE INDEX IF NOT EXISTS "BedAllocation_bedId_stayDate_key" ON "BedAllocation"("bedId", "stayDate");
CREATE UNIQUE INDEX IF NOT EXISTS "BedAllocation_bookingGuestId_stayDate_key" ON "BedAllocation"("bookingGuestId", "stayDate");
CREATE INDEX IF NOT EXISTS "BedAllocation_bookingId_idx" ON "BedAllocation"("bookingId");
CREATE INDEX IF NOT EXISTS "BedAllocation_bookingGuestId_idx" ON "BedAllocation"("bookingGuestId");
CREATE INDEX IF NOT EXISTS "BedAllocation_roomId_idx" ON "BedAllocation"("roomId");
CREATE INDEX IF NOT EXISTS "BedAllocation_approvedByMemberId_idx" ON "BedAllocation"("approvedByMemberId");

ALTER TABLE "LodgeBed"
    ADD CONSTRAINT "LodgeBed_roomId_fkey"
    FOREIGN KEY ("roomId") REFERENCES "LodgeRoom"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "BedAllocation"
    ADD CONSTRAINT "BedAllocation_bookingId_fkey"
    FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "BedAllocation"
    ADD CONSTRAINT "BedAllocation_bookingGuestId_fkey"
    FOREIGN KEY ("bookingGuestId") REFERENCES "BookingGuest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "BedAllocation"
    ADD CONSTRAINT "BedAllocation_roomId_fkey"
    FOREIGN KEY ("roomId") REFERENCES "LodgeRoom"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "BedAllocation"
    ADD CONSTRAINT "BedAllocation_bedId_roomId_fkey"
    FOREIGN KEY ("bedId", "roomId") REFERENCES "LodgeBed"("id", "roomId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "BedAllocation"
    ADD CONSTRAINT "BedAllocation_approvedByMemberId_fkey"
    FOREIGN KEY ("approvedByMemberId") REFERENCES "Member"("id") ON DELETE SET NULL ON UPDATE CASCADE;
