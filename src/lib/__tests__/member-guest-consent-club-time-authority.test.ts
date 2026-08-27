import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #3123 (CT-4 group F) — the club's own timezone decides a member-guest consent
 * deadline, and a lodge night is decoded rather than projected.
 *
 * TWO SEPARATE DEFECTS LIVED IN `computeMemberGuestConsentExpiry`, and this file
 * is the proof for both. They are tested apart because fixing one and leaving
 * the other is the exact mistake this epic has already made once (#3100 shipped
 * the projection fix and armed the arithmetic one; #3107 was the other half).
 *
 * 1. **THE ZONE WAS OPTIONAL.** `timeZone?: string` defaulted through
 *    `@/lib/date-only` to `APP_TIME_ZONE`, and the sole production caller —
 *    `planMemberGuestConsentWrites`, through `member-guest-add-policy.ts` —
 *    passed nothing. So the instant a member's consent request lapsed was
 *    decided by whatever zone the container ran in, not by the club's persisted
 *    `ClubTimeSettings.timeZone` (`INV-CONFIG-002`). It is now a required,
 *    branded parameter, resolved ONCE per add and threaded on the policy value
 *    the eight call sites already pass.
 *
 * 2. **THE CHECK-IN WAS PROJECTED THROUGH THAT ZONE.** `Booking.checkIn` is
 *    `@db.Date` (`prisma/schema.prisma:1662`) — a CALENDAR DAY, encoded as UTC
 *    midnight (`INV-DATE-010`, `INV-DATE-026`) — and a calendar day takes no
 *    zone at all. Reading it back through the club's zone names the previous day
 *    for any club behind Greenwich, so the clamp landed a full day early. This
 *    one is wrong however good the zone is, which is why a required parameter on
 *    its own would not have fixed it.
 *
 * ## Why these fixtures and not tidier ones
 *
 * `APP_TIME_ZONE` is pinned to `Pacific/Auckland` — the shipped default and the
 * reader's own fallback — and every persisted zone below is something else. That
 * is deliberate and it is the only arrangement that discriminates: the club-zone
 * reader is fail-soft on a missing delegate, on a throwing query and on an absent
 * row, and each of those degrades silently to the environment. A suite that
 * persisted `Pacific/Auckland` would pass identically before and after the fix.
 *
 * The Prisma mock therefore carries a real `clubTimeSettings.findUnique`. Without
 * it the reader takes the missing-delegate path and answers `Pacific/Auckland`,
 * and every assertion here would be measuring the environment while claiming to
 * measure the club.
 */
vi.mock("@/config/operational", () => ({
  APP_CURRENCY: "NZD",
  APP_STRIPE_CURRENCY: "nzd",
  APP_TIME_ZONE: "Pacific/Auckland",
  APP_LOCALE: "en-NZ",
}));

const { mockClubTimeSettingsFindUnique, mockIsEffectiveModuleEnabled } =
  vi.hoisted(() => ({
    mockClubTimeSettingsFindUnique: vi.fn(),
    mockIsEffectiveModuleEnabled: vi.fn(),
  }));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    clubTimeSettings: { findUnique: mockClubTimeSettingsFindUnique },
  },
}));

vi.mock("@/lib/admin-modules", () => ({
  isEffectiveModuleEnabled: mockIsEffectiveModuleEnabled,
}));

vi.mock("@/lib/member-guest-settings", () => ({
  loadMemberGuestSettings: vi.fn(async () => ({
    approvalRequired: true,
    pendingHoldExpiryDays: 7,
    openMemberSearchEnabled: false,
    openMemberSearchIncludesMinors: false,
  })),
}));

import {
  clubCalendarDateOf,
  dateOnlyInstantOf,
  requireCalendarDate,
  requireClubTimeZone,
  startOfClubDay,
} from "@/lib/club-time";
import {
  loadMemberGuestAddPolicy,
  planMemberGuestConsentWrites,
} from "@/lib/member-guest-add-policy";
import {
  computeMemberGuestConsentExpiry,
  type MemberGuestBoundaryState,
} from "@/lib/member-guest-consent";

/** Six or seven hours BEHIND Greenwich — where the projection defect shows. */
const DENVER = requireClubTimeZone("America/Denver");
/** Twelve or thirteen AHEAD, and the environment's own answer here. */
const AUCKLAND = requireClubTimeZone("Pacific/Auckland");

/** A stored `@db.Date` lodge night, exactly as Prisma hands one back. */
const storedNight = (day: string) => dateOnlyInstantOf(requireCalendarDate(day));

const NOW = new Date("2026-08-01T02:00:00.000Z");
const CHECK_IN = storedNight("2026-08-04");

const OUTSIDER = "m-outsider";

function boundary(): MemberGuestBoundaryState {
  return {
    scopeByMemberId: new Map([[OUTSIDER, "BEYOND_FAMILY" as const]]),
    beyondFamilyMemberIds: [OUTSIDER],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockIsEffectiveModuleEnabled.mockResolvedValue(true);
  mockClubTimeSettingsFindUnique.mockResolvedValue({
    timeZone: "America/Denver",
    updatedByMemberId: null,
    updatedAt: new Date("2026-07-01T00:00:00.000Z"),
  });
});

describe("the deadline a member is given comes from the CLUB's zone (#3123)", () => {
  it("threads the persisted zone from the policy read all the way to the column", async () => {
    /*
      END TO END, and this is the assertion the epic actually cares about: the
      value that lands in `BookingGuest.consentExpiresAt` — the moment the sweep
      releases the bed and the moment the request email tells the member they
      have until — is named by `ClubTimeSettings.timeZone` and by nothing else.

      The clamp binds here (three days to check-in against a seven-day policy),
      so the answer IS the club-day boundary rather than the requested window.
    */
    const policy = await loadMemberGuestAddPolicy();
    expect(policy.wideningEnabled && policy.timeZone).toBe(DENVER);

    const plan = planMemberGuestConsentWrites({
      guests: [{ memberId: OUTSIDER, isMember: true }],
      boundary: boundary(),
      actor: { kind: "MEMBER" },
      now: NOW,
      bookingCheckIn: CHECK_IN,
      policy,
    });

    const expiresAt = plan.guests[0].memberGuestConsent!.consentExpiresAt!;
    expect(expiresAt).toEqual(
      startOfClubDay(requireCalendarDate("2026-08-03"), DENVER),
    );
    // And NOT the environment's answer, which this container really does hold.
    expect(expiresAt).not.toEqual(
      startOfClubDay(requireCalendarDate("2026-08-03"), AUCKLAND),
    );
  });

  it("follows the club when the club moves, rather than the container", async () => {
    // The same request, the same environment, a different persisted setting. If
    // anything here were still reading `APP_TIME_ZONE` the two runs would agree.
    const denver = await loadMemberGuestAddPolicy();

    mockClubTimeSettingsFindUnique.mockResolvedValue({
      timeZone: "Europe/London",
      updatedByMemberId: null,
      updatedAt: new Date("2026-07-01T00:00:00.000Z"),
    });
    const london = await loadMemberGuestAddPolicy();

    const expiryUnder = (policy: typeof denver) =>
      planMemberGuestConsentWrites({
        guests: [{ memberId: OUTSIDER, isMember: true }],
        boundary: boundary(),
        actor: { kind: "MEMBER" },
        now: NOW,
        bookingCheckIn: CHECK_IN,
        policy,
      }).guests[0].memberGuestConsent!.consentExpiresAt!;

    expect(expiryUnder(denver)).not.toEqual(expiryUnder(london));
    expect(expiryUnder(london)).toEqual(
      startOfClubDay(requireCalendarDate("2026-08-03"), requireClubTimeZone("Europe/London")),
    );
  });

  it("does not read the club's zone at all when the module is off", async () => {
    // The shipped state of every club (D-2), and the reason `MemberGuestAddPolicy`
    // is a union: with no widening there is no consent row to date, so the policy
    // read spends no `clubTimeSettings` query on the hot path of every booking
    // create, quote and guest add.
    mockIsEffectiveModuleEnabled.mockResolvedValue(false);

    const policy = await loadMemberGuestAddPolicy();

    expect(policy.wideningEnabled).toBe(false);
    expect(mockClubTimeSettingsFindUnique).not.toHaveBeenCalled();
  });
});

describe("a lodge night is decoded, never projected (#3123)", () => {
  it("gives a member behind Greenwich the SAME last day to answer as one ahead of it", () => {
    /*
      THE DEFECT, MEASURED, AND AS A MEMBER EXPERIENCES IT.

      `bookingCheckIn` is a calendar day. The old code read it back through the
      club's zone before subtracting a day, so for `America/Denver` a stored
      4 August was named 3 August, "the day before check-in" became 2 August, and
      the deadline moved 86,400,000 ms earlier — a whole day. What that costs a
      person: the consent-request email's "answer by" date, the card's "expires"
      chip and the nightly sweep that releases their bed all arrive a day before
      the club's own policy says they should.

      Asserted as the DAY each member is given rather than as an instant equality,
      because the instants legitimately differ — a club day starts at a different
      moment in each zone — while the day must not.

      MUTATION PROBE: decode `bookingCheckIn` with
      `clubCalendarDateOf(bookingCheckIn, timeZone)` in place of
      `calendarDateOfDateOnlyInstant(requireStoredCalendarDay(...))` and the
      Denver leg reads "2026-08-02" while the Auckland leg stays "2026-08-03".
    */
    const args = { now: NOW, pendingHoldExpiryDays: 7, bookingCheckIn: CHECK_IN };

    const denver = computeMemberGuestConsentExpiry({ ...args, timeZone: DENVER });
    const auckland = computeMemberGuestConsentExpiry({
      ...args,
      timeZone: AUCKLAND,
    });

    expect(clubCalendarDateOf(denver, DENVER)).toBe("2026-08-03");
    expect(clubCalendarDateOf(auckland, AUCKLAND)).toBe("2026-08-03");
    // The instants differ, and that is correct: 3 August begins nineteen hours
    // apart in the two clubs. Only the DAY has to agree.
    expect(denver).not.toEqual(auckland);
  });

  it("is exactly one day out under the old projection, on the deployment shape that shows it", () => {
    // The size of the defect, pinned so a future reader can see it was a whole
    // lodge day rather than an hour of daylight-saving drift.
    const correct = computeMemberGuestConsentExpiry({
      now: NOW,
      pendingHoldExpiryDays: 7,
      bookingCheckIn: CHECK_IN,
      timeZone: DENVER,
    });
    const projectedDay = clubCalendarDateOf(CHECK_IN, DENVER);
    const asShipped = startOfClubDay(
      requireCalendarDate("2026-08-02"),
      DENVER,
    );

    // The projection really does name the day before, which is the whole cause.
    expect(projectedDay).toBe("2026-08-03");
    expect(correct.getTime() - asShipped.getTime()).toBe(24 * 60 * 60 * 1000);
  });
});
