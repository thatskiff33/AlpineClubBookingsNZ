-- ALP-719 (#5457, owner decision #5305 item 1): when an officer approved an AI
-- app connection on the screen that says the app can also act as an officer.
-- Expand only: one nullable column with no default and no backfill, so every
-- existing connection reads as not approved for officer actions and its
-- officer approves again. No row is rewritten and no other table is touched.

-- AlterTable
ALTER TABLE "McpGrant" ADD COLUMN "officerConsentAt" TIMESTAMP(3);
