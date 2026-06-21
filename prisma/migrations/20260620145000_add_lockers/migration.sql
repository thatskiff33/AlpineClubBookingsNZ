-- Create lockers for optional member allocation.
CREATE TABLE "Locker" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "allocatedToMemberId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Locker_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Locker_allocatedToMemberId_idx" ON "Locker"("allocatedToMemberId");
CREATE INDEX "Locker_name_idx" ON "Locker"("name");

ALTER TABLE "Locker"
ADD CONSTRAINT "Locker_allocatedToMemberId_fkey"
FOREIGN KEY ("allocatedToMemberId") REFERENCES "Member"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
