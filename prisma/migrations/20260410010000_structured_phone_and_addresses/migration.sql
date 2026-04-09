-- Step 1: Add structured phone columns
ALTER TABLE "Member" ADD COLUMN "phoneCountryCode" TEXT;
ALTER TABLE "Member" ADD COLUMN "phoneAreaCode" TEXT;
ALTER TABLE "Member" ADD COLUMN "phoneNumber" TEXT;

-- Step 2: Migrate existing phone data into structured fields
-- Pattern: "+CC AC NUM" or "+CC NUM" or just "NUM"
UPDATE "Member"
SET
  "phoneCountryCode" = CASE
    WHEN "phone" LIKE '+%' AND array_length(string_to_array(trim("phone"), ' '), 1) >= 3
      THEN ltrim(split_part(trim("phone"), ' ', 1), '+')
    WHEN "phone" LIKE '+%' AND array_length(string_to_array(trim("phone"), ' '), 1) = 2
      THEN ltrim(split_part(trim("phone"), ' ', 1), '+')
    ELSE NULL
  END,
  "phoneAreaCode" = CASE
    WHEN "phone" LIKE '+%' AND array_length(string_to_array(trim("phone"), ' '), 1) >= 3
      THEN split_part(trim("phone"), ' ', 2)
    ELSE NULL
  END,
  "phoneNumber" = CASE
    WHEN "phone" LIKE '+%' AND array_length(string_to_array(trim("phone"), ' '), 1) >= 3
      THEN array_to_string((string_to_array(trim("phone"), ' '))[3:], ' ')
    WHEN "phone" LIKE '+%' AND array_length(string_to_array(trim("phone"), ' '), 1) = 2
      THEN split_part(trim("phone"), ' ', 2)
    ELSE trim("phone")
  END
WHERE "phone" IS NOT NULL AND trim("phone") != '';

-- Step 3: Drop old phone column
ALTER TABLE "Member" DROP COLUMN "phone";

-- Step 4: Add address columns (physical / STREET)
ALTER TABLE "Member" ADD COLUMN "streetAddressLine1" TEXT;
ALTER TABLE "Member" ADD COLUMN "streetAddressLine2" TEXT;
ALTER TABLE "Member" ADD COLUMN "streetCity" TEXT;
ALTER TABLE "Member" ADD COLUMN "streetRegion" TEXT;
ALTER TABLE "Member" ADD COLUMN "streetPostalCode" TEXT;
ALTER TABLE "Member" ADD COLUMN "streetCountry" TEXT;

-- Step 5: Add address columns (postal / POBOX)
ALTER TABLE "Member" ADD COLUMN "postalAddressLine1" TEXT;
ALTER TABLE "Member" ADD COLUMN "postalAddressLine2" TEXT;
ALTER TABLE "Member" ADD COLUMN "postalCity" TEXT;
ALTER TABLE "Member" ADD COLUMN "postalRegion" TEXT;
ALTER TABLE "Member" ADD COLUMN "postalPostalCode" TEXT;
ALTER TABLE "Member" ADD COLUMN "postalCountry" TEXT;
