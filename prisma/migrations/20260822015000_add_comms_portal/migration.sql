
-- CreateEnum
CREATE TYPE "ClubPostReportReason" AS ENUM ('SPAM', 'INAPPROPRIATE', 'HARASSMENT', 'OTHER');

-- AlterTable
ALTER TABLE "ClubModuleSettings" ADD COLUMN     "commsPortal" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "ClubPost" (
    "id" TEXT NOT NULL,
    "originClubCode" VARCHAR(40),
    "originClubName" VARCHAR(200),
    "sharedAt" TIMESTAMP(3),
    "serverPostId" VARCHAR(64),
    "authorMemberId" TEXT,
    "authorName" VARCHAR(200) NOT NULL,
    "content" VARCHAR(4000) NOT NULL,
    "postedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "hiddenAt" TIMESTAMP(3),
    "removedAt" TIMESTAMP(3),
    "reportCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClubPost_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClubPostImage" (
    "id" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "storageKey" VARCHAR(300) NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "bytes" INTEGER NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClubPostImage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClubPostReport" (
    "id" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "reporterMemberId" TEXT,
    "reporterName" VARCHAR(200) NOT NULL,
    "reason" "ClubPostReportReason" NOT NULL,
    "details" VARCHAR(1000),
    "dismissedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClubPostReport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ClubPost_serverPostId_key" ON "ClubPost"("serverPostId");

-- CreateIndex
CREATE INDEX "ClubPost_postedAt_idx" ON "ClubPost"("postedAt");

-- CreateIndex
CREATE INDEX "ClubPost_originClubCode_idx" ON "ClubPost"("originClubCode");

-- CreateIndex
CREATE INDEX "ClubPost_sharedAt_idx" ON "ClubPost"("sharedAt");

-- CreateIndex
CREATE INDEX "ClubPost_authorMemberId_idx" ON "ClubPost"("authorMemberId");

-- CreateIndex
CREATE INDEX "ClubPostImage_postId_idx" ON "ClubPostImage"("postId");

-- CreateIndex
CREATE INDEX "ClubPostReport_postId_idx" ON "ClubPostReport"("postId");

-- CreateIndex
CREATE INDEX "ClubPostReport_reporterMemberId_idx" ON "ClubPostReport"("reporterMemberId");

-- CreateIndex
CREATE UNIQUE INDEX "ClubPostReport_postId_reporterMemberId_key" ON "ClubPostReport"("postId", "reporterMemberId");

-- AddForeignKey
ALTER TABLE "ClubPost" ADD CONSTRAINT "ClubPost_authorMemberId_fkey" FOREIGN KEY ("authorMemberId") REFERENCES "Member"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClubPostImage" ADD CONSTRAINT "ClubPostImage_postId_fkey" FOREIGN KEY ("postId") REFERENCES "ClubPost"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClubPostReport" ADD CONSTRAINT "ClubPostReport_postId_fkey" FOREIGN KEY ("postId") REFERENCES "ClubPost"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClubPostReport" ADD CONSTRAINT "ClubPostReport_reporterMemberId_fkey" FOREIGN KEY ("reporterMemberId") REFERENCES "Member"("id") ON DELETE SET NULL ON UPDATE CASCADE;

