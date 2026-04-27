import { prisma } from "./prisma";
import { Prisma } from "@prisma/client";
import logger from "@/lib/logger";

export type AuditLogParams = {
  action: string;
  memberId?: string;
  targetId?: string;
  details?: string;
  ipAddress?: string;
};

type AuditLogClient = Prisma.TransactionClient | typeof prisma;

/**
 * Persist an audit record synchronously. Callers that need audit durability
 * should await this and, when relevant, pass the current transaction client.
 */
export async function createAuditLog(
  params: AuditLogParams,
  db: AuditLogClient = prisma
): Promise<void> {
  await db.auditLog.create({ data: params });
}

/**
 * Log a sensitive action for audit trail purposes.
 * Fire-and-forget: failures are logged but don't block the calling operation.
 */
export function logAudit(params: AuditLogParams): void {
  void createAuditLog(params)
    .catch((err) => {
      logger.error({ err }, "Failed to write audit log");
    });
}
