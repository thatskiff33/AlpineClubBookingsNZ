-- "Only book if my guests can come" flag (issue #708).
-- When true, a member booking that loses capacity for its non-member guests is
-- cancelled outright instead of the new default partial bump (drop the
-- non-members, keep the members and reprice). Both paths run pre-charge, so no
-- refund machinery is involved. Defaults to false to preserve existing rows.

ALTER TABLE "Booking"
  ADD COLUMN "cancelIfGuestsBumped" BOOLEAN NOT NULL DEFAULT false;
