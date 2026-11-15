-- #4618: officer authenticator-or-passkey policy.
-- Expand only. Every column is nullable or has a constant default, so the
-- release still serving traffic never names them and its inserts still succeed.
-- No backfill. The Member_stamp_sessions_revoked_at trigger is not touched.

ALTER TABLE "LoginSecuritySetting"
  ADD COLUMN "officerTwoFactorPolicy" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "officerTwoFactorGraceDays" INTEGER NOT NULL DEFAULT 14;

ALTER TABLE "LoginSecuritySetting"
  ADD CONSTRAINT "LoginSecuritySetting_officerTwoFactorGraceDays_range"
  CHECK (
    "officerTwoFactorGraceDays" >= 0
    AND "officerTwoFactorGraceDays" <= 60
  );

ALTER TABLE "AccessRoleDefinition"
  ADD COLUMN "requiresTwoFactor" BOOLEAN;

ALTER TABLE "Member"
  ADD COLUMN "twoFactorGraceStartedAt" TIMESTAMP(3),
  ADD COLUMN "factorsResetAt" TIMESTAMP(3);
