/**
 * #3167 (epic #2797): the create-path writers refuse a missing price instead of
 * writing a zero.
 *
 * Epic #2797's rule is that zero is a real financial number, never an honest
 * representation of "not yet known", and #3031 made stored night prices
 * load-bearing — an edit reads them back as sold-price evidence. THREE writers
 * on the create and add paths still carried a `?? 0`, and this change removes
 * all three. Two further writers had no `?? 0` but read the priced vector by
 * bare index, and were routed through the same helpers at the same time, so
 * `required-price-cents.ts` now has FIVE call sites.
 *
 * This file covers the shared helpers themselves, the booking-create writer,
 * and the shared approval guest writer. The other three live with their own
 * harnesses: the add-guest route in `partial-stay-edit-pricing.test.ts` (real
 * pricing engine, real route), the booking-request capacity hold in
 * `booking-request-quotes.test.ts`, and the waitlist offer reprice in
 * `waitlist.test.ts`.
 *
 * TWO WRITE POINTS ARE DELIBERATELY NOT COVERED, and the full reason is in
 * `required-price-cents.ts`'s header rather than repeated here: both
 * `booking-modify-plan.ts` and `booking-date-modification-service.ts` make a
 * THREE-way decision (#3170 — an explicit `null` means "not known") that a
 * two-way helper cannot express, and since #3166 both narrow the ONE definition
 * of it, `classifyNightPriceToWrite`. Neither is a copy of anything in this
 * file's subject, and neither is awaiting a conversion. A THIRD site was read by the #3167 census and left alone on
 * the merits: `booking-request-quotes.ts`'s `totalCents: split[guestIndex] ?? 0`,
 * which builds a quote option's `guestBreakdown` — quote JSON shown to the
 * requester, not a price column, and approval re-splits from the request's own
 * `priceCents` rather than reading it back. It is named because the same FILE
 * carries a guarded site, and silence would read as "the file was swept".
 *
 * EVERY refusal here is paired with a CONTROL — a complete breakdown that still
 * writes the correct amounts — because a guard with no control passes just as
 * happily against a function that always throws.
 */

import { describe, expect, it, vi } from "vitest";
import { AgeTier } from "@prisma/client";

// `booking-request-shared` reaches Prisma and two policy guards on the way past
// the price read. None of them is what this file is about, and the refusal under
// test fires BEFORE the first `await`, so they are stubbed exactly as
// `booking-request-guest-nights.test.ts` stubs them.
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/membership-type-policy", () => ({
  assertMembershipTypeBookingAllowed: vi.fn().mockResolvedValue(undefined),
  resolveGuestRateMembershipTypes: vi.fn(
    async (_tx: unknown, params: { guests: Array<Record<string, unknown>> }) =>
      params.guests.map((guest) => ({
        ...guest,
        rateMembershipTypeId: "type-nonmember",
      }))
  ),
}));
vi.mock("@/lib/booking-member-night-conflicts", () => ({
  assertNoBookingMemberNightConflicts: vi.fn().mockResolvedValue(undefined),
}));

import { buildGuestCreateData, type PricedGuest } from "@/lib/booking-create-guests";
import { buildApprovalGuestCreates } from "@/lib/booking-request-shared";
import { dateOnlyInstantOf, requireCalendarDate } from "@/lib/club-time";
import type { BookingGuestInput } from "@/lib/booking-create-types";
import {
  requiredGuestPriceCents,
  requiredNightPriceCents,
} from "@/lib/required-price-cents";
import { dateOnlyFromParts } from "@/lib/date-only";

const CHECK_IN = dateOnlyFromParts(2026, 7, 1);
const CHECK_OUT = dateOnlyFromParts(2026, 7, 4);
const NIGHTS = [
  dateOnlyFromParts(2026, 7, 1),
  dateOnlyFromParts(2026, 7, 2),
  dateOnlyFromParts(2026, 7, 3),
];

function guestInput(overrides: Partial<BookingGuestInput> = {}): BookingGuestInput {
  return {
    firstName: "Ada",
    lastName: "Lovelace",
    ageTier: AgeTier.ADULT,
    isMember: false,
    ...overrides,
  };
}

function pricedGuest(overrides: Partial<PricedGuest> = {}): PricedGuest {
  return {
    priceCents: 24_000,
    perNightCents: [8_000, 8_000, 8_000],
    nightDates: NIGHTS,
    ...overrides,
  };
}

describe("buildGuestCreateData refuses a short per-night vector (#3167)", () => {
  it("CONTROL: writes one night row per priced night at the engine's own amounts", () => {
    const data = buildGuestCreateData(
      [guestInput()],
      { guests: [pricedGuest()] },
      CHECK_IN,
      CHECK_OUT
    );

    expect(data).toHaveLength(1);
    expect(data[0].priceCents).toBe(24_000);
    expect(data[0].nights.create).toHaveLength(3);
    expect(data[0].nights.create.map((n) => n.priceCents)).toEqual([
      8_000, 8_000, 8_000,
    ]);
    expect(data[0].nights.create.map((n) => n.stayDate)).toEqual(NIGHTS);
  });

  it("CONTROL: a genuine free night is still written as a real zero", () => {
    // The point of the refusal is that a MISSING price is not a zero. A priced
    // zero is a legitimate amount and must survive untouched, or the guard has
    // simply moved the corruption.
    const data = buildGuestCreateData(
      [guestInput()],
      { guests: [pricedGuest({ perNightCents: [8_000, 0, 8_000], priceCents: 16_000 })] },
      CHECK_IN,
      CHECK_OUT
    );

    expect(data[0].nights.create.map((n) => n.priceCents)).toEqual([8_000, 0, 8_000]);
  });

  it("REFUSAL: throws rather than writing a zero when the vector is shorter than the nights", () => {
    expect(() =>
      buildGuestCreateData(
        [guestInput()],
        { guests: [pricedGuest({ perNightCents: [8_000, 8_000] })] },
        CHECK_IN,
        CHECK_OUT
      )
    ).toThrow(/No priced amount for the night of .* in the booking-create guest writer/);
  });

  it("REFUSAL: names the exact night that had no priced amount", () => {
    expect(() =>
      buildGuestCreateData(
        [guestInput()],
        { guests: [pricedGuest({ perNightCents: [8_000] })] },
        CHECK_IN,
        CHECK_OUT
      )
    ).toThrow(NIGHTS[1].toISOString());
  });

  it("REFUSAL: a guest with no priced nights writes nothing and refuses nothing", () => {
    // An empty night list is not a short vector — it is a guest the engine
    // priced over no nights at all — so the envelope falls back to the booking
    // range and no row is written. The guard must not fire here.
    const data = buildGuestCreateData(
      [guestInput()],
      { guests: [pricedGuest({ perNightCents: [], nightDates: [], priceCents: 0 })] },
      CHECK_IN,
      CHECK_OUT
    );

    expect(data[0].nights.create).toHaveLength(0);
    expect(data[0].stayStart).toEqual(CHECK_IN);
    expect(data[0].stayEnd).toEqual(CHECK_OUT);
  });
});

describe("requiredNightPriceCents (#3031, #3167)", () => {
  const stayDate = NIGHTS[0];

  it("CONTROL: returns the priced amount, including a genuine zero", () => {
    expect(requiredNightPriceCents([8_000, 0], 0, stayDate, "a writer")).toBe(8_000);
    expect(requiredNightPriceCents([8_000, 0], 1, stayDate, "a writer")).toBe(0);
  });

  it("REFUSAL: throws past the end of the vector, and names the writer", () => {
    expect(() => requiredNightPriceCents([8_000], 1, stayDate, "a writer")).toThrow(
      /No priced amount for the night of .* in a writer \(#3031\)/
    );
  });

  it("REFUSAL: throws when there is no vector at all", () => {
    expect(() => requiredNightPriceCents(undefined, 0, stayDate, "a writer")).toThrow(
      /No priced amount for the night of/
    );
  });
});

describe("requiredGuestPriceCents (#3167)", () => {
  it("CONTROL: returns the split amount, including a genuine zero", () => {
    expect(requiredGuestPriceCents([6_000, 0], 0, "a writer")).toBe(6_000);
    expect(requiredGuestPriceCents([6_000, 0], 1, "a writer")).toBe(0);
  });

  it("REFUSAL: throws past the end of the split, naming the guest position and the writer", () => {
    expect(() => requiredGuestPriceCents([6_000], 1, "a writer")).toThrow(
      "No priced amount for guest 2 in a writer (#3167)"
    );
  });

  it("REFUSAL: throws when there is no split at all", () => {
    expect(() => requiredGuestPriceCents(undefined, 0, "a writer")).toThrow(
      /No priced amount for guest 1/
    );
  });
});

/**
 * The shared approval guest writer (#3167).
 *
 * `buildApprovalGuestCreates` builds the guest rows for ALL THREE approval
 * pipelines — the public booking request, the school request and the member
 * whole-lodge request — so it is the RULE, and the capacity hold in
 * `booking-request-quotes.ts` guarded above is the one write point that
 * BYPASSES it. Guarding the exception while leaving the rule unguarded is
 * backwards, which is why this went in even though the #3167 census graded the
 * site a tautology on today's callers: every one of them either builds the
 * vector with `splitPriceAcrossGuests(total, guests.length)` or sits behind an
 * explicit `price.guests.length === guests.length` check.
 *
 * It carried no `?? 0` — it read `guestPriceCents[index]` bare — so before the
 * guard a short split reached Prisma as `undefined` and Prisma refused. That is
 * a real refusal, but it is the DATABASE saying "priceCents is required", three
 * layers from the caller that built the short vector, inside an approval
 * transaction already holding two advisory locks. The guard moves the answer to
 * the write, naming the writer and the guest position.
 */
describe("buildApprovalGuestCreates refuses a short per-guest split (#3167)", () => {
  // #3123 (`INV-LOCK-004`) — the club's day, resolved by the caller before it
  // opened the transaction, pinned to the frozen clock's club day.
  const CLUB_TODAY = dateOnlyInstantOf(requireCalendarDate("2026-07-01"));
  const APPROVAL_CHECK_IN = dateOnlyFromParts(2026, 8, 1);
  const APPROVAL_CHECK_OUT = dateOnlyFromParts(2026, 8, 3); // two nights

  const TWO_GUESTS = [
    { firstName: "Tara", lastName: "Tester", ageTier: AgeTier.ADULT },
    { firstName: "Sam", lastName: "Student", ageTier: AgeTier.CHILD },
  ];

  function approve(guestPriceCents: number[]) {
    return buildApprovalGuestCreates({} as never, {
      guests: TWO_GUESTS,
      linkedMembers: new Map<number, string>(),
      guestPriceCents,
      checkIn: APPROVAL_CHECK_IN,
      checkOut: APPROVAL_CHECK_OUT,
      adminMemberId: "admin-1",
      heldBookingId: null,
      today: CLUB_TODAY,
    });
  }

  it("CONTROL: a complete split still writes each guest's own amount", async () => {
    const guestCreates = await approve([10_001, 9_000]);

    expect(guestCreates.map((guest) => guest.priceCents)).toEqual([10_001, 9_000]);
    // The amounts survive into the night rows too, so this cannot pass against a
    // builder that has quietly stopped writing money at all.
    expect(guestCreates.map((guest) => guest.nights.map((n) => n.priceCents))).toEqual([
      [5_001, 5_000],
      [4_500, 4_500],
    ]);
  });

  it("CONTROL: a genuinely free guest is written as a real zero", async () => {
    // The point of the refusal is that a MISSING amount is not a zero. A split
    // that really is zero — a comped place on an officer-priced request — must
    // survive untouched, or the guard has only moved the corruption.
    const guestCreates = await approve([19_001, 0]);

    expect(guestCreates.map((guest) => guest.priceCents)).toEqual([19_001, 0]);
  });

  it("REFUSAL: throws rather than handing Prisma an undefined price", async () => {
    await expect(approve([19_001])).rejects.toThrow(
      "No priced amount for guest 2 in the shared booking-request approval guest writer (#3167)"
    );
  });

  it("REFUSAL: refuses BEFORE the policy guards run, so nothing else is read under the lock", async () => {
    const { assertMembershipTypeBookingAllowed } = await import(
      "@/lib/membership-type-policy"
    );
    vi.mocked(assertMembershipTypeBookingAllowed).mockClear();

    await expect(approve([19_001])).rejects.toThrow(/No priced amount for guest 2/);

    // The ordering is a property worth pinning: this runs inside an approval
    // transaction that already holds the global and per-lodge locks, so the
    // cheapest possible failure is the one that happens before any further query.
    expect(assertMembershipTypeBookingAllowed).not.toHaveBeenCalled();
  });
});
