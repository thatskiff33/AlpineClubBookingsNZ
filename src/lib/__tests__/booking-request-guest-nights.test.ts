/**
 * #2739 — booking-request bookings and the canonical night set.
 *
 * `BookingGuestNight` is what the whole bed-allocation surface reads. A booking
 * created by approving a booking request used to get guests with none of those
 * rows, so its guests were invisible to it: not listed on the board, not placed
 * by the planner, not counted as awaiting a bed — while being real people on a
 * confirmed booking who turn up at the lodge (INV-CAP-032).
 *
 * The per-pipeline write points are pinned in each pipeline's own suite
 * (`booking-request.test.ts`, `school-booking-request.test.ts`,
 * `booking-request-quotes.test.ts`, `reassign-held-booking-guests.test.ts`).
 * This file pins the properties those tests cannot see between them: that the
 * rows carry the right DATES, that a guest priced by the ENGINE keeps the
 * engine's own per-night rates, and that a guest carrying an officer's flat
 * total is divided by exactly the rule Xero line building already synthesises,
 * so no money moves on that path.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgeTier } from "@prisma/client";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/membership-type-policy", () => ({
  assertMembershipTypeBookingAllowed: vi.fn().mockResolvedValue(undefined),
  // The real resolver stamps a rate-membership-type snapshot and returns the
  // guests otherwise untouched; nothing here turns on which type it picks.
  resolveGuestRateMembershipTypes: vi.fn(async (_tx: unknown, params: {
    guests: Array<Record<string, unknown>>;
  }) => params.guests.map((guest) => ({ ...guest, rateMembershipTypeId: "type-nonmember" }))),
}));
vi.mock("@/lib/booking-member-night-conflicts", () => ({
  assertNoBookingMemberNightConflicts: vi.fn().mockResolvedValue(undefined),
}));

import {
  buildApprovalGuestCreates,
  buildApprovalGuestNights,
  toPipelineGuestCreateData,
} from "@/lib/booking-request-shared";
import {
  countGuestsAwaitingBed,
} from "@/lib/bed-allocation-board";
import { parseDateOnly } from "@/lib/date-only";
import { buildInvoiceLineItems } from "@/lib/xero-booking-invoices";
import { dateOnlyInstantOf, requireCalendarDate } from "@/lib/club-time";

// #3123 (`INV-LOCK-004`) — the CLUB's day, resolved by the caller BEFORE it opens
// its transaction and threaded in. Pinned to the frozen clock's club day, so
// these fixtures answer exactly as they did while the guard read the club's zone
// for itself.
const FIXTURE_CLUB_TODAY = dateOnlyInstantOf(requireCalendarDate("2026-07-01"));

const CHECK_IN = parseDateOnly("2026-08-01");
const CHECK_OUT = parseDateOnly("2026-08-04"); // three nights

describe("buildApprovalGuestNights — the dates (#2739)", () => {
  it("expands the HALF-OPEN envelope, so the check-out morning is not a night", () => {
    const nights = buildApprovalGuestNights({
      checkIn: CHECK_IN,
      checkOut: CHECK_OUT,
      priceCents: 9000,
    });

    // INV-DATE-003: a stay is [checkIn, checkOut). Night N runs to midday NZ on
    // date N+1, so the day a guest checks out is not one of theirs. A fourth row
    // here would claim a bed on the 4th while its real occupant is still in it —
    // a double booking written by the creation path itself.
    expect(nights.map((night) => night.stayDate)).toEqual([
      parseDateOnly("2026-08-01"),
      parseDateOnly("2026-08-02"),
      parseDateOnly("2026-08-03"),
    ]);
  });

  it("produces no rows for a zero-night envelope rather than one phantom night", () => {
    expect(
      buildApprovalGuestNights({
        checkIn: CHECK_IN,
        checkOut: CHECK_IN,
        priceCents: 9000,
      }),
    ).toEqual([]);
  });

  it("stores NZ date-only values at the encoding every other night row uses", () => {
    // INV-DATE-013: a @db.Date column holds an NZ calendar date encoded at UTC
    // midnight. A local-midnight or raw `new Date()` value shifts the boundary by
    // a day for the first ~13h of each NZ day.
    for (const night of buildApprovalGuestNights({
      checkIn: CHECK_IN,
      checkOut: CHECK_OUT,
      priceCents: 9000,
    })) {
      expect(night.stayDate.toISOString()).toMatch(/T00:00:00\.000Z$/);
    }
  });
});

describe("buildApprovalGuestNights — the engine's own rates (#2739)", () => {
  it("stores the pricing engine's per-night vector verbatim when it is supplied", () => {
    // A season boundary or a per-night group discount makes the nights of one
    // stay genuinely different prices. The engine has already resolved them, and
    // the canonical direct-create writer stores exactly that vector, so
    // re-deriving a flat split here would write the right total against the
    // wrong nights — misattributing revenue across a period boundary in the
    // finance reconciliation, which sums night rows inside a DATE WINDOW.
    const nights = buildApprovalGuestNights({
      checkIn: CHECK_IN,
      checkOut: CHECK_OUT,
      priceCents: 18000,
      perNightCents: [5000, 5000, 8000],
    });

    expect(nights.map((night) => night.priceCents)).toEqual([5000, 5000, 8000]);
  });

  it.each([
    ["a vector of the wrong length", [5000, 13000]],
    ["a vector that does not sum to the guest's price", [5000, 5000, 5000]],
    ["a vector carrying a fractional cent", [5000, 5000, 8000.5]],
  ])("refuses %s and divides the stored price instead", (_label, perNightCents) => {
    // A night set that does not reconcile to the guest's stored price is worse
    // than a flat one: invoicing bills from these rows, so the invoice would
    // stop matching the booking.
    const nights = buildApprovalGuestNights({
      checkIn: CHECK_IN,
      checkOut: CHECK_OUT,
      priceCents: 18000,
      perNightCents,
    });

    expect(nights.map((night) => night.priceCents)).toEqual([6000, 6000, 6000]);
    expect(nights.reduce((sum, night) => sum + night.priceCents, 0)).toBe(18000);
  });
});

describe("buildApprovalGuestNights — the money (#2739)", () => {
  it("splits to the exact cent, with the extra cents on the EARLIEST nights", () => {
    const nights = buildApprovalGuestNights({
      checkIn: CHECK_IN,
      checkOut: CHECK_OUT,
      priceCents: 10001,
    });

    expect(nights.map((night) => night.priceCents)).toEqual([3334, 3334, 3333]);
    expect(nights.reduce((sum, night) => sum + night.priceCents, 0)).toBe(10001);
  });

  it.each([0, 1, 2, 9000, 10001, 33333, 100000])(
    "sums to the guest's stored price exactly for %i cents",
    (priceCents) => {
      const nights = buildApprovalGuestNights({
        checkIn: CHECK_IN,
        checkOut: CHECK_OUT,
        priceCents,
      });
      expect(nights.reduce((sum, night) => sum + night.priceCents, 0)).toBe(
        priceCents,
      );
    },
  );

  it("leaves the Xero invoice byte-identical to the one it raises with no rows at all", () => {
    // THE MONEY-SAFETY PROOF FOR THE FLAT-TOTAL PATH — the public approval, the
    // quote hold, and the backfill of every booking that already exists — and
    // the reason this split rule was chosen over the #1098 backfill's (whole
    // remainder on the first night). It is NOT claimed for a guest the engine
    // priced: those rows carry the engine's real rates, which is what a
    // directly-created booking's rows carry, and the resulting invoice bills the
    // same total in the runs the rates actually form.
    //
    // `buildInvoiceLineItems` ALREADY synthesises a per-night vector for a guest
    // carrying no night rows and bills from it. Writing real rows only changes
    // which branch runs — so if the two vectors agree, a converted booking's
    // invoice is unchanged on a fresh raise AND an invoice-update diff of a
    // backfilled booking finds nothing to push. A different split totals the same
    // and still emits different lines, which on an already-raised invoice reads
    // as a change to send to Xero.
    const guest = {
      firstName: "Tara",
      lastName: "Tester",
      ageTier: AgeTier.ADULT,
      isMember: false,
      rateMembershipTypeId: null,
      priceCents: 10001,
    };

    const withoutRows = buildInvoiceLineItems([guest], CHECK_IN, CHECK_OUT, 3);
    const withRows = buildInvoiceLineItems(
      [
        {
          ...guest,
          nights: buildApprovalGuestNights({
            checkIn: CHECK_IN,
            checkOut: CHECK_OUT,
            priceCents: guest.priceCents,
          }),
        },
      ],
      CHECK_IN,
      CHECK_OUT,
      3,
    );

    expect(withRows).toEqual(withoutRows);
    // And the lines still reconcile to the guest's price, in dollars.
    const total = withRows.reduce(
      (sum, line) => sum + (line.quantity ?? 0) * (line.unitAmount ?? 0),
      0,
    );
    expect(Math.round(total * 100)).toBe(10001);
  });
});

describe("buildApprovalGuestCreates gives every guest a night set (#2739)", () => {
  const tx = {} as never;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("attaches nights to every guest, matching each one's own price", async () => {
    const guestCreates = await buildApprovalGuestCreates(tx, {
      today: FIXTURE_CLUB_TODAY,
      guests: [
        { firstName: "Tara", lastName: "Tester", ageTier: AgeTier.ADULT },
        { firstName: "Sam", lastName: "Student", ageTier: AgeTier.CHILD },
      ],
      linkedMembers: new Map<number, string>(),
      guestPriceCents: [10001, 9000],
      checkIn: CHECK_IN,
      checkOut: CHECK_OUT,
      adminMemberId: "admin-1",
      heldBookingId: null,
    });

    expect(guestCreates.map((guest) => guest.nights.map((n) => n.priceCents))).toEqual([
      [3334, 3334, 3333],
      [3000, 3000, 3000],
    ]);
  });

  it("nests them the way Prisma wants at the shared write point", async () => {
    const [guestCreate] = await buildApprovalGuestCreates(tx, {
      today: FIXTURE_CLUB_TODAY,
      guests: [{ firstName: "Tara", lastName: "Tester", ageTier: AgeTier.ADULT }],
      linkedMembers: new Map<number, string>(),
      guestPriceCents: [9000],
      checkIn: CHECK_IN,
      checkOut: CHECK_OUT,
      adminMemberId: "admin-1",
      heldBookingId: null,
    });

    const prismaData = toPipelineGuestCreateData(guestCreate);
    expect(prismaData.nights).toEqual({
      create: [
        { stayDate: parseDateOnly("2026-08-01"), priceCents: 3000 },
        { stayDate: parseDateOnly("2026-08-02"), priceCents: 3000 },
        { stayDate: parseDateOnly("2026-08-03"), priceCents: 3000 },
      ],
    });
    // The planning-only fields never reach Prisma.
    expect(prismaData).not.toHaveProperty("memberGuestConsent");
    expect(prismaData).not.toHaveProperty("crossFamilyMemberGuest");
  });

  it("REFUSES TO COMPILE for a guest with no night set — the guardrail itself", () => {
    /*
      This is the assertion that makes INV-CAP-032's "a fifth pipeline cannot be
      added without answering the question" true rather than aspirational, and it
      is checked by `npm run typecheck`, not at runtime.

      `@ts-expect-error` fails the build when the line does NOT error. So if
      `nights` ever goes back to optional — or the `?? []` fallback comes back —
      this line stops erroring and typecheck goes red. Without it, a new pipeline
      that maps night-less guests through this shaper compiles clean and writes
      an empty create: zero night rows, which is precisely the defect #2739
      fixes, and invisible to every mock test because they assert the args that
      WERE passed.
    */
    expect(() =>
      // @ts-expect-error — a guest carrying no night set must never reach Prisma.
      toPipelineGuestCreateData({
        firstName: "Tara",
        lastName: "Tester",
        priceCents: 9000,
      }),
    ).toThrow();
  });
});

describe("the guests now reach the Bed Allocation officer card (#2739)", () => {
  /**
   * `countGuestsAwaitingBed` reads `BookingGuestNight` and nothing else since
   * #2628 — "a guest carrying no night rows has no placeable nights, so the board
   * never lists them and this card must not count them either". That is the
   * sentence that made this defect total: both the board and its counter went
   * blind at once. These two cases run the real counter over the rows the
   * pipeline now writes, and over the empty set it used to write.
   */
  async function countFor(nights: Array<{ stayDate: Date }>) {
    return countGuestsAwaitingBed({
      from: parseDateOnly("2026-08-01"),
      to: parseDateOnly("2026-08-08"),
      db: {
        booking: {
          findMany: vi.fn().mockResolvedValue([
            { guests: [{ id: "converted-guest", nights }] },
          ]),
        },
        bedAllocation: { findMany: vi.fn().mockResolvedValue([]) },
      } as never,
    });
  }

  /**
   * The night rows as the PIPELINE emits them — built through
   * `buildApprovalGuestCreates` and unwrapped from the `nights: { create: [...] }`
   * envelope `toPipelineGuestCreateData` hands Prisma. Feeding the counter a
   * hand-built array instead would pin a property of the counter (which this
   * branch does not touch) rather than the fact that a pipeline's output reaches
   * it, so a pipeline that stopped nesting nights would leave this suite green.
   */
  async function pipelineNights() {
    const [guestCreate] = await buildApprovalGuestCreates({} as never, {
      today: FIXTURE_CLUB_TODAY,
      guests: [{ firstName: "Tara", lastName: "Tester", ageTier: AgeTier.ADULT }],
      linkedMembers: new Map<number, string>(),
      guestPriceCents: [9000],
      checkIn: CHECK_IN,
      checkOut: CHECK_OUT,
      adminMemberId: "admin-1",
      heldBookingId: null,
    });
    return toPipelineGuestCreateData(guestCreate).nights.create;
  }

  it("counts a converted guest once the pipeline writes their nights", async () => {
    expect(await countFor(await pipelineNights())).toBe(1);
  });

  it("counted nobody while the pipeline wrote none — the defect, pinned", async () => {
    expect(await countFor([])).toBe(0);
  });
});
