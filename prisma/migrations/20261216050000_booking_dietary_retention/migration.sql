ALTER TABLE "PrivacyRetentionSettings"
    ADD COLUMN "bookingDietaryRetentionDays" INTEGER NOT NULL DEFAULT 30,
    ADD COLUMN "bookingDietaryClearEnabled" BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN "bookingDietaryClearStartedAt" TIMESTAMP(3);
