-- #5066: the supplier on the app's generated booking invoice (Xero off).
-- Two nullable columns, no default, no backfill (expand only).
ALTER TABLE "ClubIdentitySettings" ADD COLUMN "legalName" TEXT,
ADD COLUMN "postalAddress" TEXT;
