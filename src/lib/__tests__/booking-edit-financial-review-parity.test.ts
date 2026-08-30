import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";

const h = vi.hoisted(() => ({
  checkCapacityForGuestRanges: vi.fn(),
  checkCapacityForPartnerSharedAdmission: vi.fn(),
}));

vi.mock("@/lib/capacity", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/capacity")>();
  return {
    ...actual,
    checkCapacityForGuestRanges: h.checkCapacityForGuestRanges,
    checkCapacityForPartnerSharedAdmission:
      h.checkCapacityForPartnerSharedAdmission,
  };
});
vi.mock("@/lib/membership-type-policy", () => ({
  assertMembershipTypeBookingAllowed: vi.fn().mockResolvedValue(undefined),
  resolveGuestRateMembershipTypes: vi
    .fn()
    .mockImplementation((_tx: unknown, { guests }: { guests: unknown[] }) =>
      Promise.resolve(guests),
    ),
  MembershipTypeBookingPolicyError: class extends Error {},
  priceBookingGuestsWithMembershipTypePolicy: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import {
  buildInProgressGuestRangePlan,
  type BuildInProgressGuestRangePlanInput,
} from "@/lib/booking-edit-guest-ranges";
import { calculateModifiedPricing } from "@/lib/booking-modify-plan";
import { BookingEditFinancialReviewRequiredError } from "@/lib/booking-modify-validation";
import {
  parseEditFinancialReviewContext,
  type EditFinancialReviewContext,
} from "@/lib/edit-financial-review-context";
import type { SeasonRateData } from "@/lib/pricing";

/**
 * #3031 (epic #2797), acceptance criterion 4: THE PREVIEW AND THE SAVE CONSUME
 * ONE RESULT.
 *
 * The member reads a price from `POST /api/bookings/[id]/modify-quote` and then
 * saves through `PUT /api/bookings/[id]/modify`. Those are two code paths over
 * one edit, and the epic's whole point fails if they can disagree about whether
 * the edit is priceable at all: a preview that shows an amount for a booking the
 * save will refuse is exactly the "plausible number that was never sold" the
 * epic exists to stop, arriving one screen earlier.
 *
 * They agree structurally rather than by inspection. The quote route calls
 * `buildInProgressGuestRangePlan` directly; the apply path calls it through
 * `calculateModifiedPricing`. Both receive the SAME discriminated result, and
 * neither has a numeric field to read on the review branch. This suite drives
 * both over one booking and requires the occurrences to be identical, cause for
 * cause and night for night.
 *
 * It also checks the thing #3032 will depend on: that what the planner produces
 * really is writable as `ManualRefundTask.reviewContext`. The write site
 * validates through `parseEditFinancialReviewContext` before it inserts, so a
 * context that does not parse is a task that never gets raised — a silent loss
 * of the money question, which is worse than the estimate it replaced.
 */

const D = (value: string) => new Date(`${value}T00:00:00.000Z`);

const MEMBER_TYPE = "type-member";
const RATE = 5000;

const SEASONS: SeasonRateData[] = [
  {
    seasonId: "s1",
    startDate: D("2026-08-01"),
    endDate: D("2026-08-31"),
    rates: [
      {
        ageTier: "ADULT",
        membershipTypeId: MEMBER_TYPE,
        pricePerNightCents: RATE,
      },
    ],
  },
];

const HELD = ["2026-08-20", "2026-08-21", "2026-08-22"];

/** A club that has not switched the group discount on. */
const NO_DISCOUNT_TX = {
  groupDiscountSetting: { findUnique: async () => null },
} as never;

function guest(nights: Array<{ stayDate: Date; priceCents?: number }>) {
  return {
    id: "g1",
    firstName: "Alice",
    lastName: "Member",
    ageTier: "ADULT" as const,
    isMember: true,
    memberId: "m1",
    rateMembershipTypeId: MEMBER_TYPE,
    rateSource: "OWN_TYPE" as const,
    stayStart: D(HELD[0]),
    stayEnd: D("2026-08-23"),
    nights,
    priceCents: HELD.length * RATE,
  };
}

/** The booking as the QUOTE route hands it to the planner. */
function planInput(
  nights: Array<{ stayDate: Date; priceCents?: number }>,
): BuildInProgressGuestRangePlanInput {
  const guests = [guest(nights)];
  const totalPriceCents = guests.reduce((sum, g) => sum + g.priceCents, 0);
  return {
    booking: {
      id: "bk-parity",
      checkIn: D(HELD[0]),
      checkOut: D("2026-08-23"),
      totalPriceCents,
      discountCents: 0,
      promoAdjustmentCents: 0,
      finalPriceCents: totalPriceCents,
      guests,
    },
    editableFrom: D("2026-08-21"),
    newCheckOut: D("2026-08-25"),
    seasons: SEASONS,
  };
}

/** The same edit as the APPLY path hands it to `calculateModifiedPricing`. */
function pricingArgs(nights: Array<{ stayDate: Date; priceCents?: number }>) {
  const input = planInput(nights);
  return {
    booking: {
      ...input.booking,
      memberId: "m1",
      lodgeId: "lodge-1",
    } as never,
    bookingId: "bk-parity",
    isInProgressEdit: true,
    editableFrom: input.editableFrom,
    newCheckIn: input.booking.checkIn,
    newCheckOut: input.newCheckOut,
    normalizedAddGuests: undefined,
    removeGuestIds: undefined,
    guestsForPricing: [
      {
        bookingGuestId: "g1",
        ageTier: "ADULT" as const,
        isMember: true,
        memberId: "m1",
        stayStart: input.booking.checkIn,
        stayEnd: input.newCheckOut,
      },
    ],
    skipBookingLifecycleRules: false,
    seasonRateData: SEASONS as never,
    partnerSharedGuests: [],
  };
}

const PRICED_NIGHTS = HELD.map((night) => ({
  stayDate: D(night),
  priceCents: RATE,
}));
/** The same stay with no per-night record of what it cost. */
const UNPRICED_NIGHTS = HELD.map((night) => ({ stayDate: D(night) }));

describe("#3031 quote and apply consume one discriminated result", () => {
  it("both price the same exact booking, and agree on the amount", async () => {
    h.checkCapacityForGuestRanges.mockResolvedValue({
      available: true,
      minAvailable: 5,
      nightDetails: [],
    });

    const quote = buildInProgressGuestRangePlan(planInput(PRICED_NIGHTS));
    const apply = await calculateModifiedPricing(
      NO_DISCOUNT_TX,
      pricingArgs(PRICED_NIGHTS),
    );

    expect(quote.kind).toBe("priced");
    expect(apply.kind).toBe("priced");
    if (quote.kind !== "priced" || apply.kind !== "priced") return;

    // Two nights bought by the extension, at the current rate; the three held
    // nights keep the price on their rows and cancel across the difference.
    expect(quote.plan.priceDiffCents).toBe(2 * RATE);
    expect(apply.newTotalPriceCents).toBe(quote.plan.newTotalPriceCents);
    expect(apply.inProgressPlan?.priceDiffCents).toBe(
      quote.plan.priceDiffCents,
    );
    expect(apply.priceBreakdown.guests[0].perNightCents).toEqual(
      quote.plan.proposedExistingGuests[0].perNightCents,
    );
  });

  it("both refuse the same unpriceable booking, with identical occurrences", async () => {
    h.checkCapacityForGuestRanges.mockResolvedValue({
      available: true,
      minAvailable: 5,
      nightDetails: [],
    });

    const quote = buildInProgressGuestRangePlan(planInput(UNPRICED_NIGHTS));
    const apply = await calculateModifiedPricing(
      NO_DISCOUNT_TX,
      pricingArgs(UNPRICED_NIGHTS),
    );

    expect(quote.kind).toBe("financial_review_required");
    expect(apply.kind).toBe("financial_review_required");
    if (
      quote.kind !== "financial_review_required" ||
      apply.kind !== "financial_review_required"
    ) {
      return;
    }

    // Not "both refused" — the same refusal, in full. The occurrence is what
    // #3030 hashes into a task identity, so a preview and a save that produced
    // different material would raise two tasks for one edit.
    expect(apply.occurrences).toEqual(quote.occurrences);
    expect(quote.occurrences).toEqual([
      {
        bookingId: "bk-parity",
        bookingGuestId: "g1",
        cause: "NO_STORED_NIGHT_PRICES",
        // The edit gives back nothing (the check-out only moves out), so the
        // identity is the two nights it ADDS.
        surrenderedNightDates: [],
        addedNightDates: ["2026-08-23", "2026-08-24"],
        storedEvidence: {
          guestTotalCents: 3 * RATE,
          nightPrices: HELD.map((date) => ({ date, priceCents: null })),
        },
      },
    ]);

    // And neither branch carries an amount at all. `?? 0` has nothing to bite
    // on, which is what makes the magic zero unrepresentable rather than
    // forbidden (epic #2797).
    expect(Object.keys(apply)).toEqual(["kind", "occurrences"]);
    expect(Object.keys(quote)).toEqual(["kind", "occurrences"]);
  });

  it("produces an occurrence #3030 can actually store as review evidence", () => {
    // The write site validates through this schema before inserting, and logs
    // loudly rather than storing an unreadable blob - so a context that does not
    // parse is a money question that silently never reaches an admin.
    const result = buildInProgressGuestRangePlan(planInput(UNPRICED_NIGHTS));
    expect(result.kind).toBe("financial_review_required");
    if (result.kind !== "financial_review_required") return;

    const context: EditFinancialReviewContext = {
      version: 1,
      occurrence: result.occurrences[0],
      // #3032's D-3032-1 anchor: the ORIGINAL edit's BookingModification row, so
      // a confirmed amount settles against the same record the edit already used
      // for its credit and Stripe idempotency keys. Required, not defaulted -
      // #3031 wrote this fixture before the field existed, and the merge is what
      // surfaced it. It is deliberately NOT on the occurrence itself, so it
      // cannot re-identify a replay.
      bookingModificationId: "bm1",
      guestMemberId: "m1",
      bookingCheckIn: "2026-08-20" as EditFinancialReviewContext["bookingCheckIn"],
      bookingCheckOut:
        "2026-08-23" as EditFinancialReviewContext["bookingCheckOut"],
    };

    expect(parseEditFinancialReviewContext(context)).toEqual(context);
  });

  it("carries the occurrences on the refusal both routes raise", () => {
    // The seam #3032 re-routes. Today the edit is refused; there the stay change
    // commits and one OPEN task is raised from exactly these occurrences, so the
    // error has to carry them rather than only a sentence.
    const result = buildInProgressGuestRangePlan(planInput(UNPRICED_NIGHTS));
    if (result.kind !== "financial_review_required") throw new Error("priced");

    const refusal = new BookingEditFinancialReviewRequiredError(
      result.occurrences,
    );

    expect(refusal.occurrences).toEqual(result.occurrences);
    expect(refusal.status).toBe(409);
    expect(refusal.code).toBe("FINANCIAL_REVIEW_REQUIRED");
    // Member-facing wording, bound by the epic: no estimate, no `$0`, no
    // "corrupt"/"invalid data" terminology, and nothing that reads as the
    // member's fault - the stored history is the club's record, not theirs.
    expect(refusal.message).toMatch(/nothing has been changed yet/i);
    expect(refusal.message).not.toMatch(/\$|corrupt|invalid|error|your data/i);
  });
});

describe("#3032 every door that can raise the fence surfaces its code", () => {
  /**
   * The pending-review fence (`assertNoPendingEditFinancialReview`) refuses a
   * second money-affecting edit with a 409 and a machine code. Three routes can
   * raise it — the preview, the save, and the guest removal — and a member can
   * meet the SAME refusal through any of them.
   *
   * WHY THIS IS A SOURCE SCAN. The property is an ORDERING one:
   * `EditFinancialReviewPendingError` extends `ApiError`, so a handler's generic
   * `ApiError` branch will happily catch it and answer with the right status,
   * the right sentence, and NO `code`. Nothing fails, nothing logs, and the panel
   * that would have offered "the club is pricing your last change" shows a bare
   * error instead. That is precisely the shape a behavioural test on the happy
   * path cannot see, and it was live on two of these three routes until #3032
   * removed the branch that had been sitting above the generic one for a
   * different error.
   *
   * The DELETE route additionally has a real behavioural proof in
   * `guest-removal-minors-alert-route.test.ts`; this is the census that stops the
   * other two drifting away from it.
   */
  const DOORS = [
    "src/app/api/bookings/[id]/modify-quote/route.ts",
    "src/app/api/bookings/[id]/modify/route.ts",
    "src/app/api/bookings/[id]/guests/[guestId]/route.ts",
  ];

  it.each(DOORS)("%s answers with the code, above the generic branch", (door) => {
    const source = fs.readFileSync(path.resolve(process.cwd(), door), "utf8");

    // The code itself, not merely the error class: a branch that caught the
    // error and answered without `code` would satisfy an `instanceof` check.
    const code = source.search(
      /EDIT_FINANCIAL_REVIEW_PENDING_CODE|"EDIT_FINANCIAL_REVIEW_PENDING"|err\.code/,
    );
    expect(code, `${door} must surface the fence's machine code`).toBeGreaterThan(-1);

    const pendingBranch = source.search(
      /instanceof EditFinancialReviewPendingError|EDIT_FINANCIAL_REVIEW_PENDING_CODE/,
    );
    const genericBranch = source.search(/err instanceof ApiError/);
    expect(pendingBranch, `${door} must handle the fence explicitly`).toBeGreaterThan(-1);
    if (genericBranch > -1) {
      expect(
        pendingBranch,
        `${door}: the fence branch must precede the generic ApiError branch, ` +
          "which would otherwise swallow it and drop the code",
      ).toBeLessThan(genericBranch);
    }
  });
});

describe("#3031 no magic zero reaches a night row", () => {
  /**
   * `syncGuestNights` used to write `bg?.perNightCents[k] ?? 0`.
   *
   * That write BECOMES the booking's sold-price history, so the default was a
   * real financial number - zero - put on a real night, which the next edit
   * would read back as evidence that the member paid nothing for it. Epic #2797
   * prohibits exactly that, and a per-night vector shorter than the night list
   * is a wiring defect in whoever built the breakdown rather than a night that
   * happens to be free.
   *
   * The state is unreachable through the planner, which is the point: the guard
   * exists so that a FUTURE breakdown builder fails loudly instead of quietly
   * zeroing a night. So it is driven here by handing `applyGuestChanges` the
   * malformed breakdown directly.
   */
  function writeDouble() {
    const created: unknown[] = [];
    return {
      created,
      tx: {
        bookingGuestNight: {
          deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
          createMany: vi.fn(async (args: { data: unknown }) => {
            created.push(args.data);
            return { count: 1 };
          }),
        },
        bookingGuest: { update: vi.fn().mockResolvedValue(undefined) },
      } as never,
    };
  }

  const PLAN_ENTRY = {
    guest: { id: "g1", memberId: "m1" },
    stayStart: D(HELD[0]),
    stayEnd: D("2026-08-23"),
    nights: HELD.map((night) => D(night)),
    perNightCents: [RATE, RATE, RATE],
    futureNights: [],
    priceCents: 3 * RATE,
    oldFuturePriceCents: 0,
    newFuturePriceCents: 0,
    futureDeltaCents: 0,
    removedFromFuture: false,
    futureStart: D(HELD[0]),
  };

  it("refuses to write a night the breakdown did not price", async () => {
    const { applyGuestChanges } = await import("@/lib/booking-modify-plan");
    const { tx, created } = writeDouble();

    await expect(
      applyGuestChanges(tx, {
        bookingId: "bk-parity",
        newCheckIn: D(HELD[0]),
        newCheckOut: D("2026-08-23"),
        removedGuests: [],
        remainingGuests: [],
        proposedRemainingGuests: [],
        normalizedAddGuests: undefined,
        priceBreakdown: {
          totalPriceCents: 3 * RATE,
          guests: [
            {
              priceCents: 3 * RATE,
              // One amount short of the three nights below.
              perNightCents: [RATE, RATE],
              nightDates: HELD.map((night) => D(night)),
            },
          ],
        },
        inProgressPlan: {
          proposedExistingGuests: [PLAN_ENTRY],
          proposedAddedGuests: [],
        } as never,
      }),
    ).rejects.toThrow(/No priced amount for the night of/);

    // And nothing was written: the refusal comes before the row insert, so a
    // partially-zeroed night set cannot survive the failure.
    expect(created).toEqual([]);
  });

  it("writes the priced amounts when the breakdown is complete", async () => {
    // The control, so the case above cannot pass on a function that always
    // throws.
    const { applyGuestChanges } = await import("@/lib/booking-modify-plan");
    const { tx, created } = writeDouble();

    await applyGuestChanges(tx, {
      bookingId: "bk-parity",
      newCheckIn: D(HELD[0]),
      newCheckOut: D("2026-08-23"),
      removedGuests: [],
      remainingGuests: [],
      proposedRemainingGuests: [],
      normalizedAddGuests: undefined,
      priceBreakdown: {
        totalPriceCents: 3 * RATE,
        guests: [
          {
            priceCents: 3 * RATE,
            perNightCents: [RATE, RATE, RATE],
            nightDates: HELD.map((night) => D(night)),
          },
        ],
      },
      inProgressPlan: {
        proposedExistingGuests: [PLAN_ENTRY],
        proposedAddedGuests: [],
      } as never,
    });

    expect(created).toEqual([
      HELD.map((night) => ({
        bookingGuestId: "g1",
        stayDate: D(night),
        priceCents: RATE,
      })),
    ]);
  });
});
