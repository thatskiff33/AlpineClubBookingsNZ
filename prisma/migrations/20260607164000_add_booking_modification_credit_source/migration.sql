ALTER TYPE "CreditType" ADD VALUE 'BOOKING_MODIFICATION_REFUND';

ALTER TABLE "MemberCredit"
  ADD COLUMN "sourceBookingModificationId" TEXT;

ALTER TABLE "MemberCredit"
  ADD CONSTRAINT "MemberCredit_sourceBookingModificationId_fkey"
  FOREIGN KEY ("sourceBookingModificationId")
  REFERENCES "BookingModification"("id")
  ON DELETE SET NULL
  ON UPDATE CASCADE;

CREATE INDEX "MemberCredit_sourceBookingModificationId_idx"
  ON "MemberCredit"("sourceBookingModificationId");
