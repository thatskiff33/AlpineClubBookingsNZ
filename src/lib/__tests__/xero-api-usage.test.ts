import { beforeEach, describe, expect, it, vi } from "vitest"

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    $transaction: vi.fn(),
    xeroApiUsageEvent: {
      create: vi.fn(),
      findMany: vi.fn(),
    },
    xeroApiUsageDaily: {
      upsert: vi.fn(),
      findUnique: vi.fn(),
    },
  },
}))

vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }))
vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}))

import { getTodaysXeroUsageSummary, recordXeroApiUsage } from "@/lib/xero-api-usage"

describe("xero-api-usage", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPrisma.$transaction.mockResolvedValue([])
  })

  it("persists an event row and updates the daily aggregate", async () => {
    mockPrisma.xeroApiUsageEvent.create.mockReturnValue({ kind: "event-create" })
    mockPrisma.xeroApiUsageDaily.upsert.mockReturnValue({ kind: "daily-upsert" })

    await recordXeroApiUsage({
      operation: "getContacts",
      resourceType: "CONTACT",
      workflow: "syncContactsFromXero",
      success: true,
      rateLimitCategory: "minute",
      statusCode: 200,
      durationMs: 123,
    })

    expect(mockPrisma.xeroApiUsageEvent.create).toHaveBeenCalledTimes(1)
    expect(mockPrisma.xeroApiUsageDaily.upsert).toHaveBeenCalledTimes(1)
    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1)
  })

  it("builds a summary with top operations, workflows, and failures", async () => {
    mockPrisma.xeroApiUsageDaily.findUnique.mockResolvedValue({
      totalCalls: 12,
      successfulCalls: 10,
      failedCalls: 2,
      dayRateLimitHits: 1,
      minuteRateLimitHits: 2,
      lastRateLimitCategory: "day",
      lastRateLimitAt: new Date("2026-04-14T10:00:00.000Z"),
    })
    mockPrisma.xeroApiUsageEvent.findMany.mockResolvedValue([
      {
        id: "evt-3",
        operation: "getInvoices",
        workflow: "checkMembershipStatus",
        resourceType: "INVOICE",
        success: false,
        rateLimitCategory: "day",
        statusCode: 429,
        errorMessage: "Daily limit reached",
        createdAt: new Date("2026-04-14T10:00:00.000Z"),
      },
      {
        id: "evt-2",
        operation: "getContacts",
        workflow: "syncContactsFromXero",
        resourceType: "CONTACT",
        success: true,
        rateLimitCategory: null,
        statusCode: 200,
        errorMessage: null,
        createdAt: new Date("2026-04-14T09:30:00.000Z"),
      },
      {
        id: "evt-1",
        operation: "getContacts",
        workflow: "syncContactsFromXero",
        resourceType: "CONTACT",
        success: true,
        rateLimitCategory: null,
        statusCode: 200,
        errorMessage: null,
        createdAt: new Date("2026-04-14T09:00:00.000Z"),
      },
    ])

    const summary = await getTodaysXeroUsageSummary()

    expect(summary.today.totalCalls).toBe(12)
    expect(summary.today.budgetStatus).toBe("healthy")
    expect(summary.byOperation[0]).toMatchObject({
      label: "getContacts",
      count: 2,
      successCount: 2,
      failureCount: 0,
    })
    expect(summary.topWorkflows[0]).toMatchObject({
      label: "syncContactsFromXero",
      count: 2,
    })
    expect(summary.recentFailures[0]).toMatchObject({
      id: "evt-3",
      operation: "getInvoices",
      rateLimitCategory: "day",
    })
    expect(summary.lastDailyLimitEvent?.id).toBe("evt-3")
  })
})
