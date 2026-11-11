-- #4431: a positive manual credit grant names the Xero account its note
-- posts to. Nullable and without a default, so the previous colour keeps
-- inserting requests that do not mention the column and keeps approving
-- them with no note.
CREATE TYPE "AdminCreditGrantAccount" AS ENUM ('MEMBER_OWN_MONEY', 'GOODWILL');

ALTER TABLE "AdminCreditAdjustmentRequest" ADD COLUMN "grantAccount" "AdminCreditGrantAccount";
