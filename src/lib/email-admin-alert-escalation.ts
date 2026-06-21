import { createAuditLog } from "@/lib/audit";
import { prisma } from "@/lib/prisma";

export const ADMIN_ALERT_DELIVERY_ESCALATION_ACTION =
  "email.admin-alert-undeliverable";

const ADMIN_ALERT_ESCALATION_LOOKBACK_DAYS = 7;
const MAX_ADMIN_ALERT_ESCALATIONS = 50;

export type AdminAlertRecipientDeliveryStatus =
  | "sent"
  | "suppressed"
  | "failed";

export interface AdminAlertRecipientDeliveryOutcome {
  status: AdminAlertRecipientDeliveryStatus;
}

export interface AdminAlertDeliveryEscalation {
  id: string;
  templateName: string;
  preferenceKey: string;
  attemptedRecipientCount: number;
  suppressedRecipientCount: number;
  failedRecipientCount: number;
  createdAt: string;
}

function countOutcomes(
  outcomes: AdminAlertRecipientDeliveryOutcome[],
  status: AdminAlertRecipientDeliveryStatus,
) {
  return outcomes.filter((outcome) => outcome.status === status).length;
}

function readMetadataString(metadata: unknown, key: string) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return "";
  }

  const value = (metadata as Record<string, unknown>)[key];
  return typeof value === "string" ? value : "";
}

function readMetadataNumber(metadata: unknown, key: string) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return 0;
  }

  const value = (metadata as Record<string, unknown>)[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export async function recordAdminAlertDeliveryEscalation({
  templateName,
  preferenceKey,
  outcomes,
}: {
  templateName: string;
  preferenceKey: string;
  outcomes: AdminAlertRecipientDeliveryOutcome[];
}) {
  const attemptedRecipientCount = outcomes.length;
  const suppressedRecipientCount = countOutcomes(outcomes, "suppressed");
  const failedRecipientCount = countOutcomes(outcomes, "failed");

  await createAuditLog({
    action: ADMIN_ALERT_DELIVERY_ESCALATION_ACTION,
    category: "communication",
    severity: "critical",
    outcome: "failure",
    entityType: "EmailLog",
    summary: `Admin alert delivery failed for ${templateName}`,
    details:
      "No opted-in admin recipient received an admin alert. Check Email Deliverability suppressions, SMTP configuration, and admin notification preferences.",
    metadata: {
      templateName,
      preferenceKey,
      attemptedRecipientCount,
      suppressedRecipientCount,
      failedRecipientCount,
    },
  });
}

export async function getAdminAlertDeliveryEscalations(limit = 10) {
  const boundedLimit = Math.min(Math.max(limit, 1), MAX_ADMIN_ALERT_ESCALATIONS);
  const since = new Date(
    Date.now() - ADMIN_ALERT_ESCALATION_LOOKBACK_DAYS * 24 * 60 * 60 * 1000,
  );

  const [recentCount, escalations] = await Promise.all([
    prisma.auditLog.count({
      where: {
        action: ADMIN_ALERT_DELIVERY_ESCALATION_ACTION,
        createdAt: { gte: since },
      },
    }),
    prisma.auditLog.findMany({
      where: {
        action: ADMIN_ALERT_DELIVERY_ESCALATION_ACTION,
        createdAt: { gte: since },
      },
      orderBy: { createdAt: "desc" },
      take: boundedLimit,
      select: {
        id: true,
        createdAt: true,
        metadata: true,
      },
    }),
  ]);

  return {
    summary: {
      recentCount,
      lookbackDays: ADMIN_ALERT_ESCALATION_LOOKBACK_DAYS,
    },
    escalations: escalations.map(
      (escalation): AdminAlertDeliveryEscalation => ({
        id: escalation.id,
        templateName: readMetadataString(escalation.metadata, "templateName"),
        preferenceKey: readMetadataString(escalation.metadata, "preferenceKey"),
        attemptedRecipientCount: readMetadataNumber(
          escalation.metadata,
          "attemptedRecipientCount",
        ),
        suppressedRecipientCount: readMetadataNumber(
          escalation.metadata,
          "suppressedRecipientCount",
        ),
        failedRecipientCount: readMetadataNumber(
          escalation.metadata,
          "failedRecipientCount",
        ),
        createdAt: escalation.createdAt.toISOString(),
      }),
    ),
  };
}
