import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { NextRequest } from "next/server";
import {
  BookingStatus,
  PaymentStatus,
  PaymentTransactionKind,
  type Prisma,
} from "@prisma/client";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { captureHostTimeZone } from "@/lib/__tests__/helpers/timezone";

const EXPECTED_REPORT_STATUS_VALUES = [
  "PENDING",
  "PAYMENT_PENDING",
  "CONFIRMED",
  "PAID",
  "AWAITING_REVIEW",
  "COMPLETED",
] as const;

const mockLodgeFindUnique = vi.fn();
const mockPrisma = {
  booking: { findMany: vi.fn() },
  member: { count: vi.fn() },
  memberSubscription: { count: vi.fn() },
  lodge: { findUnique: mockLodgeFindUnique },
  clubTimeSettings: { findUnique: vi.fn() },
};

const mockAuth = vi.fn();
const mockRequireActiveSessionUser = vi.fn();
const mockResolveMetricsCapacityAndScope = vi.fn(
  async (
    lodgeId?: string,
  ): Promise<{ capacity: number; bookingLodgeWhere: Prisma.BookingWhereInput }> => ({
    capacity: 29,
    bookingLodgeWhere: lodgeId ? { lodgeId } : {},
  }),
);
const mockLogger = {
  error: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
};

vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/auth", () => ({ auth: () => mockAuth() }));
vi.mock("@/lib/session-guards", async () => ({
  requireAdmin: (await import("./helpers/require-admin-mock"))
    .evaluateRequireAdminMock,
  requireActiveSessionUser: mockRequireActiveSessionUser,
}));
vi.mock("@/lib/logger", () => ({
  default: mockLogger,
}));
vi.mock("@/lib/finance-booking-metrics", () => ({
  resolveMetricsCapacityAndScope: mockResolveMetricsCapacityAndScope,
}));

const day = (value: string) => new Date(`${value}T00:00:00.000Z`);

function reportBooking(overrides: Record<string, unknown> = {}) {
  return {
    id: "booking-1",
    createdAt: new Date("2025-01-01T10:00:00.000Z"),
    checkIn: day("2026-04-07"),
    checkOut: day("2026-04-10"),
    finalPriceCents: 100,
    status: BookingStatus.PAID,
    guests: [
      {
        id: "guest-member",
        isMember: true,
        stayStart: day("2026-04-07"),
        stayEnd: day("2026-04-10"),
        nights: [],
      },
      {
        id: "guest-non-member",
        isMember: false,
        stayStart: day("2026-04-09"),
        stayEnd: day("2026-04-10"),
        nights: [],
      },
    ],
    payment: {
      status: PaymentStatus.SUCCEEDED,
      amountCents: 100,
      refundedAmountCents: 0,
      additionalAmountCents: 0,
      additionalPaymentStatus: null,
      transactions: [],
    },
    ...overrides,
  };
}

function zeroMemberQueries() {
  mockPrisma.member.count.mockResolvedValue(0);
  mockPrisma.memberSubscription.count.mockResolvedValue(0);
}

describe("admin reports route", () => {
  const hostTimeZone = captureHostTimeZone();

  beforeAll(() => {
    process.env.TZ = "Pacific/Auckland";
  });

  afterAll(() => {
    hostTimeZone.restore();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-13T12:00:00Z"));
    mockAuth.mockResolvedValue({
      user: { id: "admin-1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }] },
    });
    mockRequireActiveSessionUser.mockResolvedValue(null);
    mockResolveMetricsCapacityAndScope.mockImplementation(async (lodgeId?: string) => ({
      capacity: 29,
      bookingLodgeWhere: lodgeId ? { lodgeId } : {},
    }));
    zeroMemberQueries();
  });

  afterEach(() => vi.useRealTimers());

  it("selects a created-elsewhere booking by overlapping stay nights and slices cents after full allocation", async () => {
    mockPrisma.booking.findMany.mockResolvedValue([reportBooking()]);

    const { GET } = await import("@/app/api/admin/reports/route");
    const response = await GET(
      new NextRequest("http://localhost/api/admin/reports?from=2026-04-08&to=2026-04-08"),
    );
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.summary).toMatchObject({
      totalBookings: 1,
      totalRevenueCents: 33,
      netCollectedCents: 100,
      totalGuests: 1,
      memberGuests: 1,
      nonMemberGuests: 0,
    });
    expect(data.revenue[0]).toMatchObject({ revenueCents: 33, bookingCount: 1 });
    expect(data.statusBreakdown).toEqual({
      pending: 0,
      paymentPending: 0,
      confirmed: 0,
      paid: 1,
      awaitingReview: 0,
      completed: 0,
    });

    const query = mockPrisma.booking.findMany.mock.calls[0][0];
    expect(query.where).toEqual({
      deletedAt: null,
      checkIn: { lte: day("2026-04-08") },
      checkOut: { gt: day("2026-04-08") },
      status: { in: [...EXPECTED_REPORT_STATUS_VALUES] },
    });
    expect(query.where).not.toHaveProperty("createdAt");
    expect(query.include.payment.select).toEqual({
      status: true,
      amountCents: true,
      refundedAmountCents: true,
      additionalAmountCents: true,
      additionalPaymentStatus: true,
      transactions: {
        where: { kind: PaymentTransactionKind.ADDITIONAL },
        select: { kind: true, status: true, amountCents: true },
      },
    });
    expect(mockPrisma.booking.findMany).toHaveBeenCalledTimes(1);
  }, 15_000);

  it("counts new members from the two CALENDAR DAYS, not the club-day instants (#2872)", async () => {
    // `Member.joinedDate` became `DateTime @db.Date` in CT-3, and
    // `@prisma/adapter-pg` narrows a bound `Date` for such a column to its UTC
    // calendar date, throwing the time away. This route used to hand that filter
    // `startOfDateOnlyForTimeZone(from)` — club midnight, which under the club's
    // own Pacific/Auckland zone is 12:00 on the PREVIOUS UTC day — so after the
    // migration the lower bound would have narrowed to the day BEFORE the window
    // and counted a member who joined the day before the report as a new joiner.
    //
    // `Member.createdAt` in the very same OR is a real instant and must keep the
    // club-day moments, so the two arms are asserted together: one window, two
    // kinds of column, two encodings (INV-DATE-013).
    mockPrisma.booking.findMany.mockResolvedValue([]);

    const { GET } = await import("@/app/api/admin/reports/route");
    const response = await GET(
      new NextRequest("http://localhost/api/admin/reports?from=2026-04-08&to=2026-04-10"),
    );
    expect(response.status).toBe(200);

    const newMemberQuery = mockPrisma.member.count.mock.calls.at(-1)![0];
    expect(
      newMemberQuery.where.OR[0],
      "INV-DATE-026: the joinedDate arm must bind the two calendar days. A " +
        "club-midnight instant here narrows to the previous UTC day and the " +
        "new-member count starts a day early. That narrowing is 026's " +
        "corollary; INV-DATE-010 rules what the stored value means, not what a " +
        "bound against it has to be.",
    ).toEqual({
      joinedDate: { gte: day("2026-04-08"), lte: day("2026-04-10") },
    });
    expect(
      newMemberQuery.where.OR[1],
      "INV-DATE-019: the createdAt arm is a real instant and must keep the " +
        "club day's first and last MOMENT — 12:00Z on 7 April to 11:59:59.999Z " +
        "on 10 April under the Pacific/Auckland pin this suite sets.",
    ).toEqual({
      joinedDate: null,
      createdAt: {
        gte: new Date("2026-04-07T12:00:00.000Z"),
        lte: new Date("2026-04-10T11:59:59.999Z"),
      },
    });
  });

  it("enumerates inclusive NZ date-only occupancy nights without a DST day shift", async () => {
    mockPrisma.booking.findMany.mockResolvedValue([
      reportBooking({
        checkIn: day("2026-09-25"),
        checkOut: day("2026-10-03"),
        guests: [
          {
            id: "dst-guest",
            isMember: true,
            stayStart: day("2026-09-25"),
            stayEnd: day("2026-10-03"),
            nights: [],
          },
        ],
      }),
    ]);

    const { GET } = await import("@/app/api/admin/reports/route");
    const response = await GET(
      new NextRequest(
        "http://localhost/api/admin/reports?from=2026-09-25&to=2026-09-27",
      ),
    );
    const data = await response.json();

    expect(data.occupancy).toEqual([
      { date: "2026-09-25", occupiedBeds: 1, availableBeds: 28, occupancyRate: 3 },
      { date: "2026-09-26", occupiedBeds: 1, availableBeds: 28, occupancyRate: 3 },
      { date: "2026-09-27", occupiedBeds: 1, availableBeds: 28, occupancyRate: 3 },
    ]);
  }, 15_000);

  it("uses the same stay cohort for status, guests, trends, lodge, and deleted scope", async () => {
    mockLodgeFindUnique.mockResolvedValue({ id: "lodge-2", active: true });
    mockPrisma.booking.findMany.mockResolvedValue([
      reportBooking({ status: BookingStatus.PENDING }),
      reportBooking({ id: "review", status: BookingStatus.AWAITING_REVIEW, guests: [] }),
      reportBooking({ id: "completed", status: BookingStatus.COMPLETED, guests: [] }),
    ]);

    const { GET } = await import("@/app/api/admin/reports/route");
    const response = await GET(
      new NextRequest(
        "http://localhost/api/admin/reports?from=2026-04-07&to=2026-04-09&lodgeId=lodge-2&deleted=include",
      ),
    );
    const data = await response.json();

    expect(data.summary.totalBookings).toBe(3);
    expect(data.statusBreakdown).toMatchObject({ pending: 1, awaitingReview: 1, completed: 1 });
    expect(data.trends[0]).toMatchObject({ total: 3, pending: 1, awaitingReview: 1, completed: 1 });
    // PENDING/AWAITING_REVIEW belong to the base report cohort but must not
    // broaden the established PAID/COMPLETED occupancy cohort.
    expect(data.occupancy.every((night: { occupiedBeds: number }) => night.occupiedBeds === 0)).toBe(
      true,
    );
    const queryWhere = mockPrisma.booking.findMany.mock.calls[0][0].where;
    expect(queryWhere).toMatchObject({ lodgeId: "lodge-2" });
    expect(queryWhere).not.toHaveProperty("deletedAt");
  }, 15_000);

  it("preserves outstanding-addition visibility beside payment-derived cash", async () => {
    mockPrisma.booking.findMany.mockResolvedValue([
      reportBooking({
        finalPriceCents: 30_000,
        payment: {
          status: PaymentStatus.SUCCEEDED,
          amountCents: 9_000,
          refundedAmountCents: 0,
          additionalAmountCents: 21_000,
          additionalPaymentStatus: "PENDING",
          transactions: [],
        },
      }),
      reportBooking({
        id: "failed-addition",
        finalPriceCents: 10_000,
        payment: {
          status: PaymentStatus.SUCCEEDED,
          amountCents: 6_000,
          refundedAmountCents: 0,
          additionalAmountCents: 4_000,
          additionalPaymentStatus: "FAILED",
          transactions: [],
        },
      }),
    ]);

    const { GET } = await import("@/app/api/admin/reports/route");
    const response = await GET(
      new NextRequest("http://localhost/api/admin/reports?from=2026-04-07&to=2026-04-09"),
    );
    const data = await response.json();

    expect(data.summary.totalRevenueCents).toBe(40_000);
    expect(data.summary.netCollectedCents).toBe(15_000);
    expect(data.summary.outstandingAdditionalCents).toBe(25_000);
    expect(data.summary.outstandingAdditionalBookings).toBe(2);
  }, 15_000);

  it("surfaces the exact #2408 additional-ledger gap without changing cash arithmetic", async () => {
    mockPrisma.booking.findMany.mockResolvedValue([
      reportBooking({
        id: "booking-unproven-extra",
        finalPriceCents: 12_100,
        payment: {
          status: PaymentStatus.SUCCEEDED,
          amountCents: 10_000,
          refundedAmountCents: 0,
          additionalAmountCents: 2_100,
          additionalPaymentStatus: "SUCCEEDED",
          transactions: [],
        },
      }),
    ]);

    const { GET } = await import("@/app/api/admin/reports/route");
    const response = await GET(
      new NextRequest(
        "http://localhost/api/admin/reports?from=2026-04-07&to=2026-04-09",
      ),
    );
    const data = await response.json();

    expect(data.summary).toMatchObject({
      netCollectedCents: 10_000,
      additionalLedgerGapCents: 2_100,
      additionalLedgerGapBookings: 1,
    });
    expect(JSON.stringify(data)).not.toContain("booking-unproven-extra");
    expect(JSON.stringify(data)).not.toContain("transactions");
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        bookingIds: ["booking-unproven-extra"],
        bookingCount: 1,
        additionalLedgerGapCents: 2_100,
        netCollectedCents: 10_000,
      }),
      expect.stringContaining("Net Collected Cash may understate"),
    );
  }, 15_000);

  it("rejects an unknown or inactive lodgeId before querying reports", async () => {
    mockLodgeFindUnique.mockResolvedValue({ id: "lodge-2", active: false });
    const { GET } = await import("@/app/api/admin/reports/route");
    const response = await GET(
      new NextRequest(
        "http://localhost/api/admin/reports?from=2026-04-01&to=2026-04-14&lodgeId=lodge-2",
      ),
    );
    expect(response.status).toBe(400);
    expect(mockPrisma.booking.findMany).not.toHaveBeenCalled();
  });

  it("applies deleted=only and the strict post-migration default-lodge scope together", async () => {
    mockLodgeFindUnique.mockResolvedValue({ id: "lodge-default", active: true });
    mockResolveMetricsCapacityAndScope.mockResolvedValueOnce({
      capacity: 29,
      // Booking.lodgeId is NOT NULL after the completed expand/contract
      // migration. The historically named legacy-null helper is now a strict
      // default-lodge match; pin that current contract independently here.
      bookingLodgeWhere: { lodgeId: "lodge-default" },
    });
    mockPrisma.booking.findMany.mockResolvedValue([]);

    const { GET } = await import("@/app/api/admin/reports/route");
    const response = await GET(
      new NextRequest(
        "http://localhost/api/admin/reports?from=2026-04-07&to=2026-04-09&lodgeId=lodge-default&deleted=only",
      ),
    );

    expect(response.status).toBe(200);
    expect(mockPrisma.booking.findMany.mock.calls[0][0].where).toEqual({
      deletedAt: { not: null },
      lodgeId: "lodge-default",
      checkIn: { lte: day("2026-04-09") },
      checkOut: { gt: day("2026-04-07") },
      status: { in: [...EXPECTED_REPORT_STATUS_VALUES] },
    });
  }, 15_000);

  it("pins the completed Booking lodge backfill and NOT NULL contract", () => {
    const schema = readFileSync(join(process.cwd(), "prisma/schema.prisma"), "utf8");
    const bookingModel = schema.match(/model Booking \{[\s\S]*?\n\}/)?.[0];
    expect(bookingModel).toContain(
      'lodgeId                   String             @default(dbgenerated("default_lodge_id()"))',
    );
    expect(bookingModel).not.toMatch(/lodgeId\s+String\?/);

    const contractMigration = readFileSync(
      join(
        process.cwd(),
        "prisma/migrations/20260708001100_multi_lodge_entity_lodge_id_not_null/migration.sql",
      ),
      "utf8",
    );
    expect(contractMigration).toContain(
      'UPDATE "Booking" SET "lodgeId" = default_lodge_id() WHERE "lodgeId" IS NULL;',
    );
    expect(contractMigration).toContain(
      'ALTER TABLE "Booking" ALTER COLUMN "lodgeId" SET NOT NULL;',
    );
  });
});

/*
  CT-4 (#2870), epic #2988 — one report window, two encodings, and the zone
  belongs to exactly one of them.

  The route derives four bounds from the same `?from=&to=` pair. Two are the
  first and last MOMENT of the club's days, for real-instant columns; two are the
  two CALENDAR DAYS themselves, for `@db.Date` columns, which take no zone at all
  because the pg adapter narrows such a bound to its UTC date and a club-midnight
  instant would land a day early there (INV-DATE-026).

  The member count is where the two meet, and it is the mixed expression #2870
  names by hand: `joinedDate` is `@db.Date` since #2872 and takes the DAYS, while
  the `joinedDate: null` fallback reaches for `createdAt`, which is an instant and
  takes the MOMENTS. Those two branches mean different things and must not be
  collapsed into one another.

  Both halves are pinned here against a club in `America/Denver` while the
  environment says `Pacific/Auckland`, so the assertions distinguish the persisted
  authority from the environment one (INV-CONFIG-002) as well as the day encoding
  from the instant encoding.
*/
describe("admin reports route — the report window comes from the persisted club zone (CT-4, #2870)", () => {
  const hostTimeZone = captureHostTimeZone();

  beforeAll(() => {
    // The environment authority the legacy helpers read. Deliberately NOT the
    // club's persisted zone, so a green run means something.
    process.env.TZ = "Pacific/Auckland";
  });

  afterAll(() => {
    hostTimeZone.restore();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({
      user: { id: "admin-1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }] },
    });
    mockRequireActiveSessionUser.mockResolvedValue(null);
    mockResolveMetricsCapacityAndScope.mockImplementation(async (lodgeId?: string) => ({
      capacity: 29,
      bookingLodgeWhere: lodgeId ? { lodgeId } : {},
    }));
    zeroMemberQueries();
    mockPrisma.booking.findMany.mockResolvedValue([]);
    mockPrisma.clubTimeSettings.findUnique.mockResolvedValue({
      timeZone: "America/Denver",
      updatedByMemberId: null,
      updatedAt: new Date(0),
    });
  });

  it("bounds instants by the club's civil day and calendar columns by the plain days", async () => {
    // THE PREMISE, MEASURED AS AN ANSWER RATHER THAN AN IDENTIFIER. What has to
    // hold for the instant assertions below to discriminate is that the
    // ENVIRONMENT authority — `APP_TIME_ZONE`, which is what every legacy helper
    // reads and what this route used to call — puts the club day somewhere else.
    // Comparing the two zone NAMES does not establish that: measured,
    // `TZ=America/Chicago` produces Denver's answer for every fixture in this
    // file, so a name check passes while the assertion quietly goes vacuous.
    // `APP_TIME_ZONE` is also frozen at module load, so the `process.env.TZ` pin
    // above cannot move it once anything has imported it — one more reason to
    // assert the answer instead of the label.
    //
    // `APP_TIME_ZONE` IS PASSED ON PURPOSE (#3123). The helper's default is
    // going away, and this premise's subject IS the environment authority: it
    // has to read the frozen module value rather than a literal, because a
    // literal would only ever restate the `process.env.TZ` pin above and could
    // not notice the two coming apart.
    const { startOfDateOnlyForTimeZone } = await import("@/lib/date-only");
    const { APP_TIME_ZONE } = await import("@/config/operational");
    expect(
      startOfDateOnlyForTimeZone("2026-04-08", APP_TIME_ZONE).toISOString(),
      "INV-CONFIG-002: the environment authority now opens the club day at the " +
        "same instant the persisted zone does, so the bounds below can no longer " +
        "tell which of the two the route obeyed, and would pass over a reverted " +
        "migration. Pick a persisted zone the environment disagrees with.",
    ).not.toBe("2026-04-08T06:00:00.000Z");

    const { GET } = await import("@/app/api/admin/reports/route");
    const response = await GET(
      new NextRequest("http://localhost/api/admin/reports?from=2026-04-08&to=2026-04-08"),
    );
    expect(response.status).toBe(200);

    const memberWhere = mockPrisma.member.count.mock.calls
      .map((call) => (call[0] as { where?: Record<string, unknown> } | undefined)?.where)
      .find((where) => Array.isArray(where?.OR));
    const [joinedBranch, createdBranch] = (
      memberWhere as { OR: Array<Record<string, { gte: Date; lte: Date }>> }
    ).OR;

    // THE CALENDAR-DATE BRANCH. `@db.Date`, so UTC midnight on both ends and no
    // zone anywhere near it. In Auckland the old start-of-day would have been
    // 2026-04-07T12:00Z and in Denver 2026-04-08T06:00Z; the stored day is
    // neither, and that is the point.
    expect(joinedBranch.joinedDate.gte.toISOString()).toBe("2026-04-08T00:00:00.000Z");
    expect(joinedBranch.joinedDate.lte.toISOString()).toBe("2026-04-08T00:00:00.000Z");

    // THE INSTANT BRANCH. 8 April 2026 in Denver is MDT (UTC-6), so the club's
    // day runs 06:00Z to 05:59:59.999Z the next morning. Under the environment's
    // Pacific/Auckland it would be 2026-04-07T12:00Z to 2026-04-08T11:59:59.999Z
    // — a different window over a real column, which is the whole of #2870.
    expect(createdBranch.createdAt.gte.toISOString()).toBe("2026-04-08T06:00:00.000Z");
    expect(createdBranch.createdAt.lte.toISOString()).toBe("2026-04-09T05:59:59.999Z");
  });

  it("refuses a shape-valid date that names no real day, instead of failing later", async () => {
    const { GET } = await import("@/app/api/admin/reports/route");
    const response = await GET(
      new NextRequest("http://localhost/api/admin/reports?from=2026-02-30&to=2026-03-05"),
    );

    expect(response.status).toBe(400);
    expect(mockPrisma.booking.findMany).not.toHaveBeenCalled();
  });

  /*
    `9999-12-31` is a REAL day, so it passes both the shape regex and
    `parseCalendarDate`. What it has not got is a day AFTER it, and the club
    day's end is defined as the next day's start — so `addCalendarDays` throws a
    `RangeError` and, because the derivation sits outside the handler's `try`,
    the request used to die as an unhandled rejection rather than answer at all.
    That is a REGRESSION from the logged 500 the legacy helper produced, and the
    URL is not hypothetical: `src/lib/club-time/calendar-date.ts` records
    `/admin/audit-log?to=9999-12-31` as a value that reached production.
  */
  it("refuses a window whose end has no day after it, rather than throwing", async () => {
    const { GET } = await import("@/app/api/admin/reports/route");
    const response = await GET(
      new NextRequest("http://localhost/api/admin/reports?from=2026-04-08&to=9999-12-31"),
    );

    expect(response.status).toBe(400);
    expect(mockPrisma.booking.findMany).not.toHaveBeenCalled();
  });
});
