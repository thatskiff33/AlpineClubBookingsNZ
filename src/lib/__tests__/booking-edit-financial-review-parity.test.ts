import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { stripComments } from "@/lib/__tests__/support/strip-comments";

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
import { EDIT_FINANCIAL_REVIEW_QUOTE_NOTICE } from "@/lib/booking-modify-validation";
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

    // Not "both parked" — the same park, in full. The occurrence is what
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

    // AND NEITHER BRANCH CARRIES AN AMOUNT AT ALL. `?? 0` has nothing to bite
    // on, which is what makes the magic zero unrepresentable rather than
    // forbidden (epic #2797).
    //
    // #3170 added the STRUCTURAL half — which beds, on which nights — and the
    // property is unchanged, because beds are not money. The key lists are
    // pinned rather than spot-checked so a future field carrying a booking total
    // has to be argued for here, in front of this comment, instead of appearing.
    expect(Object.keys(quote).sort()).toEqual([
      "kind",
      "occurrences",
      "parkedPlan",
    ]);
    expect(Object.keys(apply).sort()).toEqual([
      // Whether an admin confirmed an overbooking to fit these beds. Not an
      // amount, and the parked plan goes through the same capacity check a
      // priced one does.
      "capacityOverridden",
      "kind",
      "occurrences",
      // #3166: the guest ROWS the writer is handed — one entry per strand,
      // carrying that strand's own STORED total and a per-night vector whose
      // unknown nights are null. It is the same content `parkedPlan` already
      // carried, hoisted so the pre-check-in park (which has no plan) and the
      // in-progress park hand the writer one shape. It carries NO booking-level
      // total, which is the property this block exists to defend, and the
      // assertion below is what holds that line rather than this comment.
      "parkedGuestRows",
      "parkedPlan",
    ]);
    expect(Object.keys(apply.parkedGuestRows).sort()).toEqual(["guests"]);
    expect(quote.parkedPlan).not.toBeNull();
    if (quote.parkedPlan === null) throw new Error("expected a parked plan");
    expect(Object.keys(quote.parkedPlan).sort()).toEqual([
      "capacityGuestRanges",
      "capacityRangeStart",
      "proposedAddedGuests",
      "proposedExistingGuests",
      "remainingGuests",
      "removedGuests",
    ]);

    // The strand's own stored total is carried back UNCHANGED, and every night
    // this edit cannot value is `null`. Neither is an adjustment: the first is
    // what the booking already says, and the second is the absence of a number.
    const strand = quote.parkedPlan.proposedExistingGuests[0];
    expect(strand.priceCents).toBe(3 * RATE);
    expect(strand.perNightCents.every((cents) => cents === null)).toBe(true);
    // The control, so the assertion above cannot pass on an empty list.
    expect(strand.perNightCents.length).toBeGreaterThan(0);
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

  it("tells the member the change will be saved, and says nothing about an amount", () => {
    // WHAT REPLACED THE REFUSAL'S WORDING CONTRACT (#3170). This used to assert
    // that the 409's sentence said "nothing has been changed yet". That sentence
    // is now false — the change IS saved — and the class carrying it is deleted,
    // so pinning it would pin behaviour that was deliberately removed.
    //
    // The contract itself survives intact and is asserted on the sentence that
    // took its place: the epic binds this wording, not the class it lived on.
    expect(EDIT_FINANCIAL_REVIEW_QUOTE_NOTICE).toMatch(
      /your change will be saved/i,
    );
    expect(EDIT_FINANCIAL_REVIEW_QUOTE_NOTICE).toMatch(
      /nothing will be charged or refunded/i,
    );
    // No estimate, no `$0`, no "corrupt"/"invalid data", and nothing that reads
    // as the member's fault — the stored history is the club's record, not
    // theirs.
    expect(EDIT_FINANCIAL_REVIEW_QUOTE_NOTICE).not.toMatch(
      /\$|corrupt|invalid|error|your data/i,
    );
    // And it must NOT carry the old promise forward, which is the one way this
    // sentence could be wrong rather than merely thin.
    expect(EDIT_FINANCIAL_REVIEW_QUOTE_NOTICE).not.toMatch(
      /nothing has been changed/i,
    );
  });
});

describe("#3032 every door that can raise the fence surfaces its code", () => {
  /**
   * The pending-review fence (`assertNoPendingEditFinancialReview`) refuses a
   * second money-affecting edit with a 409 and a machine code. FOUR doors can
   * raise it — the preview, the save, the guest removal and the guest ADD — and a
   * member can meet the SAME refusal through any of them.
   *
   * WHY THIS IS A SOURCE SCAN. The property is an ORDERING one:
   * `EditFinancialReviewPendingError` extends `ApiError`, so a handler's generic
   * `ApiError` branch will happily catch it and answer with the right status, the
   * right sentence, and NO `code`. Nothing fails, nothing logs, and the panel that
   * would have offered "the club is pricing your last change" shows a bare error
   * instead. That is precisely the shape a behavioural test on the happy path
   * cannot see.
   *
   * WHAT THIS CENSUS GOT WRONG, AND WHY IT IS WORTH SAYING. The first version
   * searched for the literal `err instanceof ApiError`. `modify-quote/route.ts`
   * writes `error instanceof ApiError`, so for that door the match was -1, the
   * ordering assertion sat behind `if (genericBranch > -1)` and never ran at all —
   * a census passing because it matched nothing, which is the false green this
   * repository keeps getting caught by. Two more holes went with it: the "does it
   * surface the code" half accepted a bare `err.code` anywhere in the file, which
   * any unrelated branch satisfies, and the "is the fence handled" half accepted
   * the IMPORT of `EDIT_FINANCIAL_REVIEW_PENDING_CODE` at the top of the file,
   * which is above everything by construction.
   *
   * So all three halves are now tied to what the code WRITES:
   *
   *  - both spellings of the receiver, and both the local and the aliased shared
   *    `ApiError`, and the generic branch is REQUIRED rather than optional — a
   *    door with none is a change somebody must come and look at;
   *  - the fence must be handled at a real handling site (an `instanceof` branch,
   *    or a response literal naming the code), never at an import; and
   *  - the `code` must appear IN that handling site rather than anywhere in the
   *    file.
   *
   * Comments are stripped first. This repository documents each defect at the
   * site where it removed it, so the strings a scanner greps for are densest in
   * exactly the files that no longer commit the defect — including this feature's
   * own docblocks, which discuss the generic `ApiError` branch at length.
   *
   * The DELETE and the ADD routes additionally have real behavioural proofs, in
   * `guest-removal-minors-alert-route.test.ts` and
   * `guests-add-notify-choice.test.ts`; this is the census that stops the other
   * two drifting away from them.
   */
  const DOORS = [
    "src/app/api/bookings/[id]/modify-quote/route.ts",
    "src/app/api/bookings/[id]/modify/route.ts",
    "src/app/api/bookings/[id]/guests/[guestId]/route.ts",
    "src/app/api/bookings/[id]/guests/route.ts",
  ];

  /** How far past the handling site the `code` it answers with may sit. */
  const HANDLER_WINDOW = 600;

  it.each(DOORS)("%s answers with the code, above the generic branch", (door) => {
    const source = stripComments(
      fs.readFileSync(path.resolve(process.cwd(), door), "utf8"),
    );

    // A HANDLING site, not an import: an `instanceof` branch on the error, or a
    // response literal naming the code. `import { EDIT_FINANCIAL_REVIEW_PENDING_CODE }`
    // matches neither.
    const pendingBranch = source.search(
      /instanceof EditFinancialReviewPendingError|code:\s*EDIT_FINANCIAL_REVIEW_PENDING_CODE/,
    );
    expect(
      pendingBranch,
      `${door} must handle the fence at a real handling site, not merely import its code`,
    ).toBeGreaterThan(-1);

    // The code itself, and IN the handling site: a branch that caught the error
    // and answered without `code` would satisfy an `instanceof` check on its own,
    // and an `err.code` in some unrelated branch elsewhere would satisfy a
    // whole-file search.
    const handler = source.slice(pendingBranch, pendingBranch + HANDLER_WINDOW);
    expect(
      handler,
      `${door} must surface the fence's machine code where it answers it`,
    ).toMatch(/code:/);

    // Both receiver spellings (`err` and `error`) and both the local and the
    // aliased shared class, because the doors differ on every one of those and
    // a spelling this missed is an assertion that silently does not run.
    const genericBranch = source.search(
      /(?:err|error)\s+instanceof\s+(?:Shared)?ApiError(?![A-Za-z0-9_])/,
    );
    expect(
      genericBranch,
      `${door} has no generic ApiError branch this census can order against - ` +
        "if that is deliberate, this census has to be told so explicitly",
    ).toBeGreaterThan(-1);
    expect(
      pendingBranch,
      `${door}: the fence branch must precede the generic ApiError branch, ` +
        "which would otherwise swallow it and drop the code",
    ).toBeLessThan(genericBranch);
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

  it("writes NULL where the breakdown SAYS the price is not known (#3170)", async () => {
    // THE OTHER HALF OF THE DISTINCTION the case above pins, and the two must be
    // read together: a vector that is SHORT is a wiring defect and throws, while
    // an explicit `null` is a composer's deliberate statement that the night's
    // price is not known and is stored as `NULL`.
    //
    // Collapsing them would be the defect in either direction. Treating a short
    // vector as "unknown" would turn every future wiring bug into a silently
    // unpriced night; treating an explicit null as a defect would make it
    // impossible to commit a parked edit at all, which is what #3170 exists to
    // allow.
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
        guests: [
          {
            priceCents: 3 * RATE,
            // Same LENGTH as the night list — nothing is missing. The middle
            // night's price is stated to be unknown.
            perNightCents: [RATE, null, RATE],
            nightDates: HELD.map((night) => D(night)),
          },
        ],
      },
      inProgressPlan: {
        proposedExistingGuests: [PLAN_ENTRY],
        proposedAddedGuests: [],
      } as never,
    });

    const rows = created[0] as Array<{ stayDate: Date; priceCents: number | null }>;
    expect(rows.map((row) => row.priceCents)).toEqual([RATE, null, RATE]);
    // Said separately, because `toEqual` would also pass on a 0 if someone
    // later relaxed the expectation: a stored 0 is a real sold price (a comped
    // night), so 0 can never stand in for "not known".
    expect(rows[1].priceCents).toBeNull();
    expect(rows[1].priceCents).not.toBe(0);
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
        priceSource: "SOLD",
      })),
    ]);
  });
});
