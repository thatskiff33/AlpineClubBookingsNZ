-- Add admin activation flags for upcoming optional modules.
-- Provider credentials, Xero tenant data, and payment secrets stay outside this table.
ALTER TABLE "ClubModuleSettings"
  ADD COLUMN IF NOT EXISTS "bedAllocation" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "internetBankingPayments" BOOLEAN NOT NULL DEFAULT true;
