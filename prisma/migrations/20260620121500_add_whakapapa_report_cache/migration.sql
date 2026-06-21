-- CreateTable
CREATE TABLE "WhakapapaReportCache" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "frozenUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WhakapapaReportCache_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WhakapapaReportCache_source_key" ON "WhakapapaReportCache"("source");

-- CreateIndex
CREATE INDEX "WhakapapaReportCache_fetchedAt_idx" ON "WhakapapaReportCache"("fetchedAt");

-- CreateIndex
CREATE INDEX "WhakapapaReportCache_frozenUntil_idx" ON "WhakapapaReportCache"("frozenUntil");
