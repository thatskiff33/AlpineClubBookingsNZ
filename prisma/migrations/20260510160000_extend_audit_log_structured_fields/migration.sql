-- Extend audit logging with structured actor/subject/entity metadata.
ALTER TABLE "AuditLog" ADD COLUMN "actorMemberId" TEXT;
ALTER TABLE "AuditLog" ADD COLUMN "subjectMemberId" TEXT;
ALTER TABLE "AuditLog" ADD COLUMN "entityType" TEXT;
ALTER TABLE "AuditLog" ADD COLUMN "entityId" TEXT;
ALTER TABLE "AuditLog" ADD COLUMN "category" TEXT;
ALTER TABLE "AuditLog" ADD COLUMN "severity" TEXT;
ALTER TABLE "AuditLog" ADD COLUMN "outcome" TEXT;
ALTER TABLE "AuditLog" ADD COLUMN "summary" TEXT;
ALTER TABLE "AuditLog" ADD COLUMN "metadata" JSONB;
ALTER TABLE "AuditLog" ADD COLUMN "requestId" TEXT;
ALTER TABLE "AuditLog" ADD COLUMN "userAgent" TEXT;
ALTER TABLE "AuditLog" ADD COLUMN "retentionClass" TEXT;
ALTER TABLE "AuditLog" ADD COLUMN "expiresAt" TIMESTAMP(3);
ALTER TABLE "AuditLog" ADD COLUMN "archivedAt" TIMESTAMP(3);

CREATE INDEX "AuditLog_memberId_createdAt_idx" ON "AuditLog"("memberId", "createdAt");
CREATE INDEX "AuditLog_targetId_createdAt_idx" ON "AuditLog"("targetId", "createdAt");
CREATE INDEX "AuditLog_actorMemberId_createdAt_idx" ON "AuditLog"("actorMemberId", "createdAt");
CREATE INDEX "AuditLog_subjectMemberId_createdAt_idx" ON "AuditLog"("subjectMemberId", "createdAt");
CREATE INDEX "AuditLog_entityType_entityId_idx" ON "AuditLog"("entityType", "entityId");
CREATE INDEX "AuditLog_category_createdAt_idx" ON "AuditLog"("category", "createdAt");
CREATE INDEX "AuditLog_expiresAt_idx" ON "AuditLog"("expiresAt");
CREATE INDEX "AuditLog_retentionClass_expiresAt_idx" ON "AuditLog"("retentionClass", "expiresAt");
CREATE INDEX "AuditLog_archivedAt_idx" ON "AuditLog"("archivedAt");
