import { beforeEach, describe, expect, it, vi } from "vitest";
import { dateOnlyFromParts } from "@/lib/date-only";
import { AdminReviewStatus } from "@prisma/client";
import { ADULT_SUPERVISION_REVIEW_REASON } from "@/lib/booking-review";

// F27 / #1372 + #1422: a booking blocked by a pending admin review must not be
// checkable-in at the lodge. #1422 broadened the block to ANY pending admin
// review (reason-agnostic) and changed the guest LIST to INCLUDE-but-FLAG the
// blocked booking (staff see it, arrival disabled) while the mutation paths
// (arrive/depart, roster generate/confirm) keep EXCLUDING it. These tests prove
// the shared where-fragment reaches each enforcement query, the guest list
// surfaces `blockedFromCheckin`, the arrive endpoint still 404s a blocked
// booking, and the admin alert sender is wired to sendToAdmins.

const prismaMocks = vi.hoisted(() => ({
  bookingGuestFindFirst: vi.fn(),
  bookingGuestFindMany: vi.fn(),
  bookingFindMany: vi.fn(),
  choreTemplateFindMany: vi.fn(),
  choreAssignmentFindMany: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    bookingGuest: {
      findFirst: prismaMocks.bookingGuestFindFirst,
      findMany: prismaMocks.bookingGuestFindMany,
    },
    booking: { findMany: prismaMocks.bookingFindMany },
    choreTemplate: { findMany: prismaMocks.choreTemplateFindMany },
    choreAssignment: { findMany: prismaMocks.choreAssignmentFindMany },
  },
}));

const lodgeAuthMocks = vi.hoisted(() => ({
  checkLodgeAuth: vi.fn(),
  resolveKioskLodgeId: vi.fn(),
}));
vi.mock("@/lib/lodge-auth", () => ({
  checkLodgeAuth: lodgeAuthMocks.checkLodgeAuth,
  getLodgeAuthActorMemberId: vi.fn(() => "actor-1"),
  resolveKioskLodgeId: lodgeAuthMocks.resolveKioskLodgeId,
}));

vi.mock("@/lib/logger", () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Spy on the shared fan-out so the sender test asserts the exact envelope
// (subject / templateName / preferenceKey) without a live email stack.
const sharedMocks = vi.hoisted(() => ({ sendToAdmins: vi.fn() }));
vi.mock("@/lib/email/admin-alerts-shared", () => ({
  sendToAdmins: sharedMocks.sendToAdmins,
  getAdminEmails: vi.fn(),
}));

import {
  findLodgeGuestForDate,
  findLodgeGuestDepartingOnDate,
  validateRosterAllocationsForDate,
} from "@/lib/lodge-date-scoping";
import { routeParams } from "@/lib/__tests__/helpers/requests";

// #1422 / #2586: the reason-agnostic enforcement fragment admits bookings
// requiring no review or carrying explicit approval. Pending, rejected, and
// malformed unresolved review states all remain excluded.
const REVIEW_ALLOWED_FRAGMENT = {
  OR: [
    { requiresAdminReview: false },
    { adminReviewStatus: AdminReviewStatus.APPROVED },
  ],
};

/**
 * A `@db.Date` calendar day, which round-trips as exactly UTC midnight.
 *
 * This used to be `new Date(y, m, d)` — HOST-LOCAL midnight, so on a UTC+12 host
 * it produced noon UTC on the PREVIOUS day. PostgreSQL cannot keep a time in a
 * `date` column, so the fixture described a row that cannot exist, and it read
 * back correctly only while every reader projected it through the same host zone
 * that undid the offset. A helper called `dateOnly` handing back a value carrying
 * a time of day is the `INV-DATE-019` defect wearing the right name.
 *
 * Two lanes found this independently — #3107 through the stored-day decode and
 * #3113 through the calendar-day formatter, which now refuses such a value
 * outright. `dateOnlyFromParts` is preferred over `Date.UTC` because `Date.UTC`
 * maps years 0-99 to 1900-1999, which a fixture helper must not do silently.
 */
function dateOnly(y: number, m: number, d: number) {
  return dateOnlyFromParts(y, m, d);
}

describe("lodge check-in blocks a pending minors-only review (#1372)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    lodgeAuthMocks.checkLodgeAuth.mockResolvedValue({ tier: "lodge" });
    lodgeAuthMocks.resolveKioskLodgeId.mockResolvedValue("lodge-1");
  });

  it("arrive lookup (findLodgeGuestForDate) excludes the blocked booking", async () => {
    prismaMocks.bookingGuestFindFirst.mockResolvedValueOnce(null);

    await findLodgeGuestForDate("guest-1", dateOnly(2026, 6, 10));

    expect(prismaMocks.bookingGuestFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          booking: expect.objectContaining(REVIEW_ALLOWED_FRAGMENT),
        }),
      }),
    );
  });

  it("depart lookup (findLodgeGuestDepartingOnDate) excludes the blocked booking", async () => {
    prismaMocks.bookingGuestFindFirst.mockResolvedValueOnce(null);

    await findLodgeGuestDepartingOnDate("guest-1", dateOnly(2026, 6, 12));

    expect(prismaMocks.bookingGuestFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          booking: expect.objectContaining(REVIEW_ALLOWED_FRAGMENT),
        }),
      }),
    );
  });

  it("roster confirm validation (validateRosterAllocationsForDate) excludes the blocked booking", async () => {
    prismaMocks.bookingGuestFindMany.mockResolvedValueOnce([]);

    await validateRosterAllocationsForDate(
      [{ bookingGuestId: "guest-1", bookingId: "booking-1" }],
      dateOnly(2026, 6, 10),
    );

    expect(prismaMocks.bookingGuestFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          booking: expect.objectContaining(REVIEW_ALLOWED_FRAGMENT),
        }),
      }),
    );
  });

  it("#1422: lodge guest list INCLUDES the blocked booking and flags it", async () => {
    // The blocked booking is NOT filtered out of the guest-list query...
    prismaMocks.bookingFindMany.mockResolvedValueOnce([
      {
        id: "booking-blocked",
        checkIn: dateOnly(2026, 6, 10),
        checkOut: dateOnly(2026, 6, 12),
        expectedArrivalTime: "15:00",
        // Pending admin review => blockedFromCheckin should be true.
        requiresAdminReview: true,
        adminReviewStatus: AdminReviewStatus.PENDING,
        adminReviewReason: ADULT_SUPERVISION_REVIEW_REASON,
        member: { firstName: "Alex", lastName: "Parent" },
        guests: [
          {
            id: "guest-blocked",
            firstName: "Kid",
            lastName: "Parent",
            ageTier: "YOUTH",
            isMember: false,
            arrivedAt: null,
            departedAt: null,
            member: null,
            // #2628: the guests route always loads the night rows and answers
            // presence from them, so the fixture states its own stay — the two
            // nights the booking's 10th-to-12th envelope always described.
            stayStart: dateOnly(2026, 6, 10),
            stayEnd: dateOnly(2026, 6, 12),
            nights: [
              { stayDate: dateOnly(2026, 6, 10) },
              { stayDate: dateOnly(2026, 6, 11) },
            ],
          },
        ],
      },
    ]);
    const { GET } = await import("@/app/api/lodge/guests/[date]/route");

    const res = await GET(
      new Request(
        "http://localhost/api/lodge/guests/2026-07-10",
      ) as never,
      routeParams({ date: "2026-07-10" }),
    );

    expect(res.status).toBe(200);
    // ...the query no longer carries the block where-fragment...
    const call = prismaMocks.bookingFindMany.mock.calls[0][0];
    expect(call.where).not.toHaveProperty("NOT");
    // ...and the response surfaces the booking flagged blockedFromCheckin.
    const data = await res.json();
    expect(data.bookings).toHaveLength(1);
    expect(data.bookings[0].bookingId).toBe("booking-blocked");
    expect(data.bookings[0].blockedFromCheckin).toBe(true);
  });

  it("roster generate query excludes the blocked booking", async () => {
    lodgeAuthMocks.checkLodgeAuth.mockResolvedValue({ tier: "hut-leader" });
    prismaMocks.bookingFindMany.mockResolvedValueOnce([]);
    prismaMocks.choreTemplateFindMany.mockResolvedValueOnce([]);
    prismaMocks.choreAssignmentFindMany.mockResolvedValueOnce([]);
    const { POST } = await import("@/app/api/lodge/roster/[date]/generate/route");

    const res = await POST(
      new Request("http://localhost/api/lodge/roster/2026-07-10/generate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ choreTemplateIds: ["chore-1"] }),
      }) as never,
      routeParams({ date: "2026-07-10" }),
    );

    expect(res.status).toBe(200);
    expect(prismaMocks.bookingFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining(REVIEW_ALLOWED_FRAGMENT),
      }),
    );
  });

  it("#1422: arrive endpoint 404s a blocked booking (server enforcement intact)", async () => {
    // findLodgeGuestForDate excludes the blocked booking via its where-fragment,
    // so the guest resolves to null and the arrive endpoint rejects it even
    // though the guest list now shows it flagged.
    prismaMocks.bookingGuestFindFirst.mockResolvedValueOnce(null);
    const { PUT } = await import("@/app/api/lodge/guests/[date]/arrive/route");

    const res = await PUT(
      new Request("http://localhost/api/lodge/guests/2026-07-10/arrive", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ bookingGuestId: "guest-blocked" }),
      }) as never,
      routeParams({ date: "2026-07-10" }),
    );

    expect(res.status).toBe(404);
    expect(prismaMocks.bookingGuestFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          booking: expect.objectContaining(REVIEW_ALLOWED_FRAGMENT),
        }),
      }),
    );
  });
});

describe("sendAdminMinorsOnlyReviewAlert (#1372 / #1422)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("alerts opted-in admins with a minors-only subject and template", async () => {
    sharedMocks.sendToAdmins.mockResolvedValueOnce(undefined);
    const { sendAdminMinorsOnlyReviewAlert } = await import(
      "@/lib/email/admin-alerts-booking"
    );

    await sendAdminMinorsOnlyReviewAlert({
      memberName: "Alex Parent",
      checkIn: dateOnly(2026, 6, 10),
      checkOut: dateOnly(2026, 6, 12),
      guestCount: 2,
      reviewReason: ADULT_SUPERVISION_REVIEW_REASON,
    });

    expect(sharedMocks.sendToAdmins).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: expect.stringContaining("only under-18 guests"),
        templateName: "admin-minors-review",
        // #1422: fires on its own "Booking review required" preference so
        // muting routine new-booking alerts does not silence this review alert.
        preferenceKey: "adminBookingReviewRequired",
        templateData: expect.objectContaining({
          memberName: "Alex Parent",
          guestCount: 2,
          reviewReason: ADULT_SUPERVISION_REVIEW_REASON,
        }),
      }),
    );
  });
});
