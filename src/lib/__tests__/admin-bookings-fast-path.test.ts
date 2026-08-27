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
import { prisma } from "@/lib/prisma";
import { installAdminBookingsDbMock } from "./admin-bookings-db-mock";

/**
 * The #1146 fast path, hardened by #1884: with the derived-state filters at
 * their "all" defaults, listAdminBookings must not load every matching
 * booking into memory. SQL-expressible sorts (checkIn / lastUpdated / total /
 * guests) are pushed down as orderBy + skip/take; only the member-name and
 * lifecycle-rank (status) sorts still use the JS comparator over a
 * lightweight projection — and both paths must produce exactly the ordering
 * the legacy full-scan comparator produced.
 */

function makeGuests(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: `guest-${i}`,
    firstName: `Guest${i}`,
    lastName: "Test",
    ageTier: "ADULT",
    isMember: false,
    stayStart: new Date("2026-07-01T00:00:00.000Z"),
    stayEnd: new Date("2026-07-03T00:00:00.000Z"),
    // #2628: the heavy include always loads the night rows, so every fixture
    // guest carries the two nights its half-open envelope describes — the 1st
    // and the 2nd. Without them the derived state is measured off the old
    // envelope fallback instead of the canonical nights.
    nights: [
      { stayDate: new Date("2026-07-01T00:00:00.000Z") },
      { stayDate: new Date("2026-07-02T00:00:00.000Z") },
    ],
  }));
}

function makeBooking(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    status: "PAID",
    checkIn: new Date("2026-07-01T00:00:00.000Z"),
    checkOut: new Date("2026-07-03T00:00:00.000Z"),
    updatedAt: new Date("2026-06-01T00:00:00.000Z"),
    finalPriceCents: 10_000,
    requiresAdminReview: false,
    adminReviewStatus: null,
    adminReviewReason: null,
    deletedAt: null,
    member: {
      id: `member-${id}`,
      firstName: "Aroha",
      lastName: "Ngata",
      email: `${id}@example.test`,
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

function makePayment(id: string, source: "STRIPE" | "INTERNET_BANKING") {
  return {
    id,
    source,
    status: "SUCCEEDED",
    xeroInvoiceId: null,
    xeroInvoiceNumber: null,
    refundedAmountCents: 0,
  };
}

describe("listAdminBookings fast path (#1146, #1884)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.xeroSyncOperation.findMany).mockResolvedValue([]);
    vi.mocked(prisma.xeroObjectLink.findMany).mockResolvedValue([]);
  });

  it("pushes the default sort down to SQL and hydrates only the page (#1884)", async () => {
    const fixtures = [
      makeBooking("b1", { updatedAt: new Date("2026-06-03T00:00:00.000Z") }),
      makeBooking("b2", { updatedAt: new Date("2026-06-01T00:00:00.000Z") }),
      makeBooking("b3", { updatedAt: new Date("2026-06-02T00:00:00.000Z") }),
    ];
    installAdminBookingsDbMock(fixtures);

    const result = await listAdminBookings(adminBookingsQuerySchema.parse({}), {}, TEST_CLUB_DAY);

    // Default sort is lastUpdated desc; ordering must match the legacy comparator.
    expect(result.bookings.map((b) => b.id)).toEqual(["b1", "b3", "b2"]);
    expect(result.total).toBe(3);
    // The total comes from a SQL count, not from loading every row.
    expect(vi.mocked(prisma.booking.count)).toHaveBeenCalledTimes(1);

    const calls = vi.mocked(prisma.booking.findMany).mock.calls;
    // First pass: id-only page query — ordering and windowing happen in SQL
    // (#1884). A third findMany is the exclusive-hold overlap query for the
    // page (#119).
    expect(calls).toHaveLength(3);
    expect(calls[0][0]).not.toHaveProperty("include");
    expect(calls[0][0]?.select).toEqual({ id: true });
    expect(calls[0][0]?.orderBy).toEqual([{ updatedAt: "desc" }, { id: "asc" }]);
    expect(calls[0][0]?.skip).toBe(0);
    expect(calls[0][0]?.take).toBe(ADMIN_BOOKINGS_PAGE_SIZE);
    // Second pass: heavy include restricted to the page ids.
    expect(calls[1][0]).toHaveProperty("include");
    expect(calls[1][0]?.where).toEqual({ id: { in: ["b1", "b3", "b2"] } });
    // Third pass: the exclusive-hold overlap query for the page.
    expect(calls[2][0]?.where).toMatchObject({ wholeLodgeHold: true });
  });

  it("orders every sort key identically to the legacy comparator", async () => {
    const fixtures = [
      makeBooking("b1", {
        finalPriceCents: 300,
        status: "PAID",
        checkIn: new Date("2026-07-05T00:00:00.000Z"),
        member: { id: "m1", firstName: "Zoe", lastName: "Adams", email: "z@example.test" },
        _count: { guests: 2 },
        guests: makeGuests(2),
      }),
      makeBooking("b2", {
        finalPriceCents: 100,
        status: "CONFIRMED",
        checkIn: new Date("2026-07-01T00:00:00.000Z"),
        member: { id: "m2", firstName: "Amy", lastName: "Baker", email: "a@example.test" },
        _count: { guests: 5 },
        guests: makeGuests(5),
      }),
      makeBooking("b3", {
        finalPriceCents: 200,
        status: "PENDING",
        checkIn: new Date("2026-07-03T00:00:00.000Z"),
        member: { id: "m3", firstName: "Ben", lastName: "Adams", email: "b@example.test" },
        _count: { guests: 1 },
        guests: makeGuests(1),
      }),
    ];

    const expectations: Array<[string, string, string[]]> = [
      // sortBy, sortDir, expected order (legacy comparator semantics)
      ["member", "asc", ["b3", "b1", "b2"]], // "adams ben" < "adams zoe" < "baker amy"
      ["total", "desc", ["b1", "b3", "b2"]],
      ["guests", "asc", ["b3", "b1", "b2"]],
      ["checkIn", "asc", ["b2", "b3", "b1"]],
      // Status sorts by lifecycle rank (#1215), not alphabetically:
      // PENDING(b3) < CONFIRMED(b2) < PAID(b1). Alphabetical would be
      // CONFIRMED(b2), PAID(b1), PENDING(b3).
      ["status", "asc", ["b3", "b2", "b1"]],
    ];

    for (const [sortBy, sortDir, expected] of expectations) {
      vi.mocked(prisma.booking.findMany).mockClear();
      vi.mocked(prisma.booking.count).mockClear();
      installAdminBookingsDbMock(fixtures);
      const result = await listAdminBookings(
        adminBookingsQuerySchema.parse({ sortBy, sortDir }),
        {},
        TEST_CLUB_DAY,
      );
      expect(result.bookings.map((b) => b.id)).toEqual(expected);
    }
  });

  it("maps paymentSource=STRIPE onto the SQL where clause instead of a full scan (#1884)", async () => {
    const fixtures = [
      makeBooking("b-stripe", { payment: makePayment("payment-1", "STRIPE") }),
      makeBooking("b-none"),
    ];
    installAdminBookingsDbMock(fixtures);

    const result = await listAdminBookings(
      adminBookingsQuerySchema.parse({ paymentSource: "STRIPE" }),
      {},
      TEST_CLUB_DAY,
    );

    expect(result.bookings.map((b) => b.id)).toEqual(["b-stripe"]);
    expect(result.total).toBe(1);

    // paymentSource is a real Payment column, so it must ride the fast SQL
    // path: count + bounded id page, both filtered by the payment predicate.
    const countArgs = vi.mocked(prisma.booking.count).mock.calls[0]?.[0];
    expect(countArgs?.where?.payment).toEqual({ is: { source: "STRIPE" } });
    const calls = vi.mocked(prisma.booking.findMany).mock.calls;
    expect(calls[0][0]?.where?.payment).toEqual({ is: { source: "STRIPE" } });
    expect(calls[0][0]).not.toHaveProperty("include");
    expect(calls[0][0]?.take).toBe(ADMIN_BOOKINGS_PAGE_SIZE);
  });

  it("maps paymentSource=NONE onto a no-payment SQL predicate (#1884)", async () => {
    const fixtures = [
      makeBooking("b-none"),
      makeBooking("b-stripe", { payment: makePayment("payment-1", "STRIPE") }),
    ];
    installAdminBookingsDbMock(fixtures);

    const result = await listAdminBookings(
      adminBookingsQuerySchema.parse({ paymentSource: "NONE" }),
      {},
      TEST_CLUB_DAY,
    );

    expect(result.bookings.map((b) => b.id)).toEqual(["b-none"]);
    // Payment.source is a non-nullable enum, so "no source" ⇔ no payment row.
    const countArgs = vi.mocked(prisma.booking.count).mock.calls[0]?.[0];
    expect(countArgs?.where?.payment).toEqual({ is: null });
    const calls = vi.mocked(prisma.booking.findMany).mock.calls;
    expect(calls[0][0]?.where?.payment).toEqual({ is: null });
    expect(calls[0][0]).not.toHaveProperty("include");
    expect(calls[0][0]?.take).toBe(ADMIN_BOOKINGS_PAGE_SIZE);
  });

  it("bounds the candidate load when a genuinely derived filter is active (#1884)", async () => {
    const fixtures = [makeBooking("b1")];
    installAdminBookingsDbMock(fixtures);

    await listAdminBookings(
      adminBookingsQuerySchema.parse({ xeroState: "invoiceMissing" }),
      {},
      TEST_CLUB_DAY,
    );

    const calls = vi.mocked(prisma.booking.findMany).mock.calls;
    // Chunked candidate scan (bounded take, stable id order) + page hydration.
    expect(calls).toHaveLength(2);
    expect(calls[0][0]).toHaveProperty("include");
    expect(calls[0][0]?.take).toBe(ADMIN_BOOKINGS_DERIVED_SCAN_CHUNK_SIZE);
    expect(calls[0][0]?.orderBy).toEqual({ id: "asc" });
    expect(calls[1][0]).toHaveProperty("include");
    expect(calls[1][0]?.where).toEqual({ id: { in: [] } });
  });

  it("scans derived-filter candidates in id-ordered chunks and keeps exact totals (#1884)", async () => {
    const total = ADMIN_BOOKINGS_DERIVED_SCAN_CHUNK_SIZE + 1;
    const dayMs = 24 * 60 * 60 * 1000;
    const fixtures = Array.from({ length: total }, (_, i) =>
      makeBooking(`b${String(i).padStart(4, "0")}`, {
        checkIn: new Date(Date.UTC(2026, 0, 1) + i * dayMs),
        checkOut: new Date(Date.UTC(2026, 0, 3) + i * dayMs),
        modifications: [
          {
            id: `mod-${i}`,
            modificationType: "DATES",
            priceDiffCents: 0,
            createdAt: new Date("2026-06-01T00:00:00.000Z"),
            creditsFromModification: [],
          },
        ],
      })
    );
    installAdminBookingsDbMock(fixtures);

    const result = await listAdminBookings(
      adminBookingsQuerySchema.parse({
        changeState: "hasModification",
        sortBy: "checkIn",
        sortDir: "asc",
      }),
      {},
      TEST_CLUB_DAY,
    );

    // Exact totals and page contents are preserved — no truncation.
    expect(result.total).toBe(total);
    expect(result.totalPages).toBe(6);
    expect(result.bookings).toHaveLength(ADMIN_BOOKINGS_PAGE_SIZE);
    expect(result.bookings[0].id).toBe("b0000");
    expect(result.bookings.at(-1)?.id).toBe("b0099");

    const calls = vi.mocked(prisma.booking.findMany).mock.calls;
    // Two bounded scan chunks (500 + 1), one page hydration, then the
    // exclusive-hold overlap query for the page (#119).
    expect(calls).toHaveLength(4);
    expect(calls[0][0]?.take).toBe(ADMIN_BOOKINGS_DERIVED_SCAN_CHUNK_SIZE);
    expect(calls[0][0]?.orderBy).toEqual({ id: "asc" });
    expect(calls[0][0]?.cursor).toBeUndefined();
    expect(calls[1][0]?.take).toBe(ADMIN_BOOKINGS_DERIVED_SCAN_CHUNK_SIZE);
    expect(calls[1][0]?.cursor).toEqual({ id: "b0499" });
    expect(calls[1][0]?.skip).toBe(1);
    expect(calls[2][0]?.where).toEqual({
      id: { in: result.bookings.map((b) => b.id) },
    });
  });

  it("sorts the status column by lifecycle order, not alphabetically (#1215)", async () => {
    // Distinct lifecycle ranks so the id tie-break never fires:
    // PENDING(1) < CONFIRMED(3) < PAID(4) < CANCELLED(9). Alphabetical asc
    // would instead lead with CANCELLED, so the two orderings diverge cleanly.
    const fixtures = [
      makeBooking("b-confirmed", { status: "CONFIRMED" }),
      makeBooking("b-cancelled", { status: "CANCELLED" }),
      makeBooking("b-pending", { status: "PENDING" }),
      makeBooking("b-paid", { status: "PAID" }),
    ];
    vi.mocked(prisma.booking.findMany).mockResolvedValue(fixtures as never);

    const result = await listAdminBookings(
      adminBookingsQuerySchema.parse({ sortBy: "status", sortDir: "asc" }),
      {},
      TEST_CLUB_DAY,
    );

    const order = result.bookings.map((b) => b.id);
    expect(order).toEqual(["b-pending", "b-confirmed", "b-paid", "b-cancelled"]);
    // Lifecycle-specific relationships called out in the spec.
    expect(order.indexOf("b-confirmed")).toBeLessThan(order.indexOf("b-cancelled"));
    expect(order.indexOf("b-pending")).toBeLessThan(order.indexOf("b-paid"));
    // Guard against a regression to alphabetical ordering, which would lead
    // with CANCELLED.
    expect(order[0]).not.toBe("b-cancelled");
  });

  it("orders the status column identically on the fast and full paths (#1215)", async () => {
    // Zero-guest fixtures keep every row's derived bedState "complete", so the
    // bedState:"complete" filter forces the derived-filter path yet drops no
    // rows — letting us compare the sortRowValue (fast) and sortValue (full)
    // comparators on the same set for sortBy:"status".
    const makeFixtures = () => [
      makeBooking("b-confirmed", { status: "CONFIRMED" }),
      makeBooking("b-cancelled", { status: "CANCELLED" }),
      makeBooking("b-pending", { status: "PENDING" }),
      makeBooking("b-paid", { status: "PAID" }),
    ];

    vi.mocked(prisma.booking.findMany).mockResolvedValue(makeFixtures() as never);
    const fastResult = await listAdminBookings(
      adminBookingsQuerySchema.parse({ sortBy: "status", sortDir: "asc" }),
      {},
      TEST_CLUB_DAY,
    );
    // Fast path: projection pass + page load + exclusive-hold overlap query
    // (issue #119) = three findMany calls.
    expect(vi.mocked(prisma.booking.findMany).mock.calls).toHaveLength(3);

    vi.mocked(prisma.booking.findMany).mockClear();
    installAdminBookingsDbMock(makeFixtures());
    const fullResult = await listAdminBookings(
      adminBookingsQuerySchema.parse({ sortBy: "status", sortDir: "asc", bedState: "complete" }),
      {},
      TEST_CLUB_DAY,
    );
    // Derived path: one bounded scan chunk + one page hydration + the
    // exclusive-hold overlap query for the page (#119).
    const fullCalls = vi.mocked(prisma.booking.findMany).mock.calls;
    expect(fullCalls).toHaveLength(3);
    expect(fullCalls[0][0]).toHaveProperty("include");
    expect(fullCalls[0][0]?.take).toBe(ADMIN_BOOKINGS_DERIVED_SCAN_CHUNK_SIZE);

    const fastOrder = fastResult.bookings.map((b) => b.id);
    const fullOrder = fullResult.bookings.map((b) => b.id);
    expect(fullOrder).toEqual(fastOrder);
    expect(fastOrder).toEqual(["b-pending", "b-confirmed", "b-paid", "b-cancelled"]);
  });
});
