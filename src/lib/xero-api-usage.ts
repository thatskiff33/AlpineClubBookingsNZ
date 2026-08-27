import { prisma } from "@/lib/prisma";
import { clubCalendarDateOf, dateOnlyInstantOf } from "@/lib/club-time";
import { readClubTimeZoneOutsideRequest } from "@/lib/club-time-zone-runtime";
import logger from "@/lib/logger";
import { redactSensitiveText } from "@/lib/redact-sensitive-json";

const XERO_DAILY_BUDGET = 1000;
const XERO_WARNING_THRESHOLDS = [0.7, 0.85, 0.95] as const;

export type XeroRateLimitCategory = "day" | "minute" | "unknown" | null;

interface RecordXeroApiUsageInput {
  operation: string;
  resourceType: string;
  workflow?: string;
  success: boolean;
  rateLimitCategory?: XeroRateLimitCategory;
  statusCode?: number | null;
  durationMs?: number | null;
  errorMessage?: string | null;
  createdAt?: Date;
}

type XeroApiUsagePrisma = typeof prisma & {
  xeroApiUsageEvent?: {
    create: (args: unknown) => unknown;
  };
  xeroApiUsageDaily?: {
    upsert: (args: unknown) => unknown;
    findUnique: (args: unknown) => unknown;
  };
};

interface UsageBucket {
  label: string;
  count: number;
  successCount: number;
  failureCount: number;
}

/**
 * The CLUB's calendar day for an instant, as the UTC-midnight encoding a
 * `@db.Date` column round-trips through (`INV-DATE-010`, CT-5 #2869).
 *
 * It used to be `new Date(d.getFullYear(), d.getMonth(), d.getDate())` — the
 * HOST's calendar components, at host-local midnight — and both halves of that
 * were wrong. The zone was the container's rather than the club's, so a
 * redeployed container re-bucketed the day; and a local-midnight instant is not
 * a date-only encoding, so for a club east of Greenwich Postgres took its UTC
 * date part and labelled the bucket a day early. Reads and writes agreed with
 * each other, which is why this only ever showed as an off-by-one LABEL on the
 * admin usage panel rather than as a lost count.
 *
 * Nothing gates on this figure — it is an operator display of Xero API calls
 * against a daily budget — so the change costs at most one day's bucket being
 * split across the deploy, and no migration.
 */
async function clubUsageDate(at: Date): Promise<Date> {
  const zone = await readClubTimeZoneOutsideRequest();
  return dateOnlyInstantOf(clubCalendarDateOf(at, zone));
}

function getUsageStatus(totalCalls: number): "healthy" | "warning" | "critical" | "exhausted" {
  const percent = totalCalls / XERO_DAILY_BUDGET;
  if (percent >= XERO_WARNING_THRESHOLDS[2]) return "exhausted";
  if (percent >= XERO_WARNING_THRESHOLDS[1]) return "critical";
  if (percent >= XERO_WARNING_THRESHOLDS[0]) return "warning";
  return "healthy";
}

function truncateErrorMessage(errorMessage?: string | null): string | null {
  if (!errorMessage) {
    return null;
  }

  const redacted = redactSensitiveText(errorMessage);
  return redacted.length > 500 ? `${redacted.slice(0, 497)}...` : redacted;
}

function buildUsageBuckets(
  events: Array<{
    operation: string;
    workflow: string | null;
    success: boolean;
  }>,
  keySelector: (event: { operation: string; workflow: string | null }) => string
): UsageBucket[] {
  const buckets = new Map<string, UsageBucket>();

  for (const event of events) {
    const label = keySelector(event);
    const existing = buckets.get(label) ?? {
      label,
      count: 0,
      successCount: 0,
      failureCount: 0,
    };

    existing.count += 1;
    if (event.success) {
      existing.successCount += 1;
    } else {
      existing.failureCount += 1;
    }

    buckets.set(label, existing);
  }

  return Array.from(buckets.values())
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
    .slice(0, 5);
}

export async function recordXeroApiUsage(input: RecordXeroApiUsageInput): Promise<void> {
  const createdAt = input.createdAt ?? new Date();
  const rateLimitCategory = input.rateLimitCategory ?? null;
  const usagePrisma = prisma as XeroApiUsagePrisma;

  if (!usagePrisma.xeroApiUsageEvent || !usagePrisma.xeroApiUsageDaily) {
    return;
  }

  // Read AFTER the delegate check, so a deployment whose Prisma client predates
  // these tables does not pay for a zone lookup it will not use.
  const usageDate = await clubUsageDate(createdAt);

  try {
    await prisma.$transaction([
      usagePrisma.xeroApiUsageEvent.create({
        data: {
          usageDate,
          operation: input.operation,
          resourceType: input.resourceType,
          workflow: input.workflow ?? null,
          success: input.success,
          rateLimitCategory,
          statusCode: input.statusCode ?? null,
          durationMs: input.durationMs ?? null,
          errorMessage: truncateErrorMessage(input.errorMessage),
          createdAt,
        },
      }),
      usagePrisma.xeroApiUsageDaily.upsert({
        where: { usageDate },
        create: {
          usageDate,
          totalCalls: 1,
          successfulCalls: input.success ? 1 : 0,
          failedCalls: input.success ? 0 : 1,
          dayRateLimitHits: rateLimitCategory === "day" ? 1 : 0,
          minuteRateLimitHits: rateLimitCategory === "minute" ? 1 : 0,
          lastRateLimitCategory: rateLimitCategory,
          lastRateLimitAt: rateLimitCategory ? createdAt : null,
        },
        update: {
          totalCalls: { increment: 1 },
          successfulCalls: { increment: input.success ? 1 : 0 },
          failedCalls: { increment: input.success ? 0 : 1 },
          dayRateLimitHits: { increment: rateLimitCategory === "day" ? 1 : 0 },
          minuteRateLimitHits: { increment: rateLimitCategory === "minute" ? 1 : 0 },
          ...(rateLimitCategory
            ? {
                lastRateLimitCategory: rateLimitCategory,
                lastRateLimitAt: createdAt,
              }
            : {}),
        },
      }),
    ]);
  } catch (err) {
    logger.error(
      { err, operation: input.operation, resourceType: input.resourceType },
      "Failed to persist Xero API usage metrics"
    );
  }
}

/**
 * The errorMessage of the most recent FAILED recorded Xero API call, or null
 * when none is recorded. Already redaction-truncated at write time
 * (truncateErrorMessage); callers surfacing it to a browser should still pass
 * it through the redaction helper again defensively (#2105).
 */
export async function getLatestXeroUsageErrorMessage(): Promise<string | null> {
  const usagePrisma = prisma as XeroApiUsagePrisma & {
    xeroApiUsageEvent?: { findFirst?: (args: unknown) => unknown };
  };
  if (!usagePrisma.xeroApiUsageEvent?.findFirst) {
    return null;
  }
  const latest = (await prisma.xeroApiUsageEvent.findFirst({
    where: { success: false, errorMessage: { not: null } },
    orderBy: { createdAt: "desc" },
    select: { errorMessage: true },
  })) as { errorMessage: string | null } | null;
  return latest?.errorMessage ?? null;
}

export async function getTodaysXeroUsageSummary() {
  const usageDate = await clubUsageDate(new Date());
  const last24HoursStart = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const [daily, events] = await Promise.all([
    prisma.xeroApiUsageDaily.findUnique({
      where: { usageDate },
    }),
    prisma.xeroApiUsageEvent.findMany({
      where: {
        createdAt: {
          gte: last24HoursStart,
        },
      },
      orderBy: { createdAt: "desc" },
      take: 2000,
    }),
  ]);

  const totalCalls = daily?.totalCalls ?? 0;
  const today = {
    usageDate,
    totalCalls,
    successfulCalls: daily?.successfulCalls ?? 0,
    failedCalls: daily?.failedCalls ?? 0,
    dayRateLimitHits: daily?.dayRateLimitHits ?? 0,
    minuteRateLimitHits: daily?.minuteRateLimitHits ?? 0,
    lastRateLimitCategory: daily?.lastRateLimitCategory ?? null,
    lastRateLimitAt: daily?.lastRateLimitAt ?? null,
    usagePercent: totalCalls / XERO_DAILY_BUDGET,
    budgetStatus: getUsageStatus(totalCalls),
  };

  return {
    budget: {
      limit: XERO_DAILY_BUDGET,
      thresholds: XERO_WARNING_THRESHOLDS.map((fraction) => ({
        fraction,
        callCount: Math.round(XERO_DAILY_BUDGET * fraction),
      })),
    },
    today,
    byOperation: buildUsageBuckets(events, (event) => event.operation),
    topWorkflows: buildUsageBuckets(events, (event) => event.workflow ?? event.operation),
    recentFailures: events
      .filter((event) => !event.success)
      .slice(0, 5)
      .map((event) => ({
        id: event.id,
        operation: event.operation,
        workflow: event.workflow,
        resourceType: event.resourceType,
        rateLimitCategory: event.rateLimitCategory,
        statusCode: event.statusCode,
        errorMessage: event.errorMessage,
        createdAt: event.createdAt,
      })),
    lastDailyLimitEvent:
      events.find((event) => event.rateLimitCategory === "day") ?? null,
  };
}
