-- AlterTable
ALTER TABLE "NotificationPreference" ADD COLUMN     "adminBookingRequest" BOOLEAN NOT NULL DEFAULT true;

-- CreateEnum
CREATE TYPE "BookingRequestType" AS ENUM ('GENERAL');

-- CreateEnum
CREATE TYPE "BookingRequestStatus" AS ENUM ('NEW', 'VERIFIED', 'PRICED', 'APPROVED', 'DECLINED', 'CONVERTED');

-- CreateTable
CREATE TABLE "BookingRequest" (
    "id" TEXT NOT NULL,
    "type" "BookingRequestType" NOT NULL DEFAULT 'GENERAL',
    "status" "BookingRequestStatus" NOT NULL DEFAULT 'NEW',
    "contactFirstName" VARCHAR(100) NOT NULL,
    "contactLastName" VARCHAR(100) NOT NULL,
    "contactEmail" VARCHAR(200) NOT NULL,
    "contactPhone" VARCHAR(30),
    "checkIn" DATE NOT NULL,
    "checkOut" DATE NOT NULL,
    "guests" JSONB NOT NULL,
    "message" VARCHAR(1000),
    "indicativePriceCents" INTEGER,
    "priceCents" INTEGER,
    "verificationTokenHash" TEXT,
    "verificationTokenExpiresAt" TIMESTAMP(3),
    "verifiedAt" TIMESTAMP(3),
    "pricedByMemberId" TEXT,
    "pricedAt" TIMESTAMP(3),
    "reviewedByMemberId" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "declineReason" VARCHAR(2000),
    "convertedBookingId" TEXT,
    "convertedMemberId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BookingRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentLink" (
    "id" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "bookingRequestId" TEXT,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BookingRequestSettings" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "showPricingToNonMembers" BOOLEAN NOT NULL DEFAULT false,
    "updatedByMemberId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BookingRequestSettings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BookingRequest_verificationTokenHash_key" ON "BookingRequest"("verificationTokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "BookingRequest_convertedBookingId_key" ON "BookingRequest"("convertedBookingId");

-- CreateIndex
CREATE INDEX "BookingRequest_status_createdAt_idx" ON "BookingRequest"("status", "createdAt");

-- CreateIndex
CREATE INDEX "BookingRequest_contactEmail_idx" ON "BookingRequest"("contactEmail");

-- CreateIndex
CREATE INDEX "BookingRequest_verificationTokenExpiresAt_idx" ON "BookingRequest"("verificationTokenExpiresAt");

-- CreateIndex
CREATE INDEX "BookingRequest_status_reviewedAt_idx" ON "BookingRequest"("status", "reviewedAt");

-- CreateIndex
CREATE INDEX "BookingRequest_pricedByMemberId_idx" ON "BookingRequest"("pricedByMemberId");

-- CreateIndex
CREATE INDEX "BookingRequest_reviewedByMemberId_idx" ON "BookingRequest"("reviewedByMemberId");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentLink_tokenHash_key" ON "PaymentLink"("tokenHash");

-- CreateIndex
CREATE INDEX "PaymentLink_bookingId_idx" ON "PaymentLink"("bookingId");

-- CreateIndex
CREATE INDEX "PaymentLink_bookingRequestId_idx" ON "PaymentLink"("bookingRequestId");

-- CreateIndex
CREATE INDEX "PaymentLink_expiresAt_idx" ON "PaymentLink"("expiresAt");

-- CreateIndex
CREATE INDEX "BookingRequestSettings_updatedByMemberId_idx" ON "BookingRequestSettings"("updatedByMemberId");

-- AddForeignKey
ALTER TABLE "BookingRequest" ADD CONSTRAINT "BookingRequest_convertedBookingId_fkey" FOREIGN KEY ("convertedBookingId") REFERENCES "Booking"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentLink" ADD CONSTRAINT "PaymentLink_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentLink" ADD CONSTRAINT "PaymentLink_bookingRequestId_fkey" FOREIGN KEY ("bookingRequestId") REFERENCES "BookingRequest"("id") ON DELETE SET NULL ON UPDATE CASCADE;

