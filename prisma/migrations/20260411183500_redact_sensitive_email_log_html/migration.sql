-- Token-bearing email templates include live reset or verification links.
-- Redact any previously stored rendered HTML so those tokens are not retained
-- in EmailLog rows at rest.
UPDATE "EmailLog"
SET "htmlBody" = NULL
WHERE "templateName" IN (
  'password-reset',
  'admin-password-reset',
  'email-verification',
  'email-change-verification',
  'age-up-invitation'
);
