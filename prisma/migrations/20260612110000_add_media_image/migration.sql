-- Uploaded images for the page-content image picker, stored in the
-- database so they persist across Docker redeploys (see #731). Served
-- publicly via GET /api/images/[id].

CREATE TABLE "MediaImage" (
    "id" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "byteSize" INTEGER NOT NULL,
    "data" BYTEA NOT NULL,
    "altText" TEXT,
    "width" INTEGER,
    "height" INTEGER,
    "uploadedByMemberId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MediaImage_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "MediaImage_uploadedByMemberId_idx" ON "MediaImage"("uploadedByMemberId");

CREATE INDEX "MediaImage_createdAt_idx" ON "MediaImage"("createdAt");
