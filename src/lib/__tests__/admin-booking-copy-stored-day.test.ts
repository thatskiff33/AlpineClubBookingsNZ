/**
 * #3107 - the admin booking copy shifts STORED calendar days, and the four
 * reads that make up the shift move as one.
 *
 * ## The defect this file exists to keep closed
 *
 * `copyBookingToDraft` derives a copy from four `@db.Date` reads: the source
 * booking's `checkIn` / `checkOut`, which give `nights` and `shiftDays`, and each
 * guest's `stayStart` / `stayEnd`, which are shifted by that many days. All four
 * used to be read with `normalizeDateOnlyForTimeZone`, which projects a stored
 * UTC-midnight day through the configured zone.
 *
 * On a zone whose UTC offset keeps ONE SIGN that projection is a uniform
 * one-day shift, and the four errors CANCEL: `shiftDays` is measured from a
 * projected `sourceCheckIn` to a zone-free `newCheckIn` (`parseDateOnly` of the
 * admin's requested date), so it absorbed exactly the offset the projected guest
 * bounds carried back out. The copy came out right, by luck rather than by
 * construction - and fixing only the guest bounds would have BROKEN it, moving a
 * copied stay a day LATE.
 *
 * The cancellation fails where the projection is not a uniform shift: a zone
 * whose offset CHANGES SIGN across DST. A source booking straddling that change
 * then loses a night, and a guest's stay shrinks with it.
 *
 * `stored-night-decode-azores-dst.test.ts` is where that zone choice is
 * established rather than restated here: swept across all 418 IANA zones for
 * 2026, `Atlantic/Azores` is the ONLY one that changes sign (UTC-1 standard,
 * UTC+0 summer), and nothing restricts a club to a list - `club-time/zone.ts`
 * validates the format, not membership. That file takes the March transition on
 * the stay-range module; this one takes the OCTOBER transition on the copy, so
 * the two do not overlap in either subject or direction.
 *
 * ## Why the existing suite could not catch it
 *
 * `admin-booking-copy.test.ts` runs on the default configured zone, which is
 * `Pacific/Auckland` - ahead of Greenwich, where the projection is the identity
 * and every one of these values is already right. This file pins the configured
 * zone to `Atlantic/Azores` with a module mock and copies a booking across the
 * 2026 change (25 October), which is the one arrangement that separates a
 * decode from a projection here.
 *
 * The first case asserts the premise, so nothing below can pass vacuously.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * The sign-changing zone, declared ONCE (#3123). `vi.mock` factories hoist above
 * every plain `const`, so before this the zone was written out twice - as the
 * mock's literal, and implicitly again as the projection helper's default - and
 * only one of the two was pinned by the premise below. `vi.hoisted` lets the
 * factory and the assertions name the same declaration, so they can no longer
 * drift apart.
 */
const { SIGN_CHANGE_ZONE } = vi.hoisted(() => ({
  SIGN_CHANGE_ZONE: "Atlantic/Azores",
}));

// `APP_TIME_ZONE` is frozen at module load, so the configured zone has to move
// above the imports.
vi.mock("@/config/operational", () => ({
  APP_CURRENCY: "NZD",
  APP_STRIPE_CURRENCY: "nzd",
  APP_TIME_ZONE: SIGN_CHANGE_ZONE,
  APP_LOCALE: "en-NZ",
}));

const mocks = vi.hoisted(() => ({
  bookingFindUnique: vi.fn(),
  createDraftBooking: vi.fn(),
  logAudit: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    booking: { findUnique: mocks.bookingFindUnique },
    member: { findMany: vi.fn() },
    familyGroupMember: { findMany: vi.fn() },
  },
}));

vi.mock("@/lib/booking-create", () => ({
  createDraftBooking: mocks.createDraftBooking,
}));

vi.mock("@/lib/audit", () => ({ logAudit: mocks.logAudit }));

vi.mock("@/lib/booking-guests", () => ({
  BookingGuestValidationError: class BookingGuestValidationError extends Error {
    constructor(
      message: string,
      public status: number,
    ) {
      super(message);
    }
  },
  resolveLinkedBookingMembersWithBoundary: vi.fn().mockResolvedValue({
    members: new Map(),
    boundary: { scopeByMemberId: new Map(), beyondFamilyMemberIds: [] },
  }),
  assertLinkedBookingMembersCanBeBooked: vi.fn().mockResolvedValue(undefined),
  // The dates are what this file measures, so the guest inputs pass straight
  // through: every fixture guest below is a non-member, which is also what keeps
  // the consent machinery inert.
  normalizeBookingGuestInputs: vi.fn((guests: unknown) => guests),
}));

vi.mock("@/lib/member-guest-add-policy", () => ({
  loadMemberGuestAddPolicy: vi.fn().mockResolvedValue({ wideningEnabled: false }),
  planMemberGuestConsentWrites: vi.fn(({ guests }: { guests: unknown[] }) => ({
    guests,
    entriesByMemberId: new Map(),
  })),
  matchMemberGuestNotificationRows: vi.fn(() => []),
}));

import { APP_TIME_ZONE } from "@/config/operational";
import { copyBookingToDraft } from "@/lib/admin-booking-copy";
import { formatDateOnlyForTimeZone, parseDateOnly } from "@/lib/date-only";

/** A `@db.Date` value: the calendar day encoded at UTC midnight. */
function day(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

/** The `yyyy-mm-dd` day a `Date` handed to the create service carries, in UTC. */
function storedDay(value: Date): string {
  return value.toISOString().slice(0, 10);
}

/**
 * The source booking STRADDLES the 2026 Azores change (25 October).
 *
 * Read at UTC midnight through that zone: 10-24 and 10-25 fall inside DST
 * (UTC+0) and project to themselves, while 10-26 and 10-27 fall outside it
 * (UTC-1) and project back a day. So the source span 10-24 -> 10-27 projected to
 * 10-24 -> 10-26, three stored nights read as two.
 */
const SOURCE_CHECK_IN = "2026-10-24";
const SOURCE_CHECK_OUT = "2026-10-27";
const GUEST_STAY_START = "2026-10-24";
const GUEST_STAY_END = "2026-10-26";
/** Comfortably after the frozen clock, so the past-target guard is not the subject. */
const TARGET_CHECK_IN = "2026-12-01";

function makeSourceBooking() {
  return {
    id: "source-booking",
    memberId: "member-1",
    checkIn: day(SOURCE_CHECK_IN),
    checkOut: day(SOURCE_CHECK_OUT),
    lodgeId: "lodge-b",
    deletedAt: null,
    notes: null,
    expectedArrivalTime: null,
    member: { id: "member-1", active: true },
    guests: [
      {
        id: "guest-1",
        firstName: "Nina",
        lastName: "Visitor",
        ageTier: "ADULT",
        isMember: false,
        memberId: null,
        stayStart: day(GUEST_STAY_START),
        stayEnd: day(GUEST_STAY_END),
      },
    ],
  };
}

async function copy() {
  await copyBookingToDraft({
    sourceBookingId: "source-booking",
    targetCheckIn: TARGET_CHECK_IN,
    adminMemberId: "admin-1",
  });
  return mocks.createDraftBooking.mock.calls[0][0] as {
    checkIn: Date;
    checkOut: Date;
    guests: Array<{ stayStart: Date; stayEnd: Date }>;
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.bookingFindUnique.mockResolvedValue(makeSourceBooking());
  mocks.createDraftBooking.mockResolvedValue({
    id: "draft-copy",
    status: "DRAFT",
    guests: [],
  });
});

describe("#3107 premise: the configured zone really changes sign across DST", () => {
  it("pins it, so nothing below measures the identity", () => {
    expect(APP_TIME_ZONE).toBe("Atlantic/Azores");
    // Inside DST the stored day reads as itself; outside it, a day early. It is
    // that DIFFERENCE, within one booking, that the old projection could not
    // survive - a uniform shift would have cancelled. The zone is named at each
    // call (#3123): these four lines model the REPLACED behaviour, so they have
    // to say which zone they model rather than inherit one.
    expect(formatDateOnlyForTimeZone(day("2026-10-24"), SIGN_CHANGE_ZONE)).toBe("2026-10-24");
    expect(formatDateOnlyForTimeZone(day("2026-10-25"), SIGN_CHANGE_ZONE)).toBe("2026-10-25");
    expect(formatDateOnlyForTimeZone(day("2026-10-26"), SIGN_CHANGE_ZONE)).toBe("2026-10-25");
    expect(formatDateOnlyForTimeZone(day("2026-10-27"), SIGN_CHANGE_ZONE)).toBe("2026-10-26");
  });
});

describe("#3107 the copy shifts the stored days, across a sign change", () => {
  it("keeps the source booking's night count", async () => {
    const input = await copy();
    expect(storedDay(input.checkIn)).toBe("2026-12-01");
    // THE MEASUREMENT. The source holds three nights (10-24, 10-25, 10-26).
    // Projected, `nights` came out 2 and the copy was 12-01 -> 12-03: the copied
    // booking silently lost a night the member had paid for on the original.
    expect(storedDay(input.checkOut)).toBe("2026-12-04");
  });

  it("shifts a guest's own stay by the same whole number of days", async () => {
    const input = await copy();
    const [guest] = input.guests;
    // The guest holds 10-24 and 10-25 - two nights - and the copy moves them
    // 38 days. Projected, `stayEnd` came back 12-02 instead of 12-03, so the
    // copied guest lost one of their two nights.
    expect(storedDay(guest.stayStart)).toBe("2026-12-01");
    expect(storedDay(guest.stayEnd)).toBe("2026-12-03");
  });

  it("keeps the guest's stay inside the booking it was copied into", async () => {
    const input = await copy();
    const [guest] = input.guests;
    // The straddle check: a guest whose stay ran past the copied booking's own
    // check-out would be a row contradicting its parent. Both sides are derived
    // from the same four reads, so this holds only while all four agree.
    expect(guest.stayStart >= input.checkIn).toBe(true);
    expect(guest.stayEnd <= input.checkOut).toBe(true);
  });

  it("preserves the source span exactly, so the copy is a translation", async () => {
    const input = await copy();
    const MS_PER_DAY = 24 * 60 * 60 * 1000;
    const sourceNights =
      (day(SOURCE_CHECK_OUT).getTime() - day(SOURCE_CHECK_IN).getTime()) /
      MS_PER_DAY;
    const copiedNights =
      (input.checkOut.getTime() - input.checkIn.getTime()) / MS_PER_DAY;
    // Derived from the fixture rather than hardcoded: whatever the source span
    // is, the copy's must equal it. That is the property, and it is what the
    // projection broke.
    expect(copiedNights).toBe(sourceNights);
    const shift =
      (input.checkIn.getTime() - day(SOURCE_CHECK_IN).getTime()) / MS_PER_DAY;
    expect(shift).toBe(
      (parseDateOnly(TARGET_CHECK_IN).getTime() -
        day(SOURCE_CHECK_IN).getTime()) /
        MS_PER_DAY,
    );
  });
});
