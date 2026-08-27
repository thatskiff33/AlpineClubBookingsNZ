import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * CT-4 (#2870): the stored stay days this route freezes into a proposal are
 * read in UTC and never projected through a timezone.
 *
 * `Booking.checkIn`/`checkOut`, `BookingGuest.stayStart`/`stayEnd` and
 * `BookingGuestNight.stayDate` are all `@db.Date`: a calendar day encoded as UTC
 * midnight and never a moment (INV-DATE-010), read back in UTC under
 * INV-DATE-019's first exact boundary with INV-DATE-026 — which are the citation
 * for a decode, and INV-DATE-010 is not (#3080).
 * The route used to hand every one of them to `normalizeDateOnlyForTimeZone`,
 * which projected the stored instant into `APP_TIME_ZONE` first. That is the
 * identity for a club ahead of Greenwich — which is why New Zealand never saw
 * it — and lands on the PREVIOUS evening for a club behind it, so the frozen
 * proposal a policy officer later approves described a stay one night earlier
 * than the one the member actually holds.
 *
 * ## WHAT THIS FILE PROVES, AND WHAT IT DOES NOT
 *
 * It proves zone-INDEPENDENCE, not zone-authority, and the distinction matters.
 * These call sites consult **no** zone at all after the change — a calendar date
 * takes none, ever — so mocking a persisted `ClubTimeSettings` row here would be
 * theatre: the route never reads one on this path, and a test built on that
 * would pass just as happily with the old projection restored. What discriminates
 * is pinning `APP_TIME_ZONE` (the only thing the replaced helper ever read) to a
 * zone BEHIND UTC and demanding the stored days survive it unchanged. The first
 * case measures the legacy answer directly, so the premise cannot go quiet.
 *
 * Independent of the host's own `TZ`: `APP_TIME_ZONE` is supplied by the mock.
 */

/*
 * The zone behind UTC, declared ONCE (#3123). `vi.mock` factories hoist above
 * every plain `const`, which is why the zone used to be inlined here; `vi.hoisted`
 * gives the factory and the premise assertion below the same declaration, so the
 * zone the mock pins and the zone the legacy projection is measured in cannot
 * drift apart.
 */
const { LEGACY_PROJECTION_ZONE } = vi.hoisted(() => ({
  LEGACY_PROJECTION_ZONE: "America/Denver",
}));

vi.mock("@/config/operational", () => ({
  APP_CURRENCY: "NZD",
  APP_STRIPE_CURRENCY: "nzd",
  APP_TIME_ZONE: LEGACY_PROJECTION_ZONE,
  APP_LOCALE: "en-NZ",
}));

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  requireActiveSessionUser: vi.fn(),
  checkRateLimit: vi.fn(),
  getClientIp: vi.fn(),
  logAudit: vi.fn(),
  sendAlert: vi.fn(),
  getDefaultLodgeId: vi.fn(),
  authzRole: vi.fn(),
  editPolicy: vi.fn(),
  bookingFindUnique: vi.fn(),
  createMod: vi.fn(),
  buildParties: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ auth: mocks.auth }));
vi.mock("@/lib/session-guards", () => ({
  requireActiveSessionUser: mocks.requireActiveSessionUser,
}));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: (...a: unknown[]) => mocks.checkRateLimit(...a),
  getClientIp: (...a: unknown[]) => mocks.getClientIp(...a),
  rateLimiters: {
    bookingChangeRequest: { id: "bcr", limit: 5, windowSeconds: 86400 },
  },
}));
vi.mock("@/lib/audit", () => ({ logAudit: (...a: unknown[]) => mocks.logAudit(...a) }));
vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/email", () => ({
  sendAdminBookingChangeRequestAlert: (...a: unknown[]) => mocks.sendAlert(...a),
}));
vi.mock("@/lib/lodges", () => ({
  getDefaultLodgeId: (...a: unknown[]) => mocks.getDefaultLodgeId(...a),
}));
vi.mock("@/lib/admin-permissions", () => ({
  bookingManagementAuthorizationRole: (...a: unknown[]) => mocks.authzRole(...a),
}));
vi.mock("@/lib/booking-edit-policy", () => ({
  getBookingEditPolicy: (...a: unknown[]) => mocks.editPolicy(...a),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    booking: { findUnique: (...a: unknown[]) => mocks.bookingFindUnique(...a) },
  },
}));
vi.mock("@/lib/booking-exception-request-service", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/booking-exception-request-service")>();
  return {
    ...actual,
    // Recorded, then delegated: the assertions are about the ARGUMENTS the
    // route builds, which is where the projection used to happen.
    buildModificationProposalParties: (
      ...a: Parameters<typeof actual.buildModificationProposalParties>
    ) => {
      mocks.buildParties(...a);
      return actual.buildModificationProposalParties(...a);
    },
    createModificationExceptionRequest: (...a: unknown[]) => mocks.createMod(...a),
  };
});

import { formatDateOnlyForTimeZone } from "@/lib/date-only";
import { POST } from "@/app/api/bookings/[id]/exception-requests/route";

/** The stored `@db.Date` days on the fixture booking. */
const STORED_CHECK_IN = "2026-07-04";
const STORED_CHECK_OUT = "2026-07-06";

function day(value: string) {
  return new Date(`${value}T00:00:00.000Z`);
}

function makeBooking() {
  return {
    id: "booking-1",
    memberId: "m1",
    status: "CONFIRMED",
    checkIn: day(STORED_CHECK_IN),
    checkOut: day(STORED_CHECK_OUT),
    lodgeId: "lodge_1",
    member: { firstName: "Ada", lastName: "Lovelace", email: "a@x.nz" },
    guests: [
      {
        id: "g1",
        firstName: "Ada",
        lastName: "Lovelace",
        ageTier: "ADULT",
        isMember: true,
        memberId: "m1",
        stayStart: day(STORED_CHECK_IN),
        stayEnd: day(STORED_CHECK_OUT),
        nights: [{ stayDate: day("2026-07-04") }, { stayDate: day("2026-07-05") }],
      },
    ],
  };
}

const params = { params: Promise.resolve({ id: "booking-1" }) };

function postReq(body: Record<string, unknown>) {
  return new NextRequest(
    "http://localhost/api/bookings/booking-1/exception-requests",
    {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockResolvedValue({ user: { id: "m1", email: "a@x.nz", name: "Ada", role: "member" } });
  mocks.requireActiveSessionUser.mockResolvedValue(null);
  mocks.checkRateLimit.mockResolvedValue({ success: true, resetAt: Date.now() + 1000 });
  mocks.getClientIp.mockReturnValue("0.0.0.0");
  mocks.getDefaultLodgeId.mockResolvedValue("lodge_1");
  mocks.authzRole.mockReturnValue("USER");
  mocks.editPolicy.mockReturnValue({
    canModify: true,
    today: day("2026-07-01"),
    editableFrom: null,
    mode: "future",
  });
  mocks.bookingFindUnique.mockResolvedValue(makeBooking());
  mocks.createMod.mockResolvedValue({
    id: "bcr-1",
    status: "REQUESTED",
    proposalHash: "b".repeat(64),
    reasonCodes: ["MINIMUM_STAY"],
    aggregateCapacityMode: "HOLD",
  });
  mocks.sendAlert.mockResolvedValue(undefined);
});

describe("stored stay days survive a club behind UTC (CT-4, #2870)", () => {
  it("PREMISE: the replaced helper really does move these days in this zone", () => {
    // Not an identifier comparison — the LEGACY ANSWER, measured. If this ever
    // equals the stored day the zone has stopped discriminating and every
    // assertion below is worthless, so it is asserted rather than assumed.
    // The zone is named rather than defaulted (#3123): this line models the
    // REPLACED helper, so it has to say which zone it models.
    expect(formatDateOnlyForTimeZone(day(STORED_CHECK_IN), LEGACY_PROJECTION_ZONE)).toBe("2026-07-03");
    expect(formatDateOnlyForTimeZone(day(STORED_CHECK_OUT), LEGACY_PROJECTION_ZONE)).toBe("2026-07-05");
  });

  it("freezes the proposal on the days the columns actually store", async () => {
    // MUTANT KILLED: `normalizeDateOnlyForTimeZone` anywhere on this path. Under
    // America/Denver every one of these values comes back a day early, so the
    // officer approves a stay the member does not hold.
    const res = await POST(
      postReq({ checkOut: "2026-07-07", memberMessage: "one more night" }),
      params,
    );
    expect(res.status).toBe(201);

    const [args] = mocks.buildParties.mock.calls.at(-1) as [
      {
        bookingCheckIn: Date;
        bookingCheckOut: Date;
        liveGuests: Array<{
          stayStart: Date;
          stayEnd: Date;
          nights: Array<{ stayDate: Date }>;
        }>;
      },
    ];

    expect(args.bookingCheckIn.toISOString()).toBe("2026-07-04T00:00:00.000Z");
    expect(args.bookingCheckOut.toISOString()).toBe("2026-07-06T00:00:00.000Z");
    expect(args.liveGuests[0].stayStart.toISOString()).toBe(
      "2026-07-04T00:00:00.000Z",
    );
    expect(args.liveGuests[0].stayEnd.toISOString()).toBe(
      "2026-07-06T00:00:00.000Z",
    );
    expect(args.liveGuests[0].nights.map((n) => n.stayDate.toISOString())).toEqual([
      "2026-07-04T00:00:00.000Z",
      "2026-07-05T00:00:00.000Z",
    ]);
  });
});
