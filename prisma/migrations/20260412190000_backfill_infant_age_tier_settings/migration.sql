-- Backfill legacy 3-tier age settings to the 4-tier TAC defaults introduced in Phase 3.
DO $$
DECLARE
  has_legacy_three_tier_settings BOOLEAN;
BEGIN
  SELECT
    NOT EXISTS (
      SELECT 1 FROM "AgeTierSetting" WHERE "tier" = 'INFANT'
    )
    AND EXISTS (
      SELECT 1 FROM "AgeTierSetting"
      WHERE "tier" = 'CHILD' AND "minAge" = 0 AND "maxAge" = 9 AND "sortOrder" = 1
    )
    AND EXISTS (
      SELECT 1 FROM "AgeTierSetting"
      WHERE "tier" = 'YOUTH' AND "minAge" = 10 AND "maxAge" = 17 AND "sortOrder" = 2
    )
    AND EXISTS (
      SELECT 1 FROM "AgeTierSetting"
      WHERE "tier" = 'ADULT' AND "minAge" = 18 AND "maxAge" IS NULL AND "sortOrder" = 3
    )
  INTO has_legacy_three_tier_settings;

  IF has_legacy_three_tier_settings THEN
    INSERT INTO "AgeTierSetting" (
      "id",
      "tier",
      "minAge",
      "maxAge",
      "label",
      "sortOrder",
      "createdAt",
      "updatedAt"
    ) VALUES (
      'age-tier-setting-infant-backfill-20260412',
      'INFANT',
      0,
      4,
      'Infant (under 5)',
      0,
      CURRENT_TIMESTAMP,
      CURRENT_TIMESTAMP
    );

    UPDATE "AgeTierSetting"
    SET
      "minAge" = 5,
      "maxAge" = 9,
      "label" = 'Child (5-9)',
      "sortOrder" = 1,
      "updatedAt" = CURRENT_TIMESTAMP
    WHERE "tier" = 'CHILD';

    UPDATE "AgeTierSetting"
    SET
      "label" = 'Youth (10-17)',
      "sortOrder" = 2,
      "updatedAt" = CURRENT_TIMESTAMP
    WHERE "tier" = 'YOUTH';

    UPDATE "AgeTierSetting"
    SET
      "label" = 'Adult (18+)',
      "sortOrder" = 3,
      "updatedAt" = CURRENT_TIMESTAMP
    WHERE "tier" = 'ADULT';
  END IF;
END $$;
