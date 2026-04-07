-- Add canLogin field to Member
ALTER TABLE "Member" ADD COLUMN IF NOT EXISTS "canLogin" BOOLEAN NOT NULL DEFAULT false;

-- Backfill: all primary (non-dependent) active members can log in
UPDATE "Member" SET "canLogin" = true WHERE "parentMemberId" IS NULL AND "active" = true;

-- Unique partial index: only one login-eligible member per email
CREATE UNIQUE INDEX IF NOT EXISTS "Member_email_login_unique" ON "Member" ("email") WHERE "canLogin" = true;
