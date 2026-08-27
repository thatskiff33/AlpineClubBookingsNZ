import { renderToStaticMarkup } from "react-dom/server";
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    booking: { findMany: vi.fn(), count: vi.fn() },
    // #2307 (MG2-M-3): the consent queue chips count stuck guest rows.
    bookingGuest: { count: vi.fn().mockResolvedValue(0), findMany: vi.fn().mockResolvedValue([]) },
    hostingCoverageIncident: {
      count: vi.fn().mockResolvedValue(0),
      findMany: vi.fn().mockResolvedValue([]),
    },
    xeroSyncOperation: { findMany: vi.fn() },
    xeroObjectLink: { findMany: vi.fn() },
    // CT-4 (#2870): the page renders `updatedAt` through the club's PERSISTED
    // timezone. `loadPersistedClubTimeSettings` is fail-soft in three places
    // and a MISSING DELEGATE is one of them — so without this entry the reader
    // silently answers "nothing persisted" and the page falls back to
    // `APP_TIME_ZONE`, which is the very defect CT-4 removes. Every test in
    // this file bar one leaves it resolving `null`, which reproduces exactly
    // that fallback and keeps their expectations unchanged; the zone-authority
    // test at the bottom is the one that supplies a row.
    clubTimeSettings: { findUnique: vi.fn() },
    // Multi-lodge phase 8: the page loads active lodges for the lodge
    // filter/column (hidden while only one comes back).
    lodge: {
      findMany: vi.fn().mockResolvedValue([{ id: "lodge-1", name: "Lodge" }]),
    },
  },
}));

vi.mock("@/lib/auth", () => ({
  auth: vi.fn(),
}));

vi.mock("@/components/admin/booking-filters", () => ({
  BookingFilters: () => null,
}));

vi.mock("@/components/admin-booking-calendar", () => ({
  AdminBookingCalendar: () => null,
}));

vi.mock("@/lib/module-settings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/module-settings")>();
  return {
    ...actual,
    loadEffectiveModuleFlags: vi.fn().mockResolvedValue({
      kiosk: true,
      chores: true,
      financeDashboard: true,
      waitlist: true,
      xeroIntegration: true,
      bedAllocation: true,
      internetBankingPayments: true,
    }),
  };
});

import AdminBookingsPage, {
  formatAdminBookingGuestCount,
} from "@/app/(admin)/admin/bookings/page";
import { APP_LOCALE, APP_TIME_ZONE } from "@/config/operational";
import { chooseDivergentClubZone } from "@/lib/__tests__/helpers/club-time-zone";
import {
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
import {
  addDaysDateOnly,
  formatDateOnly,
  parseDateOnly,
} from "@/lib/date-only";
import { loadEffectiveModuleFlags } from "@/lib/module-settings";
import { prisma } from "@/lib/prisma";
import { auth } from "@/lib/auth";
import { ADMIN_VIEW_ONLY_ACTION_REASON } from "@/hooks/use-admin-area-edit-access";
import { installAdminBookingsDbMock } from "./admin-bookings-db-mock";

const effectiveModulesOn = {
  kiosk: true,
  chores: true,
  financeDashboard: true,
  waitlist: true,
  xeroIntegration: true,
  bedAllocation: true,
  internetBankingPayments: true,
  // Flags this page does not exercise stay off, matching the pre-existing
  // runtime behaviour when they were absent from the fixture.
  addressAutocomplete: false,
  groupBookings: false,
  lockers: false,
  induction: false,
  workParties: false,
  promoCodes: false,
  hutLeaders: false,
  communications: false,
  skifieldConditions: false,
  twoFactor: false,
  magicLink: false,
  googleLogin: false,
  analytics: false,
  lobbyDisplay: false,
  aiAssistant: false,
  memberNotices: true,
  eventsCalendar: true,
  memberGuests: false,
  aiDiagnostics: false,
  maintenanceReports: true,
  alpineCentralServer: false,
  commsPortal: false,
};

describe("AdminBookingsPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(loadEffectiveModuleFlags).mockResolvedValue(effectiveModulesOn);
    vi.mocked(prisma.booking.findMany).mockResolvedValue([]);
    vi.mocked(prisma.booking.count).mockResolvedValue(0);
    vi.mocked(prisma.hostingCoverageIncident.count).mockResolvedValue(0);
    vi.mocked(prisma.hostingCoverageIncident.findMany).mockResolvedValue([]);
    vi.mocked(prisma.xeroSyncOperation.findMany).mockResolvedValue([]);
    vi.mocked(prisma.xeroObjectLink.findMany).mockResolvedValue([]);
    vi.mocked(prisma.clubTimeSettings.findUnique).mockResolvedValue(null);
    vi.mocked(auth).mockResolvedValue({
      user: {
        id: "admin-1",
        accessRoles: [{ role: "ADMIN" }],
      },
    } as any);
  });

  function makeBooking(overrides: Record<string, unknown> = {}) {
    return {
      id: "booking-1",
      status: "PAID",
      checkIn: new Date("2026-07-01T00:00:00.000Z"),
      checkOut: new Date("2026-07-03T00:00:00.000Z"),
      updatedAt: new Date("2026-06-01T00:00:00.000Z"),
      finalPriceCents: 10000,
      requiresAdminReview: false,
      adminReviewStatus: null,
      adminReviewReason: null,
      deletedAt: null,
      member: {
        id: "member-1",
        firstName: "Aroha",
        lastName: "Ngata",
        email: "aroha@example.test",
      },
      guests: [],
      payment: null,
      bedAllocations: [],
      modifications: [],
      changeRequests: [],
      creditsFromCancellation: [],
      refundRequests: [],
      ...overrides,
    };
  }

  it("applies separate last-updated and check-in date ranges", async () => {
    await AdminBookingsPage({
      searchParams: Promise.resolve({
        updatedFrom: "2026-05-01",
        updatedTo: "2026-05-31",
        checkInFrom: "2026-07-01",
        checkInTo: "2026-07-31",
      }),
    });

    const callArgs = vi.mocked(prisma.booking.findMany).mock.calls[0][0] as any;
    expect(callArgs.where.updatedAt.gte).toEqual(new Date("2026-04-30T12:00:00.000Z"));
    // #3123: the `updatedAt` upper bound is now HALF-OPEN (`lt` against the
    // next club midnight) rather than inclusive to the millisecond, which
    // Postgres's microsecond resolution made lossy.
    expect(callArgs.where.updatedAt.lt).toEqual(new Date("2026-05-31T12:00:00.000Z"));
    expect(callArgs.where.checkIn.gte).toEqual(new Date("2026-07-01T00:00:00.000Z"));
    expect(callArgs.where.checkIn.lte).toEqual(new Date("2026-07-31T00:00:00.000Z"));
    expect(callArgs.where.checkOut).toBeUndefined();
  });

  it("scopes the hosting-coverage incident queue to the active lodge filter", async () => {
    await AdminBookingsPage({
      searchParams: Promise.resolve({ lodgeId: "lodge-b" }),
    });

    expect(prisma.hostingCoverageIncident.count).toHaveBeenCalledWith({
      where: { resolvedAt: null, lodgeId: "lodge-b" },
    });
    expect(prisma.hostingCoverageIncident.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { resolvedAt: null, lodgeId: "lodge-b" },
      }),
    );

    vi.mocked(prisma.hostingCoverageIncident.count).mockClear();
    vi.mocked(prisma.hostingCoverageIncident.findMany).mockClear();
    await AdminBookingsPage({ searchParams: Promise.resolve({}) });
    expect(prisma.hostingCoverageIncident.count).toHaveBeenCalledWith({
      where: { resolvedAt: null },
    });
    expect(prisma.hostingCoverageIncident.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { resolvedAt: null } }),
    );
  });

  it("preserves the active lodge filter in hosting-incident booking return links", async () => {
    vi.mocked(prisma.hostingCoverageIncident.count).mockResolvedValue(1);
    vi.mocked(prisma.hostingCoverageIncident.findMany).mockResolvedValue([
      {
        id: "incident-1",
        bookingId: "booking-incident",
        cause: "OFFICER_OVERRIDE",
        evidence: { requirements: { uncoveredNonMemberGuestNights: 1 } },
        openedAt: new Date("2026-08-06T00:00:00.000Z"),
        booking: {
          checkIn: new Date("2026-08-10T00:00:00.000Z"),
          checkOut: new Date("2026-08-11T00:00:00.000Z"),
          member: { firstName: "Aroha", lastName: "Ngata" },
          lodge: { name: "Lodge B" },
        },
      },
    ] as any);

    const element = await AdminBookingsPage({
      searchParams: Promise.resolve({ lodgeId: "lodge-b" }),
    });
    const html = renderToStaticMarkup(element);

    expect(html).toContain(
      "returnTo=%2Fadmin%2Fbookings%3FlodgeId%3Dlodge-b%23hosting-coverage-incidents",
    );
    expect(html).not.toContain(
      "returnTo=%2Fadmin%2Fbookings%23hosting-coverage-incidents",
    );
  });

  it("applies a check-out date range via checkOutFrom/checkOutTo", async () => {
    const from = formatDateOnly(addDaysDateOnly(TEST_CLUB_DAY.today, -14));
    const to = formatDateOnly(addDaysDateOnly(TEST_CLUB_DAY.today, -7));

    await AdminBookingsPage({
      searchParams: Promise.resolve({
        checkOutFrom: from,
        checkOutTo: to,
      }),
    });

    const callArgs = vi.mocked(prisma.booking.findMany).mock.calls[0][0] as any;
    expect(callArgs.where.checkOut.gte).toEqual(parseDateOnly(from));
    expect(callArgs.where.checkOut.lte).toEqual(parseDateOnly(to));
    expect(callArgs.where.checkIn).toBeUndefined();
  });

  it("expresses the unpaid-finished-stays deep link (#1709): status=PAYMENT_PENDING and checkOutTo=today", async () => {
    const todayKey = formatDateOnly(TEST_CLUB_DAY.today);

    await AdminBookingsPage({
      searchParams: Promise.resolve({
        status: "PAYMENT_PENDING",
        checkOutTo: todayKey,
      }),
    });

    const callArgs = vi.mocked(prisma.booking.findMany).mock.calls[0][0] as any;
    expect(callArgs.where.status).toBe("PAYMENT_PENDING");
    expect(callArgs.where.checkOut.lte).toEqual(parseDateOnly(todayKey));
  });

  it("expresses the unsettled-additions deep link (#1723): additionalOwed=owed and checkOutTo=today", async () => {
    const todayKey = formatDateOnly(TEST_CLUB_DAY.today);

    await AdminBookingsPage({
      searchParams: Promise.resolve({
        additionalOwed: "owed",
        checkOutTo: todayKey,
      }),
    });

    const callArgs = vi.mocked(prisma.booking.findMany).mock.calls[0][0] as any;
    // The owed fragment is AND-composed (shared with the dashboard card and
    // sidebar badge via unpaid-finished-stays.ts) so the default status
    // filter and the check-out cutoff still apply alongside it.
    expect(callArgs.where.AND).toEqual([
      {
        status: { in: ["CONFIRMED", "PAID", "COMPLETED"] },
        payment: {
          is: {
            additionalAmountCents: { gt: 0 },
            OR: [
              { additionalPaymentStatus: null },
              { additionalPaymentStatus: { not: "SUCCEEDED" } },
            ],
          },
        },
      },
    ]);
    expect(callArgs.where.checkOut.lte).toEqual(parseDateOnly(todayKey));
  });

  it("composes additionalOwed=owed with an explicit status filter and omits it by default", async () => {
    await AdminBookingsPage({
      searchParams: Promise.resolve({
        status: "PAID",
        additionalOwed: "owed",
      }),
    });

    let callArgs = vi.mocked(prisma.booking.findMany).mock.calls[0][0] as any;
    // The explicit choice narrows (top-level status) while the AND fragment
    // keeps the owed predicate — neither overwrites the other.
    expect(callArgs.where.status).toBe("PAID");
    expect(callArgs.where.AND).toHaveLength(1);

    vi.mocked(prisma.booking.findMany).mockClear();
    vi.mocked(prisma.booking.findMany).mockResolvedValue([]);
    await AdminBookingsPage({ searchParams: Promise.resolve({}) });

    callArgs = vi.mocked(prisma.booking.findMany).mock.calls[0][0] as any;
    expect(callArgs.where.AND).toBeUndefined();
  });

  it("prefers explicit checkOutTo over the legacy to param", async () => {
    const legacyTo = formatDateOnly(addDaysDateOnly(TEST_CLUB_DAY.today, 30));
    const checkOutTo = formatDateOnly(TEST_CLUB_DAY.today);

    await AdminBookingsPage({
      searchParams: Promise.resolve({
        to: legacyTo,
        checkOutTo,
      }),
    });

    const callArgs = vi.mocked(prisma.booking.findMany).mock.calls[0][0] as any;
    expect(callArgs.where.checkOut.lte).toEqual(parseDateOnly(checkOutTo));
    expect(callArgs.where.checkOut.gte).toBeUndefined();
  });

  it("keeps legacy from/to compatibility when named check-in params are absent", async () => {
    await AdminBookingsPage({
      searchParams: Promise.resolve({
        from: "2026-07-01",
        to: "2026-07-31",
      }),
    });

    const callArgs = vi.mocked(prisma.booking.findMany).mock.calls[0][0] as any;
    expect(callArgs.where.checkIn.gte).toEqual(new Date("2026-07-01T00:00:00.000Z"));
    expect(callArgs.where.checkOut.lte).toEqual(new Date("2026-07-31T00:00:00.000Z"));
  });

  it("treats BookingFilters' rewrite of a legacy from/to link as a no-op (#1720)", async () => {
    // BookingFilters rewrites ?from=A&to=B into ?checkInFrom=A&checkOutTo=B.
    // Both spellings must build the identical date where-clause.
    const legacyFrom = formatDateOnly(TEST_CLUB_DAY.today);
    const legacyTo = formatDateOnly(addDaysDateOnly(TEST_CLUB_DAY.today, 14));

    await AdminBookingsPage({
      searchParams: Promise.resolve({ from: legacyFrom, to: legacyTo }),
    });
    const legacyWhere = (
      vi.mocked(prisma.booking.findMany).mock.calls[0][0] as any
    ).where;

    vi.mocked(prisma.booking.findMany).mockClear();

    await AdminBookingsPage({
      searchParams: Promise.resolve({
        checkInFrom: legacyFrom,
        checkOutTo: legacyTo,
      }),
    });
    const rewrittenWhere = (
      vi.mocked(prisma.booking.findMany).mock.calls[0][0] as any
    ).where;

    expect(rewrittenWhere.checkIn).toEqual(legacyWhere.checkIn);
    expect(rewrittenWhere.checkOut).toEqual(legacyWhere.checkOut);
    expect(legacyWhere.checkIn.gte).toEqual(parseDateOnly(legacyFrom));
    expect(legacyWhere.checkOut.lte).toEqual(parseDateOnly(legacyTo));
  });

  it("sorts by member using stable member-name ordering", async () => {
    vi.mocked(prisma.booking.findMany).mockResolvedValue([
      makeBooking({
        id: "booking-z",
        member: {
          id: "member-z",
          firstName: "Zoe",
          lastName: "Young",
          email: "zoe@example.test",
        },
      }),
      makeBooking({
        id: "booking-a",
        member: {
          id: "member-a",
          firstName: "Amy",
          lastName: "Adams",
          email: "amy@example.test",
        },
      }),
    ] as any);

    const result = await listAdminBookings(
      adminBookingsQuerySchema.parse({
        sortBy: "member",
        sortDir: "asc",
      }),
      {},
      TEST_CLUB_DAY,
    );

    expect(result.bookings.map((booking) => booking.id)).toEqual([
      "booking-a",
      "booking-z",
    ]);
  });

  it("hides soft-deleted bookings by default", async () => {
    await AdminBookingsPage({
      searchParams: Promise.resolve({}),
    });

    const callArgs = vi.mocked(prisma.booking.findMany).mock.calls[0][0] as any;
    expect(callArgs.where.deletedAt).toBeNull();
  });

  it("can filter to deleted bookings only", async () => {
    await AdminBookingsPage({
      searchParams: Promise.resolve({
        deleted: "only",
      }),
    });

    const callArgs = vi.mocked(prisma.booking.findMany).mock.calls[0][0] as any;
    expect(callArgs.where.deletedAt).toEqual({ not: null });
  });

  it("filters bookings by missing Xero invoice state", async () => {
    vi.mocked(prisma.booking.findMany).mockResolvedValue([
      makeBooking({
        id: "booking-missing",
        payment: {
          id: "payment-missing",
          source: "STRIPE",
          status: "SUCCEEDED",
          xeroInvoiceId: null,
          xeroInvoiceNumber: null,
          refundedAmountCents: 0,
        },
      }),
      makeBooking({
        id: "booking-linked",
        payment: {
          id: "payment-linked",
          source: "STRIPE",
          status: "SUCCEEDED",
          xeroInvoiceId: "inv-1",
          xeroInvoiceNumber: "INV-1",
          refundedAmountCents: 0,
        },
      }),
    ] as any);

    const result = await listAdminBookings(
      adminBookingsQuerySchema.parse({ xeroState: "invoiceMissing" }),
      {},
      TEST_CLUB_DAY,
    );

    expect(result.bookings.map((booking) => booking.id)).toEqual(["booking-missing"]);
    expect(result.bookings[0].operational.xeroState).toBe("invoiceMissing");
  });

  it("filters bookings by no-payment source", async () => {
    // paymentSource maps to a SQL predicate (#1884), so the mock must apply
    // the where.payment filter like the database would.
    installAdminBookingsDbMock([
      makeBooking({ id: "booking-none", payment: null }),
      makeBooking({
        id: "booking-stripe",
        payment: {
          id: "payment-stripe",
          source: "STRIPE",
          status: "SUCCEEDED",
          xeroInvoiceId: "inv-1",
          xeroInvoiceNumber: "INV-1",
          refundedAmountCents: 0,
        },
      }),
    ]);

    const result = await listAdminBookings(
      adminBookingsQuerySchema.parse({ paymentSource: "NONE" }),
      {},
      TEST_CLUB_DAY,
    );

    expect(result.bookings.map((booking) => booking.id)).toEqual(["booking-none"]);
  });

  it("filters bookings by bed allocation and change state", async () => {
    const guest = {
      id: "guest-1",
      firstName: "Tama",
      lastName: "Guest",
      ageTier: "ADULT",
      isMember: false,
      stayStart: new Date("2026-07-01T00:00:00.000Z"),
      stayEnd: new Date("2026-07-03T00:00:00.000Z"),
      // #2628: bed state is now counted off the guest's night rows, which the
      // service always loads, so the fixture carries the two nights its
      // half-open envelope describes — the 1st and the 2nd.
      nights: [
        { stayDate: new Date("2026-07-01T00:00:00.000Z") },
        { stayDate: new Date("2026-07-02T00:00:00.000Z") },
      ],
    };
    vi.mocked(prisma.booking.findMany).mockResolvedValue([
      makeBooking({
        id: "booking-unallocated",
        guests: [guest],
        changeRequests: [{ id: "request-1", status: "REQUESTED", createdAt: new Date(), linkedModificationId: null }],
      }),
      makeBooking({
        id: "booking-clean",
        guests: [guest],
        bedAllocations: [
          {
            id: "allocation-1",
            bookingId: "booking-clean",
            bookingGuestId: "guest-1",
            roomId: "room-1",
            bedId: "bed-1",
            stayDate: new Date("2026-07-01T00:00:00.000Z"),
            approvedAt: new Date("2026-06-01T00:00:00.000Z"),
            bookingGuest: {
              id: "guest-1",
              firstName: "Tama",
              lastName: "Guest",
              ageTier: "ADULT",
            },
            room: { id: "room-1", name: "Room 1" },
            bed: { id: "bed-1", name: "Bed 1" },
          },
          {
            id: "allocation-2",
            bookingId: "booking-clean",
            bookingGuestId: "guest-1",
            roomId: "room-1",
            bedId: "bed-1",
            stayDate: new Date("2026-07-02T00:00:00.000Z"),
            approvedAt: new Date("2026-06-01T00:00:00.000Z"),
            bookingGuest: {
              id: "guest-1",
              firstName: "Tama",
              lastName: "Guest",
              ageTier: "ADULT",
            },
            room: { id: "room-1", name: "Room 1" },
            bed: { id: "bed-1", name: "Bed 1" },
          },
        ],
      }),
    ] as any);

    const result = await listAdminBookings(
      adminBookingsQuerySchema.parse({
        bedState: "unallocated",
        changeState: "pendingRequest",
      }),
      {},
      TEST_CLUB_DAY,
    );

    expect(result.bookings.map((booking) => booking.id)).toEqual(["booking-unallocated"]);
    expect(result.bookings[0].operational.bedState).toBe("unallocated");
    expect(result.bookings[0].operational.pendingChangeRequest).toBe(true);
  });

  it("ignores bed allocation filters when the module is disabled", async () => {
    vi.mocked(prisma.booking.findMany).mockResolvedValue([
      makeBooking({
        id: "booking-clean",
        guests: [
          {
            id: "guest-1",
            firstName: "Tama",
            lastName: "Guest",
            ageTier: "ADULT",
            isMember: false,
            stayStart: new Date("2026-07-01T00:00:00.000Z"),
            stayEnd: new Date("2026-07-03T00:00:00.000Z"),
            // #2628: the service always loads the night rows, so the fixture
            // carries the nights its envelope describes — the 1st and the 2nd.
            nights: [
              { stayDate: new Date("2026-07-01T00:00:00.000Z") },
              { stayDate: new Date("2026-07-02T00:00:00.000Z") },
            ],
          },
        ],
      }),
    ] as any);

    const result = await listAdminBookings(
      adminBookingsQuerySchema.parse({ bedState: "unallocated" }),
      { bedAllocationEnabled: false },
      TEST_CLUB_DAY,
    );

    expect(result.bookings.map((booking) => booking.id)).toEqual(["booking-clean"]);
    expect(result.bookings[0].operational.expectedGuestNights).toBe(0);
  });

  it("hides bed allocation booking UI when the effective module is disabled", async () => {
    vi.mocked(loadEffectiveModuleFlags).mockResolvedValueOnce({
      ...effectiveModulesOn,
      bedAllocation: false,
    });
    vi.mocked(prisma.booking.findMany).mockResolvedValue([
      makeBooking({
        guests: [
          {
            id: "guest-1",
            firstName: "Tama",
            lastName: "Guest",
            ageTier: "ADULT",
            isMember: false,
            stayStart: new Date("2026-07-01T00:00:00.000Z"),
            stayEnd: new Date("2026-07-03T00:00:00.000Z"),
            // #2628: the service always loads the night rows, so the fixture
            // carries the nights its envelope describes — the 1st and the 2nd.
            nights: [
              { stayDate: new Date("2026-07-01T00:00:00.000Z") },
              { stayDate: new Date("2026-07-02T00:00:00.000Z") },
            ],
          },
        ],
      }),
    ] as any);

    const element = await AdminBookingsPage({
      searchParams: Promise.resolve({ bedState: "unallocated" }),
    });
    const html = renderToStaticMarkup(element);

    expect(html).toContain("All Bookings");
    expect(html).toContain("Aroha Ngata");
    // The redesigned table (#1810) keeps a Payment column; the operational
    // Beds/Xero/Changes columns moved to the booking detail view.
    expect(html).toContain("Payment");
    expect(html).not.toContain("/admin/bed-allocation");
    expect(html).not.toContain("bedState=unallocated");
    expect(html).not.toContain(">Beds<");
    expect(html).not.toContain("Unallocated");
  });

  it("disables booking creation for a bookings view-only admin", async () => {
    vi.mocked(auth).mockResolvedValueOnce({
      user: {
        id: "admin-readonly",
        accessRoles: [{ role: "ADMIN_READONLY" }],
      },
    } as any);

    const element = await AdminBookingsPage({
      searchParams: Promise.resolve({}),
    });
    const html = renderToStaticMarkup(element);

    expect(html).toContain("+ Create Booking");
    expect(html).toContain("disabled");
    expect(html).toContain(ADMIN_VIEW_ONLY_ACTION_REASON);
    expect(html).not.toContain('href="/admin/book"');
  });

  it("does not render pagination controls when everything fits on one page", async () => {
    installAdminBookingsDbMock([
      makeBooking({ id: "booking-1" }),
      makeBooking({ id: "booking-2" }),
    ]);

    const element = await AdminBookingsPage({
      searchParams: Promise.resolve({}),
    });
    const html = renderToStaticMarkup(element);

    expect(html).not.toContain("Bookings pagination");
  });

  it("renders pagination controls and preserves the page on sort links (#1738)", async () => {
    const fixtures = Array.from({ length: 101 }, (_, i) =>
      makeBooking({ id: `b${String(i).padStart(3, "0")}` })
    );
    installAdminBookingsDbMock(fixtures);

    const element = await AdminBookingsPage({
      searchParams: Promise.resolve({ page: "2" }),
    });
    const html = renderToStaticMarkup(element);

    // Accessible pagination nav with the current-of-total position.
    expect(html).toContain('aria-label="Bookings pagination"');
    expect(html).toContain("Page 2 of 2");
    expect(html).toContain("101 bookings found");
    // Sort-header links keep the current page (sort reorders the same set).
    expect(html).toContain("sortBy=member");
    expect(html).toContain("page=2");
  });

  it("clamps an out-of-range page and its sort/pagination links to the last page (#1738)", async () => {
    const fixtures = Array.from({ length: 101 }, (_, i) =>
      makeBooking({ id: `b${String(i).padStart(3, "0")}` })
    );
    installAdminBookingsDbMock(fixtures);

    const element = await AdminBookingsPage({
      searchParams: Promise.resolve({ page: "99" }),
    });
    const html = renderToStaticMarkup(element);

    // Service clamps page 99 → 2; the page must render the clamped position and
    // every generated link (sort headers + pagination) must carry the clamped
    // page, never the raw out-of-range 99.
    expect(html).toContain("Page 2 of 2");
    expect(html).toContain("page=2");
    expect(html).not.toContain("page=99");
  });

  /*
    #2350: an upward change after payment leaves money uncollected while the
    booking's lifecycle status still reads PAID. Before this the list showed
    nothing at all, so the outstanding amount was invisible to every admin.
  */
  describe("outstanding additional payments (#2350)", () => {
    function paidPayment(overrides: Record<string, unknown> = {}) {
      return {
        id: "payment-1",
        source: "STRIPE",
        status: "SUCCEEDED",
        xeroInvoiceId: null,
        xeroInvoiceNumber: null,
        refundedAmountCents: 0,
        additionalAmountCents: 0,
        additionalPaymentStatus: null,
        ...overrides,
      };
    }

    async function renderRow(
      payment: Record<string, unknown> | null,
      bookingOverrides: Record<string, unknown> = {},
    ) {
      installAdminBookingsDbMock([makeBooking({ payment, ...bookingOverrides })]);
      return renderToStaticMarkup(
        await AdminBookingsPage({ searchParams: Promise.resolve({}) }),
      );
    }

    it("marks a booking with a pending addition as partly paid and names the amount", async () => {
      const html = await renderRow(
        paidPayment({
          additionalAmountCents: 21_000,
          additionalPaymentStatus: "PENDING",
        }),
      );

      expect(html).toContain("Partly paid");
      expect(html).toContain("$210.00 due");
      // The lifecycle chip is deliberately untouched: the stay IS confirmed.
      expect(html).toContain("Paid");
    });

    it("treats a FAILED addition exactly like a pending one", async () => {
      const html = await renderRow(
        paidPayment({
          additionalAmountCents: 4_550,
          additionalPaymentStatus: "FAILED",
        }),
      );

      expect(html).toContain("Partly paid");
      expect(html).toContain("$45.50 due");
    });

    it("shows a fully collected booking as paid with no amount due", async () => {
      const html = await renderRow(
        paidPayment({
          additionalAmountCents: 21_000,
          additionalPaymentStatus: "SUCCEEDED",
        }),
      );

      expect(html).not.toContain("Partly paid");
      expect(html).not.toContain("due");
      expect(html).toContain("Paid");
    });

    it("says nothing about settlement on a booking with no payment row", async () => {
      const html = await renderRow(null);

      expect(html).not.toContain("Partly paid");
      expect(html).not.toContain("due");
    });

    /*
      A cancelled booking keeps its delta columns exactly as they were, so an
      amount-only owed test put an amber "$210.00 due" beside a Cancelled status
      chip — the row contradicting itself about whether the club wants money.
    */
    it("says nothing is due on a booking whose lifecycle ended the obligation", async () => {
      const html = await renderRow(
        paidPayment({
          additionalAmountCents: 21_000,
          additionalPaymentStatus: "FAILED",
        }),
        { status: "CANCELLED" },
      );

      expect(html).not.toContain("Partly paid");
      expect(html).not.toContain("$210.00 due");
    });

    /*
      Settlement reports the DISAGREEMENT with lifecycle, nothing else: a fully
      paid row already carries a "Paid" status chip, and a second identical chip
      immediately beside it in the next column is pure noise.
    */
    it("does not repeat the Paid chip when settlement agrees with lifecycle", async () => {
      const html = await renderRow(paidPayment());

      expect(html.match(/>Paid</g) ?? []).toHaveLength(1);
    });
  });

  it("formats total guests with non-member guests in brackets", () => {
    expect(formatAdminBookingGuestCount(6, 2)).toBe("6 (2 non-members)");
    expect(formatAdminBookingGuestCount(1, 1)).toBe("1 (1 non-member)");
  });

  /**
   * CT-4 (#2870): "Last updated" is a real INSTANT, so it has no civil date
   * until a zone is chosen, and `INV-CONFIG-002` says which — the PERSISTED
   * `ClubTimeSettings.timeZone`, read on the server, never `APP_TIME_ZONE`.
   *
   * ## Why this test had to exist before the claim could be believed
   *
   * `loadPersistedClubTimeSettings` is fail-soft three ways: no row, an
   * unreachable database, and a MISSING PRISMA DELEGATE all resolve to "nothing
   * persisted", and every one of them then falls back to the environment. Unit
   * tests run with a deliberately unreachable `DATABASE_URL`, so before the
   * delegate was added to this file's mock EVERY date on this page rendered
   * through `APP_TIME_ZONE` here — and nothing could tell, because that is also
   * what the code being replaced did. A whole page's worth of assertions was
   * agreeing with the defect.
   *
   * ## What makes the assertion discriminating
   *
   * The persisted zone is picked so it disagrees with the environment about
   * THIS instant, on whatever host the suite runs on. The stay dates beside it
   * are `@db.Date` calendar days and must NOT move with it — they are the
   * control, and a formatter that projected them would fail here too.
   */
  it("renders Last updated in the PERSISTED club zone, not APP_TIME_ZONE", async () => {
    const UPDATED_AT = new Date("2026-06-01T00:00:00.000Z");
    const dayIn = (zone: string) =>
      new Intl.DateTimeFormat(APP_LOCALE, {
        timeZone: zone,
        dateStyle: "medium",
      }).format(UPDATED_AT);
    const chosen = chooseDivergentClubZone({
      subject: "the civil day of a booking's updatedAt",
      answerKey: "day",
      cases: [
        { zone: "America/Denver", day: "31 May 2026" }, // −6: still 31 May
        { zone: "Pacific/Kiritimati", day: "1 Jun 2026" }, // +14: already 1 June
      ],
      answerFor: dayIn,
    });
    const environmentDay = dayIn(APP_TIME_ZONE);
    expect(chosen.day).not.toBe(environmentDay);

    vi.mocked(prisma.clubTimeSettings.findUnique).mockResolvedValue({
      timeZone: chosen.zone,
    } as never);
    vi.mocked(prisma.booking.findMany).mockResolvedValue([
      makeBooking({ updatedAt: UPDATED_AT }),
    ] as never);
    vi.mocked(prisma.booking.count).mockResolvedValue(1);

    const html = renderToStaticMarkup(
      await AdminBookingsPage({ searchParams: Promise.resolve({}) }),
    );

    expect(html).toContain(chosen.day);
    expect(html).not.toContain(environmentDay);
    // The control: the stay's `@db.Date` columns are calendar days and carry no
    // zone, so they read the same here as they would for any club on earth.
    expect(html).toContain("1 Jul 2026");
    expect(html).toContain("3 Jul 2026");
  });
});
