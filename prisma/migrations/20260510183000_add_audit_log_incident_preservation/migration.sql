ALTER TABLE "AuditLog"
ADD COLUMN "incidentPreserved" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX "AuditLog_incidentPreserved_createdAt_idx"
ON "AuditLog"("incidentPreserved", "createdAt");

CREATE INDEX "AuditLog_retentionClass_archivedAt_createdAt_idx"
ON "AuditLog"("retentionClass", "archivedAt", "createdAt");
