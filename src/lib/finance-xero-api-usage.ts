import { prisma } from "@/lib/prisma";
import logger from "@/lib/logger";

export const FINANCE_XERO_DAILY_BUDGET = 1000;
const XERO_WARNING_THRESHOLDS = [0.7, 0.85, 0.95] as const;

export type FinanceXeroRateLimitCategory = "day" | "minute" | "unknown" | null;

interface RecordFinanceXeroApiUsageInput {
  operation: string;
  resourceType: string;
  workflow?: string;
  success: boolean;
  rateLimitCategory?: FinanceXeroRateLimitCategory;
  statusCode?: number | null;
  durationMs?: number | null;
  errorMessage?: string | null;
  createdAt?: Date;
}

interface UsageBucket {
  label: string;
  count: number;
  successCount: number;
  failureCount: number;
}

function startOfLocalDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function getUsageStatus(totalCalls: number): "healthy" | "warning" | "critical" | "exhausted" {
  const percent = totalCalls / FINANCE_XERO_DAILY_BUDGET;
  if (percent >= XERO_WARNING_THRESHOLDS[2]) return "exhausted";
  if (percent >= XERO_WARNING_THRESHOLDS[1]) return "critical";
  if (percent >= XERO_WARNING_THRESHOLDS[0]) return "warning";
  return "healthy";
}

function truncateErrorMessage(errorMessage?: string | null): string | null {
  if (!errorMessage) {
    return null;
  }

  return errorMessage.length > 500 ? `${errorMessage.slice(0, 497)}...` : errorMessage;
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

export async function recordFinanceXeroApiUsage(
  input: RecordFinanceXeroApiUsageInput
): Promise<void> {
  const createdAt = input.createdAt ?? new Date();
  const usageDate = startOfLocalDay(createdAt);
  const rateLimitCategory = input.rateLimitCategory ?? null;

  try {
    await prisma.$transaction([
      prisma.financeXeroApiUsageEvent.create({
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
      prisma.financeXeroApiUsageDaily.upsert({
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
      "Failed to persist finance Xero API usage metrics"
    );
  }
}

export async function getTodaysFinanceXeroUsageSummary() {
  const usageDate = startOfLocalDay(new Date());
  const last24HoursStart = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const [daily, events] = await Promise.all([
    prisma.financeXeroApiUsageDaily.findUnique({
      where: { usageDate },
    }),
    prisma.financeXeroApiUsageEvent.findMany({
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
    usagePercent: totalCalls / FINANCE_XERO_DAILY_BUDGET,
    budgetStatus: getUsageStatus(totalCalls),
  };

  return {
    budget: {
      limit: FINANCE_XERO_DAILY_BUDGET,
      thresholds: XERO_WARNING_THRESHOLDS.map((fraction) => ({
        fraction,
        callCount: Math.round(FINANCE_XERO_DAILY_BUDGET * fraction),
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
