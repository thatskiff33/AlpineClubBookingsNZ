-- Create table for admin-managed website page content.
-- Squashed from four development migrations on the content-management
-- branch; none were deployed to a shared environment.
CREATE TABLE "PageContent" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "caption" TEXT NOT NULL DEFAULT '',
    "menuTitle" TEXT NOT NULL DEFAULT '',
    "title" TEXT NOT NULL,
    "headerText" TEXT NOT NULL DEFAULT '',
    "sortOrder" INTEGER NOT NULL DEFAULT 100,
    "contentHtml" TEXT NOT NULL,
    "updatedByMemberId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PageContent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PageContent_slug_key" ON "PageContent"("slug");
CREATE UNIQUE INDEX "PageContent_path_key" ON "PageContent"("path");
CREATE INDEX "PageContent_sortOrder_idx" ON "PageContent"("sortOrder");
CREATE INDEX "PageContent_updatedByMemberId_idx" ON "PageContent"("updatedByMemberId");
