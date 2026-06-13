ALTER TABLE "EmailMessageSetting"
    ADD COLUMN "doorCode" VARCHAR(80);

ALTER TABLE "Booking"
    ADD COLUMN "preArrivalReminderSentAt" TIMESTAMP(3);

CREATE INDEX "Booking_status_preArrivalReminderSentAt_checkIn_idx"
    ON "Booking"("status", "preArrivalReminderSentAt", "checkIn");
