CREATE TYPE "FinanceReportCategoryKind" AS ENUM ('REVENUE', 'EXPENSE');

CREATE TABLE "FinanceReportCategory" (
    "id" TEXT NOT NULL,
    "kind" "FinanceReportCategoryKind" NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FinanceReportCategory_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "FinanceReportCategoryMapping" (
    "id" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "accountCode" VARCHAR(40),
    "sectionLabel" VARCHAR(200),
    "lineLabel" VARCHAR(200),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FinanceReportCategoryMapping_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "FinanceReportCategory_kind_name_key"
ON "FinanceReportCategory"("kind", "name");

CREATE INDEX "FinanceReportCategory_kind_archived_sortOrder_idx"
ON "FinanceReportCategory"("kind", "archived", "sortOrder");

CREATE INDEX "FinanceReportCategoryMapping_categoryId_idx"
ON "FinanceReportCategoryMapping"("categoryId");

CREATE INDEX "FinanceReportCategoryMapping_accountCode_idx"
ON "FinanceReportCategoryMapping"("accountCode");

CREATE INDEX "FinanceReportCategoryMapping_sectionLabel_lineLabel_idx"
ON "FinanceReportCategoryMapping"("sectionLabel", "lineLabel");

ALTER TABLE "FinanceReportCategoryMapping"
ADD CONSTRAINT "FinanceReportCategoryMapping_categoryId_fkey"
FOREIGN KEY ("categoryId") REFERENCES "FinanceReportCategory"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
