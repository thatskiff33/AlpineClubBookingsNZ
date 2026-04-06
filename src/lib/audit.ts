import { prisma } from "./prisma";
import logger from "@/lib/logger";

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
      logger.error({ err }, "Failed to write audit log");
    });
}
