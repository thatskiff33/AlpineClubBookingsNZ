-- #5005 (child A): additive. Two new tables and their enums, which only the
-- new code reads and writes; the deployed client never names them. No column
-- is added to Booking or Payment and no value to an existing enum.
-- CreateEnum
CREATE TYPE "BookingImportBatchStatus" AS ENUM ('OPEN', 'COMPLETED', 'REVERSED');

-- CreateEnum
CREATE TYPE "BookingImportRowStatus" AS ENUM ('PENDING', 'IMPORTED', 'REFUSED', 'REVERSED');

-- CreateTable
CREATE TABLE "BookingImportBatch" (
    "id" TEXT NOT NULL,
    "lodgeId" TEXT NOT NULL,
    "batchKey" TEXT NOT NULL,
    "status" "BookingImportBatchStatus" NOT NULL DEFAULT 'OPEN',
    "digest" TEXT NOT NULL,
    "bookingCount" INTEGER NOT NULL,
    "guestCount" INTEGER NOT NULL,
    "guestNightCount" INTEGER NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "confirmedByMemberId" TEXT NOT NULL,
    "confirmedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "reversedByMemberId" TEXT,
    "reversedAt" TIMESTAMP(3),

    CONSTRAINT "BookingImportBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BookingImportRow" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "lodgeId" TEXT NOT NULL,
    "bookingRef" TEXT NOT NULL,
    "firstLineNumber" INTEGER NOT NULL,
    "status" "BookingImportRowStatus" NOT NULL DEFAULT 'PENDING',
    "refusalReason" TEXT,
    "refusalCode" TEXT,
    "amountCents" INTEGER NOT NULL,
    "guestCount" INTEGER NOT NULL,
    "guestNightCount" INTEGER NOT NULL,
    "bookingId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMP(3),

    CONSTRAINT "BookingImportRow_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BookingImportBatch_batchKey_key" ON "BookingImportBatch"("batchKey");

-- CreateIndex
CREATE INDEX "BookingImportBatch_lodgeId_confirmedAt_idx" ON "BookingImportBatch"("lodgeId", "confirmedAt");

-- CreateIndex
CREATE UNIQUE INDEX "BookingImportRow_bookingId_key" ON "BookingImportRow"("bookingId");

-- CreateIndex
CREATE INDEX "BookingImportRow_lodgeId_bookingRef_idx" ON "BookingImportRow"("lodgeId", "bookingRef");

-- CreateIndex
CREATE UNIQUE INDEX "BookingImportRow_batchId_bookingRef_key" ON "BookingImportRow"("batchId", "bookingRef");

-- AddForeignKey
ALTER TABLE "BookingImportBatch" ADD CONSTRAINT "BookingImportBatch_lodgeId_fkey" FOREIGN KEY ("lodgeId") REFERENCES "Lodge"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingImportRow" ADD CONSTRAINT "BookingImportRow_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "BookingImportBatch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingImportRow" ADD CONSTRAINT "BookingImportRow_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A Booking Ref imports once per lodge, across every batch (`INV-CAP-040`).
-- Only IMPORTED rows count, so a refused or reversed row frees the ref for a
-- corrected file. Prisma cannot express a partial index; it is listed in
-- prisma/partial-unique-indexes.tsv.
CREATE UNIQUE INDEX "BookingImportRow_imported_lodgeId_bookingRef_unique" ON "BookingImportRow"("lodgeId", "bookingRef") WHERE ("status" = 'IMPORTED');
