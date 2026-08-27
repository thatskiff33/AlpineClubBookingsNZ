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

/**
 * The CLUB's persisted zone (CT-5, #2869), pinned to something that is neither
 * this runner's nor the documented fallback so the daily bucket cannot look
 * right by coincidence.
 */
const CLUB_TIME_ZONE = "Pacific/Chatham"

vi.mock("@/lib/club-time-zone-runtime", () => ({
  readClubTimeZoneOutsideRequest: vi.fn(async () => CLUB_TIME_ZONE),
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

  it("buckets a call on the CLUB's calendar day, as a date-only encoding", async () => {
    /*
      TWO DEFECTS IN ONE LINE, both fixed here (CT-5, #2869 review).

      `usageDate` was `new Date(d.getFullYear(), d.getMonth(), d.getDate())` —
      the HOST's calendar components at host-LOCAL midnight. The zone was the
      container's rather than the club's, so a redeployed container re-bucketed
      the day; and a local-midnight instant is not a date-only encoding, so for
      any club east of Greenwich the `@db.Date` column took its UTC date part
      and labelled the bucket a day EARLY.

      The fixture is 2026-08-22 12:00 UTC, which is already the 23rd in
      Pacific/Chatham (+12:45) and still the 22nd in UTC and in the Americas —
      so a regression to either the host zone or a UTC truncation shows up as a
      different day rather than as the same one.
    */
    mockPrisma.xeroApiUsageEvent.create.mockReturnValue({ kind: "event-create" })
    mockPrisma.xeroApiUsageDaily.upsert.mockReturnValue({ kind: "daily-upsert" })

    await recordXeroApiUsage({
      operation: "getContacts",
      resourceType: "CONTACT",
      success: true,
      createdAt: new Date("2026-08-22T12:00:00.000Z"),
    })

    const written = mockPrisma.xeroApiUsageEvent.create.mock.calls[0][0] as {
      data: { usageDate: Date }
    }
    expect(written.data.usageDate.toISOString()).toBe(
      "2026-08-23T00:00:00.000Z",
    )
  })

  it("redacts sensitive values before persisting failure messages", async () => {
    mockPrisma.xeroApiUsageEvent.create.mockReturnValue({ kind: "event-create" })
    mockPrisma.xeroApiUsageDaily.upsert.mockReturnValue({ kind: "daily-upsert" })

    await recordXeroApiUsage({
      operation: "getInvoices",
      resourceType: "INVOICE",
      success: false,
      errorMessage:
        "Xero failed with refresh_token=live-refresh and pi_123_secret_liveSecret",
    })

    expect(mockPrisma.xeroApiUsageEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        errorMessage:
          "Xero failed with refresh_token=[REDACTED] and [REDACTED]",
      }),
    })
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
