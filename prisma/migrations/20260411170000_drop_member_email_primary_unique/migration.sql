-- The current auth invariant is "at most one login-capable member per email".
-- That is enforced by the partial unique index Member_email_login_unique
-- (WHERE canLogin = true).
--
-- Member_email_primary_unique is an older constraint from the parent/dependent
-- model. It is now stricter than the application rules and can incorrectly
-- reject shared-email non-login adults. Drop it so the DB matches current auth
-- semantics.
DROP INDEX IF EXISTS "Member_email_primary_unique";
