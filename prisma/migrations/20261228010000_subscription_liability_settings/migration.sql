-- #5190: the club's subscription-liability rule. Two enum columns on the
-- singleton MembershipLockoutSettings row, both NOT_CHOSEN for an existing row
-- and for a fresh install. Expand only. NOT_CHOSEN keeps billing and booking
-- access on their pre-#5190 rules, so no member is newly billed or blocked by
-- this migration. The deployed release neither reads nor writes either column.

-- CreateEnum
CREATE TYPE "SubscriptionRequiredTypeAgeRule" AS ENUM ('NOT_CHOSEN', 'ALWAYS_OWES', 'AGE_TIER_EXEMPTS');

-- CreateEnum
CREATE TYPE "SubscriptionLiabilityAgeSource" AS ENUM ('NOT_CHOSEN', 'SEASON_START', 'SEASON_END', 'CURRENT_AGE');

-- AlterTable
ALTER TABLE "MembershipLockoutSettings" ADD COLUMN "requiredTypeAgeRule" "SubscriptionRequiredTypeAgeRule" NOT NULL DEFAULT 'NOT_CHOSEN',
ADD COLUMN "liabilityAgeSource" "SubscriptionLiabilityAgeSource" NOT NULL DEFAULT 'NOT_CHOSEN';
