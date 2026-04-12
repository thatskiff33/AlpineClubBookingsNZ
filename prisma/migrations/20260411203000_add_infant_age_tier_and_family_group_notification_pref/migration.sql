-- Rebuild AgeTier so PostgreSQL enum ordering matches the intended age-tier sort order.
ALTER TABLE "Member" ALTER COLUMN "ageTier" DROP DEFAULT;

ALTER TYPE "AgeTier" RENAME TO "AgeTier_old";

CREATE TYPE "AgeTier" AS ENUM ('INFANT', 'CHILD', 'YOUTH', 'ADULT');

ALTER TABLE "Member"
ALTER COLUMN "ageTier" TYPE "AgeTier"
USING ("ageTier"::text::"AgeTier");

ALTER TABLE "SeasonRate"
ALTER COLUMN "ageTier" TYPE "AgeTier"
USING ("ageTier"::text::"AgeTier");

ALTER TABLE "BookingGuest"
ALTER COLUMN "ageTier" TYPE "AgeTier"
USING ("ageTier"::text::"AgeTier");

ALTER TABLE "AgeTierSetting"
ALTER COLUMN "tier" TYPE "AgeTier"
USING ("tier"::text::"AgeTier");

DROP TYPE "AgeTier_old";

ALTER TABLE "Member" ALTER COLUMN "ageTier" SET DEFAULT 'ADULT';

ALTER TABLE "NotificationPreference"
ADD COLUMN "adminFamilyGroupRequest" BOOLEAN NOT NULL DEFAULT true;
