import { Prisma } from "@prisma/client";
import { prisma } from "./prisma";
import logger from "@/lib/logger";

type AuditLogParams = {
  action: string;
  memberId?: string;
  targetId?: string;
  details?: string;
  ipAddress?: string;
};

export async function createAuditLog(
  params: AuditLogParams,
  tx?: Prisma.TransactionClient
) {
  const db = tx ?? prisma;
  return db.auditLog.create({ data: params });
}

/**
 * Log a sensitive action for audit trail purposes.
 * Fire-and-forget: failures are logged but don't block the calling operation.
 */
export function logAudit(params: AuditLogParams): void {
  createAuditLog(params)
    .catch((err) => {
      logger.error({ err }, "Failed to write audit log");
    });
}
