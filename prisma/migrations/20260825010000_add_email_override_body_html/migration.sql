-- Fork #38 (owner decision, 25 Aug 2026): rich email bodies. The sanitised
-- HTML body is stored beside the derived plain text; NULL for every row saved
-- before the feature, which keeps those rendering through the plain-text path
-- unchanged. Additive and nullable, so the deployed old code keeps reading
-- and writing this table unchanged (expand-safe per BLUE_GREEN_MIGRATION_POLICY).
ALTER TABLE "EmailTemplateOverride" ADD COLUMN "bodyHtml" TEXT;
