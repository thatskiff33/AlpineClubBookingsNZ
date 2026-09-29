import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockListFinanceSnapshots,
  mockBookingGuestNightAggregate,
  mockMemberSubscriptionCount,
  mockGetAccountMapping,
} = vi.hoisted(() => ({
  mockListFinanceSnapshots: vi.fn(),
  mockBookingGuestNightAggregate: vi.fn(),
  mockMemberSubscriptionCount: vi.fn(),
  mockGetAccountMapping: vi.fn(),
}));

vi.mock("@/lib/finance-sync-storage", () => ({
  DEFAULT_FINANCE_SNAPSHOT_SCOPE: "default",
  listFinanceSnapshots: mockListFinanceSnapshots,
}));

vi.mock("@/lib/finance-booking-metrics", () => ({
  FINANCE_REALIZED_BOOKING_STATUSES: ["CONFIRMED", "PAID", "COMPLETED"],
}));

vi.mock("@/lib/xero-mappings", () => ({
  getAccountMapping: mockGetAccountMapping,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    bookingGuestNight: { aggregate: mockBookingGuestNightAggregate },
    memberSubscription: { count: mockMemberSubscriptionCount },
  },
}));

const ACCOUNT_CODE_DEFAULTS: Record<string, string> = {
  hutFeesIncome: "200",
  subscriptionIncome: "203",
};

import { buildFinanceRevenueReconciliation } from "@/lib/finance-revenue-reconciliation";
import { CLUB_FORMAT_TEST } from "@/lib/__tests__/support/club-format-fixture";

function incomePayload(lineItems: Array<[string, string]>, total: string) {
  return {
    reportDate: "2026-04-30",
    reportTitles: ["Profit and Loss", "For the month ended 30 April 2026"],
    fields: [{ fieldId: "period", description: "Period", value: "April 2026" }],
    rows: [
      {
        rowType: "Section",
        title: "Income",
        cells: [],
        rows: [
          ...lineItems.map(([label, amount]) => ({
            rowType: "Row",
            title: null,
            cells: [{ value: label }, { value: amount }],
            rows: [],
          })),
          {
            rowType: "SummaryRow",
            title: null,
            cells: [{ value: "Total Income" }, { value: total }],
            rows: [],
          },
        ],
      },
    ],
  };
}

function pnlSnapshot(payload: unknown) {
  return {
    id: "snap-1",
    snapshotType: "PROFIT_AND_LOSS_MONTHLY",
    scope: "default",
    asOfDate: new Date("2026-04-30T00:00:00.000Z"),
    periodStart: new Date("2026-04-01T00:00:00.000Z"),
    periodEnd: new Date("2026-04-30T00:00:00.000Z"),
    rowCount: 3,
    currency: "NZD",
    sourceUpdatedAt: new Date("2026-04-30T08:00:00.000Z"),
    payload,
    syncRunId: "run-1",
    createdAt: new Date("2026-04-30T08:00:00.000Z"),
    updatedAt: new Date("2026-04-30T08:00:00.000Z"),
  };
}

/** Income payload whose line rows carry a Xero account-id cell attribute. */
function incomePayloadWithAccounts(
  lineItems: Array<[string, string, string | null]>,
  total: string
) {
  return {
    reportDate: "2026-04-30",
    reportTitles: ["Profit and Loss", "For the month ended 30 April 2026"],
    fields: [{ fieldId: "period", description: "Period", value: "April 2026" }],
    rows: [
      {
        rowType: "Section",
        title: "Income",
        cells: [],
        rows: [
          ...lineItems.map(([label, amount, accountId]) => ({
            rowType: "Row",
            title: null,
            cells: [
              {
                value: label,
                attributes: accountId
                  ? [{ id: "account", value: accountId }]
                  : [],
              },
              { value: amount },
            ],
            rows: [],
          })),
          {
            rowType: "SummaryRow",
            title: null,
            cells: [{ value: "Total Income" }, { value: total }],
            rows: [],
          },
        ],
      },
    ],
  };
}

/** A CHART_OF_ACCOUNTS snapshot mapping AccountID -> GL code. */
function chartSnapshot(accounts: Array<{ accountId: string; code: string }>) {
  return {
    id: "chart-1",
    snapshotType: "CHART_OF_ACCOUNTS",
    scope: "default",
    asOfDate: new Date("2026-04-30T00:00:00.000Z"),
    periodStart: null,
    periodEnd: new Date("2026-04-30T00:00:00.000Z"),
    rowCount: accounts.length,
    currency: null,
    sourceUpdatedAt: new Date("2026-04-30T08:00:00.000Z"),
    payload: { accountCount: accounts.length, accounts },
    syncRunId: "run-1",
    createdAt: new Date("2026-04-30T08:00:00.000Z"),
    updatedAt: new Date("2026-04-30T08:00:00.000Z"),
  };
}

/** Aggregate mock that returns the member sum when filtered on isMember. */
function mockHutFees(totalCents: number, memberCents: number) {
  mockBookingGuestNightAggregate.mockImplementation(async (args: any) => {
    const isMember = args?.where?.bookingGuest?.isMember === true;
    return { _sum: { priceCents: isMember ? memberCents : totalCents } };
  });
}

describe("finance revenue reconciliation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockMemberSubscriptionCount.mockResolvedValue(12);
    mockGetAccountMapping.mockImplementation(
      async (key: string) => ACCOUNT_CODE_DEFAULTS[key] ?? null
    );
  });

  it("ties when booking hut fees match the Xero hut-fee income line", async () => {
    mockListFinanceSnapshots.mockResolvedValue([
      pnlSnapshot(
        incomePayload(
          [
            ["Hut Fees", "10,000.00"],
            ["Membership Subscriptions", "5,000.00"],
          ],
          "15,000.00"
        )
      ),
    ]);
    mockHutFees(1_000_000, 600_000);

    const result = await buildFinanceRevenueReconciliation(CLUB_FORMAT_TEST, {
      now: new Date("2026-04-30T10:00:00.000Z"),
    });

    expect(result.overallStatus).toBe("TIES");
    expect(result.periods).toHaveLength(1);
    const period = result.periods[0];
    expect(period.periodLabel).toBe("April 2026");
    expect(period.xeroHutFeesIncomeCents).toBe(1_000_000);
    expect(period.xeroSubscriptionIncomeCents).toBe(500_000);
    expect(period.xeroTotalIncomeCents).toBe(1_500_000);
    expect(period.bookingHutFeesCents).toBe(1_000_000);
    expect(period.bookingMemberHutFeesCents).toBe(600_000);
    expect(period.bookingNonMemberHutFeesCents).toBe(400_000);
    expect(period.paidSubscriptionCount).toBe(12);
    expect(period.varianceCents).toBe(0);
    expect(period.status).toBe("TIES");
  });

  it("flags a material variance as not tying", async () => {
    mockListFinanceSnapshots.mockResolvedValue([
      pnlSnapshot(incomePayload([["Hut Fees", "10,000.00"]], "10,000.00")),
    ]);
    mockHutFees(800_000, 500_000);

    const result = await buildFinanceRevenueReconciliation(CLUB_FORMAT_TEST, {
      now: new Date("2026-04-30T10:00:00.000Z"),
    });

    const period = result.periods[0];
    expect(period.varianceCents).toBe(200_000);
    expect(period.status).toBe("DOES_NOT_TIE");
    expect(result.overallStatus).toBe("DOES_NOT_TIE");
  });

  it("stays within tolerance for small timing differences", async () => {
    mockListFinanceSnapshots.mockResolvedValue([
      pnlSnapshot(incomePayload([["Hut Fees", "10,000.00"]], "10,000.00")),
    ]);
    // $40 gap, under the $50 / 1% tolerance.
    mockHutFees(996_000, 500_000);

    const result = await buildFinanceRevenueReconciliation(CLUB_FORMAT_TEST, {
      now: new Date("2026-04-30T10:00:00.000Z"),
    });

    expect(result.periods[0].varianceCents).toBe(4_000);
    expect(result.periods[0].status).toBe("TIES");
  });

  it("reports Xero unavailable when no hut-fee income line can be identified", async () => {
    mockListFinanceSnapshots.mockResolvedValue([
      pnlSnapshot(incomePayload([["Sundry Sales", "10,000.00"]], "10,000.00")),
    ]);
    mockHutFees(1_000_000, 600_000);

    const result = await buildFinanceRevenueReconciliation(CLUB_FORMAT_TEST, {
      now: new Date("2026-04-30T10:00:00.000Z"),
    });

    const period = result.periods[0];
    expect(period.xeroHutFeesIncomeCents).toBeNull();
    expect(period.varianceCents).toBeNull();
    expect(period.status).toBe("XERO_UNAVAILABLE");
    // Booking-system figures are still reported for context.
    expect(period.bookingHutFeesCents).toBe(1_000_000);
    expect(result.overallStatus).toBe("XERO_UNAVAILABLE");
  });

  it("returns no periods when there are no profit-and-loss snapshots", async () => {
    mockListFinanceSnapshots.mockResolvedValue([]);

    const result = await buildFinanceRevenueReconciliation(CLUB_FORMAT_TEST, {
      now: new Date("2026-04-30T10:00:00.000Z"),
    });

    expect(result.periods).toHaveLength(0);
    expect(result.overallStatus).toBe("XERO_UNAVAILABLE");
  });

  it("keeps the latest snapshot per calendar month", async () => {
    mockListFinanceSnapshots.mockResolvedValue([
      {
        ...pnlSnapshot(incomePayload([["Hut Fees", "10,000.00"]], "10,000.00")),
        id: "snap-apr-30",
        asOfDate: new Date("2026-04-30T00:00:00.000Z"),
      },
      {
        ...pnlSnapshot(incomePayload([["Hut Fees", "9,000.00"]], "9,000.00")),
        id: "snap-apr-29",
        asOfDate: new Date("2026-04-29T00:00:00.000Z"),
      },
    ]);
    mockHutFees(1_000_000, 600_000);

    const result = await buildFinanceRevenueReconciliation(CLUB_FORMAT_TEST, {
      now: new Date("2026-04-30T10:00:00.000Z"),
    });

    // Both snapshots are April 2026; only the newest (30th) is kept.
    expect(result.periods).toHaveLength(1);
    expect(result.periods[0].xeroHutFeesIncomeCents).toBe(1_000_000);
  });

  it("matches hut-fee and subscription income by GL code when the chart of accounts is available", async () => {
    mockListFinanceSnapshots.mockImplementation(async (args?: { snapshotType?: string }) => {
      if (args?.snapshotType === "CHART_OF_ACCOUNTS") {
        return [
          chartSnapshot([
            { accountId: "acc-hut", code: "200" },
            { accountId: "acc-subs", code: "203" },
            { accountId: "acc-subs-reversal", code: "204" },
          ]),
        ];
      }
      return [
        pnlSnapshot(
          incomePayloadWithAccounts(
            [
              ["Hut Fees", "5,000.00", "acc-hut"],
              ["Annual Subs", "300.00", "acc-subs"],
              [
                "Annual Subs Reversal - Cancelled Memberships",
                "-600.00",
                "acc-subs-reversal",
              ],
            ],
            "4,700.00"
          )
        ),
      ];
    });
    mockHutFees(500_000, 300_000);

    const result = await buildFinanceRevenueReconciliation(CLUB_FORMAT_TEST, {
      now: new Date("2026-04-30T10:00:00.000Z"),
    });

    const period = result.periods[0];
    expect(period.incomeMatchStrategy).toBe("GL_CODE");
    expect(mockGetAccountMapping).toHaveBeenCalledWith("hutFeesIncome");
    expect(mockGetAccountMapping).toHaveBeenCalledWith("subscriptionIncome");
    // Hut fees: only the GL code 200 account.
    expect(period.xeroHutFeesIncomeCents).toBe(500_000);
    // Subscription income: only the GL code 203 account ("Annual Subs"), NOT the
    // separate reversal account (code 204). Label matching would have done the
    // opposite — see the fallback test below.
    expect(period.xeroSubscriptionIncomeCents).toBe(30_000);
    expect(period.varianceCents).toBe(0);
    expect(period.status).toBe("TIES");
  });

  it("falls back to label matching when no chart-of-accounts snapshot is available", async () => {
    mockListFinanceSnapshots.mockImplementation(async (args?: { snapshotType?: string }) => {
      if (args?.snapshotType === "CHART_OF_ACCOUNTS") {
        return [];
      }
      return [
        pnlSnapshot(
          incomePayloadWithAccounts(
            [
              ["Hut Fees", "5,000.00", "acc-hut"],
              ["Annual Subs", "300.00", "acc-subs"],
              [
                "Annual Subs Reversal - Cancelled Memberships",
                "-600.00",
                "acc-subs-reversal",
              ],
            ],
            "4,700.00"
          )
        ),
      ];
    });
    mockHutFees(500_000, 300_000);

    const result = await buildFinanceRevenueReconciliation(CLUB_FORMAT_TEST, {
      now: new Date("2026-04-30T10:00:00.000Z"),
    });

    const period = result.periods[0];
    expect(period.incomeMatchStrategy).toBe("LABEL");
    // "Hut Fees" still matches the hut-fee keyword.
    expect(period.xeroHutFeesIncomeCents).toBe(500_000);
    // But only the reversal line matches the subscription keywords ("membership");
    // "Annual Subs" is missed. This brittleness is why GL-code matching is preferred.
    expect(period.xeroSubscriptionIncomeCents).toBe(-60_000);
    expect(mockGetAccountMapping).not.toHaveBeenCalled();
  });
});
