import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    booking: { findMany: vi.fn(), count: vi.fn() },
    xeroSyncOperation: { findMany: vi.fn() },
    xeroObjectLink: { findMany: vi.fn() },
  },
}));

import {
  ADMIN_BOOKINGS_DERIVED_SCAN_CHUNK_SIZE,
  ADMIN_BOOKINGS_PAGE_SIZE,
  adminBookingsQuerySchema,
  listAdminBookings,
  type AdminBookingsClubDay,
} from "@/lib/admin-bookings-service";
import {
  dateOnlyInstantOf,
  requireCalendarDate,
  requireClubTimeZone,
} from "@/lib/club-time";

/**
 * The club's day and zone these cases mean, stated rather than read (#3123).
 * `listAdminBookings` and its `where` builders take them as data instead of
 * projecting through `APP_TIME_ZONE`; that the value comes from the PERSISTED
 * club timezone is pinned in `admin-bookings-club-time-authority.test.ts`.
 */
const TEST_CLUB_DAY: AdminBookingsClubDay = {
  zone: requireClubTimeZone("Pacific/Auckland"),
  today: dateOnlyInstantOf(requireCalendarDate("2026-07-01")),
};
import { addDaysDateOnly } from "@/lib/date-only";
import { prisma } from "@/lib/prisma";
import { installAdminBookingsDbMock } from "./admin-bookings-db-mock";

// Distinct ascending check-in dates, relative to the club day this suite
// states above rather than to a clock (#3123), so `sortBy:checkIn asc` orders
// the fixtures b0, b1, ... deterministically and we know exactly which
// booking each page window contains.
function makeBooking(index: number, overrides: Record<string, unknown> = {}) {
  const checkIn = addDaysDateOnly(TEST_CLUB_DAY.today, index);
  const checkOut = addDaysDateOnly(checkIn, 2);
  return {
    id: `b${index}`,
    status: "PAID",
    checkIn,
    checkOut,
    updatedAt: new Date("2026-06-01T00:00:00.000Z"),
    finalPriceCents: 10_000,
    requiresAdminReview: false,
    adminReviewStatus: null,
    adminReviewReason: null,
    deletedAt: null,
    member: {
      id: `member-${index}`,
      firstName: "Aroha",
      lastName: "Ngata",
      email: `b${index}@example.test`,
    },
    guests: [],
    _count: { guests: 0 },
    payment: null,
    bedAllocations: [],
    modifications: [],
    changeRequests: [],
    creditsFromCancellation: [],
    refundRequests: [],
    ...overrides,
  };
}

const TOTAL = ADMIN_BOOKINGS_PAGE_SIZE + 1; // 101 → exactly two pages

describe("listAdminBookings pagination (#1738)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.xeroSyncOperation.findMany).mockResolvedValue([]);
    vi.mocked(prisma.xeroObjectLink.findMany).mockResolvedValue([]);
  });

  it("fast path: returns the first page and page metadata by default", async () => {
    const fixtures = Array.from({ length: TOTAL }, (_, i) => makeBooking(i));
    installAdminBookingsDbMock(fixtures);

    const result = await listAdminBookings(
      adminBookingsQuerySchema.parse({ sortBy: "checkIn", sortDir: "asc" }),
      {},
      TEST_CLUB_DAY,
    );

    expect(result.total).toBe(TOTAL);
    expect(result.page).toBe(1);
    expect(result.totalPages).toBe(2);
    expect(result.pageSize).toBe(ADMIN_BOOKINGS_PAGE_SIZE);
    expect(result.bookings).toHaveLength(ADMIN_BOOKINGS_PAGE_SIZE);
    expect(result.bookings[0].id).toBe("b0");
    expect(result.bookings.at(-1)?.id).toBe(`b${ADMIN_BOOKINGS_PAGE_SIZE - 1}`);
  });

  it("fast path: windows to the requested page in SQL (#1884)", async () => {
    const fixtures = Array.from({ length: TOTAL }, (_, i) => makeBooking(i));
    installAdminBookingsDbMock(fixtures);

    const result = await listAdminBookings(
      adminBookingsQuerySchema.parse({ sortBy: "checkIn", sortDir: "asc", page: "2" }),
      {},
      TEST_CLUB_DAY,
    );

    expect(result.page).toBe(2);
    expect(result.totalPages).toBe(2);
    expect(result.total).toBe(TOTAL);
    // Only the 101st booking spills onto page 2.
    expect(result.bookings.map((b) => b.id)).toEqual([`b${ADMIN_BOOKINGS_PAGE_SIZE}`]);

    const calls = vi.mocked(prisma.booking.findMany).mock.calls;
    // The page window is applied in SQL (#1884), not by slicing a full load;
    // a third findMany is the exclusive-hold overlap query for the page (#119).
    expect(calls).toHaveLength(3);
    expect(calls[0][0]?.orderBy).toEqual([{ checkIn: "asc" }, { id: "asc" }]);
    expect(calls[0][0]?.skip).toBe(ADMIN_BOOKINGS_PAGE_SIZE);
    expect(calls[0][0]?.take).toBe(ADMIN_BOOKINGS_PAGE_SIZE);
    // The heavy relation load is restricted to just the page's id.
    expect(calls[1][0]?.where).toEqual({ id: { in: [`b${ADMIN_BOOKINGS_PAGE_SIZE}`] } });
  });

  it("fast path: clamps an out-of-range page to the last non-empty page", async () => {
    const fixtures = Array.from({ length: TOTAL }, (_, i) => makeBooking(i));
    installAdminBookingsDbMock(fixtures);

    const result = await listAdminBookings(
      adminBookingsQuerySchema.parse({ sortBy: "checkIn", sortDir: "asc", page: "99" }),
      {},
      TEST_CLUB_DAY,
    );

    expect(result.page).toBe(2);
    expect(result.totalPages).toBe(2);
    expect(result.bookings.map((b) => b.id)).toEqual([`b${ADMIN_BOOKINGS_PAGE_SIZE}`]);
  });

  it("filtered path: windows the derived-filter result set to the requested page", async () => {
    // bedState:"complete" forces the derived-filter path; every zero-guest
    // fixture derives bedState "complete", so all 101 survive the filter and
    // get windowed in JS after the bounded chunk scan.
    const fixtures = Array.from({ length: TOTAL }, (_, i) => makeBooking(i));
    installAdminBookingsDbMock(fixtures);

    const result = await listAdminBookings(
      adminBookingsQuerySchema.parse({
        sortBy: "checkIn",
        sortDir: "asc",
        bedState: "complete",
        page: "2",
      }),
      {},
      TEST_CLUB_DAY,
    );

    // One bounded scan chunk (101 < chunk size) + one page hydration (#1884)
    // + the exclusive-hold overlap query for the page (#119).
    const calls = vi.mocked(prisma.booking.findMany).mock.calls;
    expect(calls).toHaveLength(3);
    expect(calls[0][0]).toHaveProperty("include");
    expect(calls[0][0]?.take).toBe(ADMIN_BOOKINGS_DERIVED_SCAN_CHUNK_SIZE);
    expect(result.page).toBe(2);
    expect(result.totalPages).toBe(2);
    expect(result.total).toBe(TOTAL);
    expect(result.bookings.map((b) => b.id)).toEqual([`b${ADMIN_BOOKINGS_PAGE_SIZE}`]);
  });

  it("paymentSource=NONE pages in SQL instead of the derived-filter scan (#1884)", async () => {
    // Every fixture has no payment row, so the SQL no-payment predicate keeps
    // all 101 and pagination behaves exactly as the unfiltered fast path.
    const fixtures = Array.from({ length: TOTAL }, (_, i) => makeBooking(i));
    installAdminBookingsDbMock(fixtures);

    const result = await listAdminBookings(
      adminBookingsQuerySchema.parse({
        sortBy: "checkIn",
        sortDir: "asc",
        paymentSource: "NONE",
        page: "2",
      }),
      {},
      TEST_CLUB_DAY,
    );

    const calls = vi.mocked(prisma.booking.findMany).mock.calls;
    // Derived path: scan + page hydration + the exclusive-hold overlap query
    // for the page (#119).
    expect(calls).toHaveLength(3);
    expect(calls[0][0]).not.toHaveProperty("include");
    expect(calls[0][0]?.where?.payment).toEqual({ is: null });
    expect(calls[0][0]?.take).toBe(ADMIN_BOOKINGS_PAGE_SIZE);
    expect(result.page).toBe(2);
    expect(result.totalPages).toBe(2);
    expect(result.total).toBe(TOTAL);
    expect(result.bookings.map((b) => b.id)).toEqual([`b${ADMIN_BOOKINGS_PAGE_SIZE}`]);
  });

  it("coerces garbage page values to page 1 without dropping other filters", async () => {
    const parsed = adminBookingsQuerySchema.parse({ status: "PAID", page: "abc" });
    expect(parsed.page).toBe(1);
    expect(parsed.status).toBe("PAID");

    expect(adminBookingsQuerySchema.parse({ page: "0" }).page).toBe(1);
    expect(adminBookingsQuerySchema.parse({ page: "-4" }).page).toBe(1);
    expect(adminBookingsQuerySchema.parse({ page: "2.5" }).page).toBe(1);
    expect(adminBookingsQuerySchema.parse({}).page).toBe(1);
    expect(adminBookingsQuerySchema.parse({ page: "3" }).page).toBe(3);
  });
});
