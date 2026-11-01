-- Nullable expansion only: existing inactive members keep an unknown departure date.
ALTER TABLE "Member" ADD COLUMN "leavingDate" DATE;
