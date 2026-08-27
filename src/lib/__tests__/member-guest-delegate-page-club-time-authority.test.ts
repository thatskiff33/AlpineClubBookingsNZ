import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #3123 — the delegate consent page answers TWO temporal questions about one
 * person, and both used to come from the container's timezone.
 *
 *  - **the member's age**, shown to a family delegate deciding whether to
 *    consent on someone's behalf. `Member.dateOfBirth` is `@db.Date`
 *    (`prisma/schema.prisma:514`) — a calendar day, which takes no timezone —
 *    and this page held a SECOND, private copy of the age rule that projected
 *    it through `APP_TIME_ZONE` anyway. That is #3082, which `member-age.ts`
 *    had already fixed once; the local copy is gone and the shared answer is
 *    used.
 *  - **whether the stay has started**, which decides the refusal warning the
 *    delegate is shown before they click. `now` is a real instant, so it IS
 *    projected — through the club's persisted zone.
 *
 * The page's own comment already promised those two were worked out from the
 * same clock. They now come from one zone read as well.
 *
 * DISCRIMINATION. `APP_TIME_ZONE` is pinned to `Pacific/Auckland` — what the
 * removed code answered, and this codebase's own fallback, so it is the value a
 * half-done fix could still pass under. The persisted club zone is
 * `America/Denver`.
 *
 * THE `clubTimeSettings` DELEGATE IS NOT OPTIONAL ON THIS MOCK: the reader is
 * fail-soft three ways and every one degrades silently to the environment.
 */
vi.mock("@/config/operational", () => ({
  APP_CURRENCY: "NZD",
  APP_STRIPE_CURRENCY: "nzd",
  APP_TIME_ZONE: "Pacific/Auckland",
  APP_LOCALE: "en-NZ",
}));

const { mockClubTimeSettingsFindUnique, mockIsQuotePricedBooking } = vi.hoisted(
  () => ({
    mockClubTimeSettingsFindUnique: vi.fn(),
    mockIsQuotePricedBooking: vi.fn(),
  }),
);

vi.mock("@/lib/prisma", () => ({
  prisma: {
    clubTimeSettings: { findUnique: mockClubTimeSettingsFindUnique },
  },
}));

vi.mock("@/lib/booking-modify-validation", () => ({
  isQuotePricedBooking: (...args: unknown[]) => mockIsQuotePricedBooking(...args),
}));

import { APP_TIME_ZONE } from "@/config/operational";
import { resolveDelegateConsentPageState } from "@/lib/member-guest-delegate-page";

const utcMidnight = (day: string) => new Date(`${day}T00:00:00.000Z`);

/**
 * The instant under test. In Auckland it is 1 July 2026 at 12:00; in Denver it
 * is still 30 June at 18:00. Every assertion below turns on that one day.
 */
const NOW = new Date("2026-07-01T00:00:00.000Z");

function persistClubZone(timeZone: string) {
  mockClubTimeSettingsFindUnique.mockResolvedValue({
    timeZone,
    updatedByMemberId: null,
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  });
}

/**
 * Born 1 July 2008, stored as a `@db.Date`. On 1 July 2026 they turn 18; on 30
 * June they are still 17. Projecting that stored day into a zone behind
 * Greenwich lands on 30 June 2008 and reads the age a year short on the
 * member's own birthday — the #3082 defect, from the date-of-birth side.
 */
const DATE_OF_BIRTH = utcMidnight("2008-07-01");

function makeDb(checkIn: Date) {
  return {
    bookingGuest: {
      findUnique: vi.fn().mockResolvedValue({
        id: "guest-1",
        memberId: "target-1",
        firstName: "Ada",
        lastName: "Lovelace",
        consentStatus: "PENDING",
        consentRespondedAt: null,
        consentExpiresAt: null,
        stayStart: checkIn,
        stayEnd: utcMidnight("2026-08-05"),
        nights: [{ stayDate: checkIn }],
        booking: {
          id: "booking-1",
          lodgeId: "lodge-1",
          checkIn,
          checkOut: utcMidnight("2026-08-05"),
          status: "CONFIRMED",
          deletedAt: null,
          member: { firstName: "Grace", lastName: "Hopper" },
          guests: [
            { id: "guest-1", firstName: "Ada", lastName: "Lovelace" },
            { id: "guest-2", firstName: "Alan", lastName: "Turing" },
          ],
        },
      }),
    },
    member: {
      findUnique: vi.fn().mockResolvedValue({ dateOfBirth: DATE_OF_BIRTH }),
    },
  };
}

const delegateResolver = {
  canRespondForTarget: vi.fn().mockResolvedValue(true),
} as never;

async function askState(checkIn: Date) {
  const state = await resolveDelegateConsentPageState({
    guestId: "guest-1",
    viewerMemberId: "delegate-1",
    db: makeDb(checkIn) as never,
    delegateResolver,
    moduleEnabled: async () => true,
    now: NOW,
  });
  if (state.kind !== "ASK") throw new Error(`expected ASK, got ${state.kind}`);
  return state.facts;
}

beforeEach(() => {
  vi.clearAllMocks();
  persistClubZone("America/Denver");
  mockIsQuotePricedBooking.mockResolvedValue(false);
});

describe("PREMISE: the container and the club disagree about today", () => {
  it("pins the environment to the removed code's own answer", () => {
    expect(APP_TIME_ZONE).toBe("Pacific/Auckland");
    expect(
      new Intl.DateTimeFormat("en-CA", { timeZone: "Pacific/Auckland" }).format(
        NOW,
      ),
    ).toBe("2026-07-01");
    expect(
      new Intl.DateTimeFormat("en-CA", { timeZone: "America/Denver" }).format(
        NOW,
      ),
    ).toBe("2026-06-30");
  });
});

describe("the age shown to a delegate (#3123, #3082)", () => {
  it("is 17 for a club still on 30 June, the day before the birthday", async () => {
    // The reference date is the CLUB's, and the date of birth is decoded rather
    // than projected. Before the migration both operands went through
    // `APP_TIME_ZONE`: the reference day read 1 July (the container's) and the
    // stored birthday would have read a day early on any club west of UTC.
    const facts = await askState(utcMidnight("2026-08-01"));
    expect(facts.guest.ageYears).toBe(17);
  });

  it("becomes 18 the moment the CLUB's own birthday arrives", async () => {
    persistClubZone("Pacific/Kiritimati"); // UTC+14 — already 1 July
    const facts = await askState(utcMidnight("2026-08-01"));
    expect(facts.guest.ageYears).toBe(18);
  });

  it("MOVES with the persisted zone — kills a hard-coded club zone", async () => {
    persistClubZone("Pacific/Pago_Pago"); // UTC-11 — still 30 June
    expect((await askState(utcMidnight("2026-08-01"))).guest.ageYears).toBe(17);
    persistClubZone("Pacific/Auckland"); // UTC+12 — 1 July
    expect((await askState(utcMidnight("2026-08-01"))).guest.ageYears).toBe(18);
  });
});

describe("the stay-started prediction on the same page", () => {
  it("does NOT warn when the stay begins on the club's tomorrow", async () => {
    // Club day 30 June, stay starts 1 July. Under the container's day (1 July)
    // the old code would have called the stay started and shown the delegate a
    // STAY_NOT_FUTURE refusal warning a whole day early.
    const facts = await askState(utcMidnight("2026-07-01"));
    expect(facts.refusalBlocker).toBeNull();
  });

  it("warns once the club's own day has reached the stay", async () => {
    const facts = await askState(utcMidnight("2026-06-30"));
    expect(facts.refusalBlocker).toBe("STAY_NOT_FUTURE");
  });

  it("is worked out from the SAME club day as the age above", async () => {
    // The page's own promise, and the reason one zone read serves both. On
    // Kiritimati the club is on 1 July: the member is 18 AND the 1 July stay
    // has started. Two answers, one day.
    persistClubZone("Pacific/Kiritimati");
    const facts = await askState(utcMidnight("2026-07-01"));
    expect(facts.guest.ageYears).toBe(18);
    expect(facts.refusalBlocker).toBe("STAY_NOT_FUTURE");
  });
});

describe("the zone comes from the persisted row", () => {
  it("reads ClubTimeSettings rather than the environment", async () => {
    await askState(utcMidnight("2026-08-01"));
    expect(mockClubTimeSettingsFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "default" },
        select: expect.objectContaining({ timeZone: true }),
      }),
    );
  });
});
