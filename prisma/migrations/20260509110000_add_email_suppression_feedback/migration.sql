-- CreateEnum
CREATE TYPE "EmailSuppressionReason" AS ENUM ('BOUNCE', 'COMPLAINT');

-- CreateTable
CREATE TABLE "EmailSuppression" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "reason" "EmailSuppressionReason" NOT NULL,
    "eventCount" INTEGER NOT NULL DEFAULT 1,
    "suppressedAt" TIMESTAMP(3),
    "lastEventAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastEventType" TEXT NOT NULL,
    "lastBounceType" TEXT,
    "lastBounceSubType" TEXT,
    "lastComplaintFeedbackType" TEXT,
    "lastSesMessageId" TEXT,
    "clearedAt" TIMESTAMP(3),
    "clearedById" TEXT,
    "clearReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmailSuppression_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "EmailSuppression_email_key" ON "EmailSuppression"("email");

-- CreateIndex
CREATE INDEX "EmailSuppression_suppressedAt_idx" ON "EmailSuppression"("suppressedAt");

-- CreateIndex
CREATE INDEX "EmailSuppression_clearedAt_idx" ON "EmailSuppression"("clearedAt");

-- CreateIndex
CREATE INDEX "EmailSuppression_reason_suppressedAt_idx" ON "EmailSuppression"("reason", "suppressedAt");

-- CreateIndex
CREATE INDEX "EmailSuppression_lastEventAt_idx" ON "EmailSuppression"("lastEventAt");
