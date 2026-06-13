CREATE TYPE "ClubThemeFont" AS ENUM (
    'INTER',
    'LEAGUE_SPARTAN',
    'LORA',
    'SOURCE_SERIF_4',
    'NUNITO_SANS'
);

CREATE TABLE "ClubTheme" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "brandGold" TEXT NOT NULL,
    "brandCharcoal" TEXT NOT NULL,
    "brandDeep" TEXT NOT NULL,
    "brandRidge" TEXT NOT NULL,
    "brandMist" TEXT NOT NULL,
    "brandSnow" TEXT NOT NULL,
    "brandSafety" TEXT NOT NULL,
    "headingFontKey" "ClubThemeFont" NOT NULL DEFAULT 'LEAGUE_SPARTAN',
    "bodyFontKey" "ClubThemeFont" NOT NULL DEFAULT 'INTER',
    "logoDataUrl" TEXT,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClubTheme_pkey" PRIMARY KEY ("id")
);

WITH existing_deployment AS (
    SELECT EXISTS (SELECT 1 FROM "Member" LIMIT 1) AS has_data
)
INSERT INTO "ClubTheme" (
    "id",
    "brandGold",
    "brandCharcoal",
    "brandDeep",
    "brandRidge",
    "brandMist",
    "brandSnow",
    "brandSafety",
    "headingFontKey",
    "bodyFontKey",
    "completedAt"
)
SELECT
    'default',
    CASE WHEN has_data THEN '#ffcb05' ELSE '#7a8f6a' END,
    CASE WHEN has_data THEN '#4d4d46' ELSE '#30343b' END,
    CASE WHEN has_data THEN '#2f2f2b' ELSE '#1f2933' END,
    CASE WHEN has_data THEN '#6a6a63' ELSE '#65717b' END,
    CASE WHEN has_data THEN '#d9d5c2' ELSE '#d7dde1' END,
    CASE WHEN has_data THEN '#f7f5ed' ELSE '#f8faf8' END,
    CASE WHEN has_data THEN '#ff7c12' ELSE '#c2562c' END,
    'LEAGUE_SPARTAN'::"ClubThemeFont",
    'INTER'::"ClubThemeFont",
    CASE WHEN has_data THEN CURRENT_TIMESTAMP ELSE NULL END
FROM existing_deployment
ON CONFLICT ("id") DO NOTHING;
