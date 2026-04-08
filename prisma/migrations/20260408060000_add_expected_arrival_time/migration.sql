-- AlterTable: Add expectedArrivalTime to Booking
ALTER TABLE "Booking" ADD COLUMN IF NOT EXISTS "expectedArrivalTime" VARCHAR(5);
