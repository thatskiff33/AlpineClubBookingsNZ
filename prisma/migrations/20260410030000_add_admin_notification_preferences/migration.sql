ALTER TABLE "NotificationPreference"
ADD COLUMN "adminNewBooking" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN "adminPaymentFailure" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN "adminPendingDeadline" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN "adminBookingBumped" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN "adminXeroSyncError" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN "adminCapacityWarning" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN "adminDailyDigest" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN "adminWaitlistOffer" BOOLEAN NOT NULL DEFAULT true;
