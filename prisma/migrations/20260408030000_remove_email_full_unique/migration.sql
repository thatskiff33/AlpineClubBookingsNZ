-- Remove the full unique constraint on Member.email
-- The partial unique index "Member_email_login_unique" (WHERE canLogin = true)
-- from migration 20260408010000 remains as the only email uniqueness enforcement.
-- This allows non-login members (children/youth) to share an adult's email.
DROP INDEX IF EXISTS "Member_email_key";
