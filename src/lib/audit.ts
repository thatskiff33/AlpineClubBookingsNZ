import { prisma } from "./prisma";

/**
 * Log a sensitive action for audit trail purposes.
 * Fire-and-forget: failures are logged but don't block the calling operation.
 */
export function logAudit(params: {
  action: string;
  memberId?: string;
  targetId?: string;
  details?: string;
  ipAddress?: string;
}): void {
  prisma.auditLog
    .create({ data: params })
    .catch((err) => {
      console.error("[audit] Failed to write audit log:", err);
    });
}
