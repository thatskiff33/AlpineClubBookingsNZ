-- Add optional pointer from BookingChangeRequest to the executed
-- BookingModification, so the audit log links approval to the actual
-- booking edit (rather than relying on the admin to remember which
-- modification went with which request).

ALTER TABLE "BookingChangeRequest"
  ADD COLUMN "linkedModificationId" TEXT;

CREATE INDEX "BookingChangeRequest_linkedModificationId_idx"
  ON "BookingChangeRequest"("linkedModificationId");

ALTER TABLE "BookingChangeRequest"
  ADD CONSTRAINT "BookingChangeRequest_linkedModificationId_fkey"
  FOREIGN KEY ("linkedModificationId") REFERENCES "BookingModification"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
