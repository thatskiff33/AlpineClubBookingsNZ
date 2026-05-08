import { prisma } from "@/lib/prisma";
import logger from "@/lib/logger";

export type EmailSuppressionReason = "BOUNCE" | "COMPLAINT";

export type SesEmailFeedbackEvent = {
  email: string;
  reason: EmailSuppressionReason;
  eventType: "bounce" | "complaint";
  sesMessageId?: string | null;
  bounceType?: string | null;
  bounceSubType?: string | null;
  complaintFeedbackType?: string | null;
};

export type ActiveEmailSuppression = {
  id: string;
  email: string;
  reason: EmailSuppressionReason;
  eventCount: number;
  suppressedAt: Date | null;
  lastEventAt: Date;
  lastEventType: string;
  lastBounceType: string | null;
  lastBounceSubType: string | null;
  lastComplaintFeedbackType: string | null;
  lastSesMessageId: string | null;
};

const TRANSIENT_BOUNCE_SUPPRESSION_THRESHOLD = 2;

export function normalizeEmailAddress(email: string) {
  return email.trim().toLowerCase();
}

function shouldSuppressFeedbackEvent(
  event: SesEmailFeedbackEvent,
  nextEventCount: number
) {
  if (event.reason === "COMPLAINT") {
    return true;
  }

  if (event.bounceType?.toLowerCase() === "permanent") {
    return true;
  }

  return nextEventCount >= TRANSIENT_BOUNCE_SUPPRESSION_THRESHOLD;
}

export async function getActiveEmailSuppression(email: string) {
  const normalizedEmail = normalizeEmailAddress(email);
  if (!normalizedEmail) {
    return null;
  }

  return prisma.emailSuppression.findFirst({
    where: {
      email: normalizedEmail,
      suppressedAt: { not: null },
      clearedAt: null,
    },
  });
}

export async function recordSesEmailFeedback(events: SesEmailFeedbackEvent[]) {
  const now = new Date();
  const uniqueEvents = new Map<string, SesEmailFeedbackEvent>();

  for (const event of events) {
    const email = normalizeEmailAddress(event.email);
    if (!email) {
      continue;
    }
    uniqueEvents.set(email, { ...event, email });
  }

  let suppressed = 0;

  for (const event of uniqueEvents.values()) {
    const existing = await prisma.emailSuppression.findUnique({
      where: { email: event.email },
    });
    const nextEventCount = (existing?.eventCount ?? 0) + 1;
    const suppressNow = shouldSuppressFeedbackEvent(event, nextEventCount);
    const suppressedAt = suppressNow
      ? existing?.suppressedAt ?? now
      : existing?.suppressedAt ?? null;

    if (suppressNow) {
      suppressed++;
    }

    const data = {
      reason: event.reason,
      eventCount: nextEventCount,
      suppressedAt,
      lastEventAt: now,
      lastEventType: event.eventType,
      lastBounceType: event.bounceType ?? null,
      lastBounceSubType: event.bounceSubType ?? null,
      lastComplaintFeedbackType: event.complaintFeedbackType ?? null,
      lastSesMessageId: event.sesMessageId ?? null,
      clearedAt: suppressNow ? null : existing?.clearedAt ?? null,
      clearedById: suppressNow ? null : existing?.clearedById ?? null,
      clearReason: suppressNow ? null : existing?.clearReason ?? null,
    };

    if (existing) {
      await prisma.emailSuppression.update({
        where: { email: event.email },
        data,
      });
    } else {
      await prisma.emailSuppression.create({
        data: {
          email: event.email,
          ...data,
        },
      });
    }
  }

  return {
    processed: uniqueEvents.size,
    suppressed,
  };
}

export async function getEmailDeliverabilityTelemetry() {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const activeWhere = {
    suppressedAt: { not: null },
    clearedAt: null,
  };

  const [
    activeCount,
    bounceCount,
    complaintCount,
    eventsLast24h,
    suppressions,
  ] = await Promise.all([
    prisma.emailSuppression.count({ where: activeWhere }),
    prisma.emailSuppression.count({
      where: { ...activeWhere, reason: "BOUNCE" },
    }),
    prisma.emailSuppression.count({
      where: { ...activeWhere, reason: "COMPLAINT" },
    }),
    prisma.emailSuppression.count({
      where: { lastEventAt: { gte: since } },
    }),
    prisma.emailSuppression.findMany({
      where: activeWhere,
      orderBy: [{ lastEventAt: "desc" }, { email: "asc" }],
      take: 50,
    }),
  ]);

  return {
    summary: {
      activeCount,
      bounceCount,
      complaintCount,
      eventsLast24h,
    },
    suppressions: suppressions.map((suppression) => ({
      id: suppression.id,
      email: suppression.email,
      reason: suppression.reason,
      eventCount: suppression.eventCount,
      suppressedAt: suppression.suppressedAt?.toISOString() ?? null,
      lastEventAt: suppression.lastEventAt.toISOString(),
      lastEventType: suppression.lastEventType,
      lastBounceType: suppression.lastBounceType,
      lastBounceSubType: suppression.lastBounceSubType,
      lastComplaintFeedbackType: suppression.lastComplaintFeedbackType,
      lastSesMessageId: suppression.lastSesMessageId,
    })),
  };
}

export async function clearEmailSuppression({
  id,
  clearedById,
  clearReason,
}: {
  id: string;
  clearedById: string;
  clearReason?: string | null;
}) {
  const suppression = await prisma.emailSuppression.update({
    where: { id },
    data: {
      clearedAt: new Date(),
      clearedById,
      clearReason: clearReason?.trim() || null,
    },
  });

  logger.info(
    {
      emailSuppressionId: suppression.id,
      email: suppression.email,
      clearedById,
    },
    "Cleared email suppression"
  );

  return suppression;
}
