-- Add a dedicated admin notification preference for booking change requests.
-- Existing admins keep receiving the alert by default.
ALTER TABLE "NotificationPreference"
  ADD COLUMN "adminBookingChangeRequest" BOOLEAN NOT NULL DEFAULT true;
