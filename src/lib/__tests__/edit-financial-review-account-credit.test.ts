import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #3791: what a review share on a booking with no captured payment gives back,
 * against the issue's worked example - a $200 booking paid entirely by account
 * credit and a $50 share - at a 100% tier and at 50% with a $20 fee, and what
 * sibling reviews of one booking give back between them.
 *
 * The give-back itself (`giveBackAppliedCredit`: rows, lock, Xero step) is
 * `member-credit.test.ts`'s; it is replaced here by one that asks the writer's
 * real `giveBackCentsOf` and gives that back. The cancellation's tier is the
 * real `calculateAppliedCreditRestore`; only the policy READ is stubbed.
 */

const h = vi.hoisted(() => ({
  applied: { cents: 0, mirrorCents: 0 },
  createBookingModificationCredit: vi.fn(),
  giveBackAppliedCredit: vi.fn(),
  loadCancellationPolicy: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/member-credit", () => ({
  createBookingModificationCredit: (...a: unknown[]) => h.createBookingModificationCredit(...a),
  giveBackAppliedCredit: (...a: unknown[]) => h.giveBackAppliedCredit(...a),
  // #3835: the applied rows the captured netting reads.
  deriveBookingAppliedCreditCents: async () => h.applied.cents,
}));
vi.mock("@/lib/cancellation", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/cancellation")),
  loadCancellationPolicy: (...a: unknown[]) => h.loadCancellationPolicy(...a),
}));
vi.mock("@/lib/payment-reconciliation", () => ({
  ManualBookingPaymentError: class ManualBookingPaymentError extends Error {
    constructor(message: string, readonly status = 400) {
      super(message);
    }
  },
}));

import { calculateAppliedCreditRestore } from "@/lib/cancellation";
import { requireClubTimeZone } from "@/lib/club-time";
import {
  creditSliceOfReviewShare,
  giveBackCancelledShareCredit,
  reviewInvoiceReductionCents,
  reviewShareGiveBackDescription,
  writeEditReviewAccountCredit,
} from "@/lib/edit-financial-review-account-credit";
import { REVIEW_CANCELLATION_RESTORE_UNREPRODUCIBLE_MESSAGE } from "@/lib/edit-financial-review-refund-refusals";
import {
  RESTORED_CREDIT_PREFIX,
  cancellationCreditRestoreWhere,
  isCancellationCreditRestoreRow,
} from "@/lib/member-credit-booking-rows";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";

const CHECK_IN = new Date("2026-08-01T00:00:00.000Z");
const RESTORED_AT = new Date("2026-07-01T00:00:00.000Z");
const TIERS = [
  { tier: "100%", rule: { daysBeforeStay: 0, refundPercentage: 100, fixedFeeCents: 0 }, totalBackCents: 20_000 },
  { tier: "50% with a $20 fee", rule: { daysBeforeStay: 0, refundPercentage: 50, fixedFeeCents: 2_000 }, totalBackCents: 10_500 },
];

/** What the booking's rows say, as the writer's reads see them. */
const rows = {
  /** The CANCELLED event's frozen ledger figure, or null for none. */
  frozenAppliedCents: null as number | null,
  /** #3809: the capped base the cancellation tiered, or null where it froze none. */
  frozenBaseCents: null as number | null,
  /** The applied net as the restore row was written. */
  appliedAsRestoredCents: null as number | null,
  /** Review give-backs on the booking. */
  reviewGiveBacksCents: 0,
  /** Shares other reviews settled since the restore. */
  earlierSharesCents: 0,
  priceRebaseRows: [] as Array<{ newData: unknown }>,
  /** The `MemberCredit` rows the restore query is asked over. */
  credits: [] as CreditRow[],
  /** Other completed reviews, where a case lists them. */
  siblings: null as Array<{ id: string; amountCents: number; completedAt: Date }> | null,
};

type CreditRow = {
  type: string;
  amountCents: number;
  description: string | null;
  sourceBookingId: string | null;
  restoredFromBookingId: string | null;
  createdAt: Date;
};

/**
 * The Prisma semantics the restore query uses - `OR`, equality and
 * `startsWith` (SQL: a NULL description matches no `startsWith`) - so the
 * where-fragment itself is exercised, not a stand-in for it.
 */
function matchesWhere(row: CreditRow, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, condition]) => {
    if (key === "OR") return (condition as Array<Record<string, unknown>>).some((branch) => matchesWhere(row, branch));
    const value = row[key as keyof CreditRow];
    if (condition !== null && typeof condition === "object" && "startsWith" in condition) {
      return typeof value === "string" && value.startsWith((condition as { startsWith: string }).startsWith);
    }
    return value === condition;
  });
}

const store = {
  booking: { findUniqueOrThrow: vi.fn() },
  memberCredit: {
    findMany: vi.fn(async ({ where, take }: { where: Record<string, unknown>; take?: number }) =>
      rows.credits
        .filter((row) => matchesWhere(row, where))
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
        .slice(0, take)
        .map(({ amountCents, createdAt }) => ({ amountCents, createdAt })),
    ),
    aggregate: vi.fn(async ({ where }: { where: { sourceBookingId?: string } }) => ({
      _sum: {
        amountCents: where.sourceBookingId
          ? rows.reviewGiveBacksCents
          : rows.appliedAsRestoredCents === null
            ? null
            : -rows.appliedAsRestoredCents,
      },
    })),
  },
  bookingEvent: {
    findFirst: vi.fn(async () =>
      rows.frozenAppliedCents === null
        ? null
        : {
            snapshot: {
              ledger: {
                appliedCreditCents: rows.frozenAppliedCents,
                ...(rows.frozenBaseCents === null ? {} : { appliedCreditBaseCents: rows.frozenBaseCents }),
              },
            },
          },
    ),
  },
  manualRefundTask: {
    // Settled shares: the fixed figure, or - where a case lists its siblings - those the query's where admits.
    aggregate: vi.fn(async ({ where }: { where: { id?: { notIn?: string[] }; completedAt?: { gte: Date } } }) => ({
      _sum: {
        amountCents: rows.siblings === null
          ? rows.earlierSharesCents
          : rows.siblings
              .filter((task) => !(where.id?.notIn ?? []).includes(task.id))
              .filter((task) => !where.completedAt || task.completedAt >= where.completedAt.gte)
              .reduce((sum, task) => sum + task.amountCents, 0),
      },
    })),
    // #3835: the captured route's siblings - none here.
    findMany: vi.fn(async () => []),
  },
  // #3809's marker (`bookingReducedThroughCreditGiveBack`): none unless a case says.
  bookingModification: { findMany: vi.fn(async () => rows.priceRebaseRows), findFirst: vi.fn(async () => null) },
  payment: { update: vi.fn() },
};

function bookingIs(status: string, finalPriceCents = 20_000) {
  store.booking.findUniqueOrThrow.mockResolvedValue({ status, finalPriceCents, checkIn: CHECK_IN, lodgeId: "lodge-1" });
}

/**
 * The cancellation's restore row, as `restoreCreditFromBooking` left it: since
 * 8 Jul 2026 (#1636) with the `restoredFromBookingId` marker, before then
 * (`marked: false`) with only its type and description.
 */
function restored(amountCents: number | null, { marked = true, bookingId = "booking-1" } = {}) {
  if (amountCents === null) return;
  rows.credits.push({
    type: "CANCELLATION_REFUND",
    amountCents,
    description: `${RESTORED_CREDIT_PREFIX} ${bookingId.slice(0, 8)}`,
    sourceBookingId: bookingId,
    restoredFromBookingId: marked ? bookingId : null,
    createdAt: RESTORED_AT,
  });
}

/** The cancel path's own restore, on whatever is applied when it runs (31 days out). */
const cancelRestore = (appliedCents: number, rule: (typeof TIERS)[number]["rule"]) =>
  calculateAppliedCreditRestore(appliedCents, 0, 31, [rule]).creditRestoredCents;

type Rebase = { previousFinalPriceCents: number; newFinalPriceCents: number } | null;
const write = (shareCents = 5_000, rebase: Rebase = null, allocateAgainstPaymentId: string | null = null) =>
  writeEditReviewAccountCredit({
    route: { kind: "account-credit", bookingModificationId: "mod-1", allocateAgainstPaymentId },
    taskId: "task-2",
    memberId: "member-1",
    bookingId: "booking-1",
    amountCents: shareCents,
    rebase: rebase as never,
    clubZone: requireClubTimeZone("Pacific/Auckland"),
    format: CLUB_FORMAT_TEST,
    store: store as never,
  });

beforeEach(() => {
  vi.clearAllMocks();
  h.applied.cents = 20_000;
  h.applied.mirrorCents = 20_000;
  Object.assign(rows, {
    frozenAppliedCents: null,
    frozenBaseCents: null,
    appliedAsRestoredCents: null,
    reviewGiveBacksCents: 0,
    earlierSharesCents: 0,
    priceRebaseRows: [],
    credits: [],
    siblings: null,
  });
  h.giveBackAppliedCredit.mockImplementation(
    async ({ giveBackCentsOf }: { giveBackCentsOf: (applied: number, payment: unknown) => Promise<number> }) => {
      const payment = { id: "payment-1", creditAppliedCents: h.applied.mirrorCents };
      const givenBackCents = Math.min(h.applied.cents, await giveBackCentsOf(h.applied.cents, payment));
      return { appliedCreditCents: h.applied.cents, givenBackCents, payment };
    },
  );
  bookingIs("PAID");
  restored(null);
});

describe("the worked example: the share comes back first, then the booking is cancelled", () => {
  it.each(TIERS)("MUTATION: at $tier the member gets the share once ($totalBackCents cents in all)", async ({ rule, totalBackCents }) => {
    const outcome = await write();

    expect(outcome).toEqual({ givenBackCents: 5_000, mintedCents: 0, cancelled: false, invoiceReductionCents: 5_000, agreedGiveBackCents: 5_000 });
    // The mirror the cancellation tiers comes down by the share.
    expect(store.payment.update).toHaveBeenCalledWith({ where: { id: "payment-1" }, data: { creditAppliedCents: 15_000 } });
    expect(h.createBookingModificationCredit).not.toHaveBeenCalled();
    // The row a later review finds this give-back by.
    expect(h.giveBackAppliedCredit).toHaveBeenCalledWith(
      expect.objectContaining({ description: reviewShareGiveBackDescription("booking-1"), sourceBookingId: "booking-1" }),
      store,
    );
    // The cancellation then tiers the $150 still applied, not the $200.
    expect(outcome.givenBackCents + cancelRestore(15_000, rule)).toBe(totalBackCents);
  });
});

describe("owner decision 2: the booking was cancelled before the review completed", () => {
  it.each(TIERS)("MUTATION: at $tier the share is netted against the restore, so the member again gets $totalBackCents cents in all", async ({ rule, totalBackCents }) => {
    bookingIs("CANCELLED");
    rows.frozenAppliedCents = 20_000;
    h.loadCancellationPolicy.mockResolvedValue([rule]);
    const restoredCents = cancelRestore(20_000, rule);
    restored(restoredCents);

    const outcome = await write();

    // $0 at 100%, $25 at 50% with a $20 fee - the issue's figures.
    expect(outcome).toEqual({ givenBackCents: totalBackCents - restoredCents, mintedCents: 0, cancelled: true, invoiceReductionCents: 0, agreedGiveBackCents: null });
    expect(h.createBookingModificationCredit).not.toHaveBeenCalled();
  });

  it("MUTATION: two sibling reviews of one cancelled booking net CUMULATIVELY against the FROZEN figure: $10 each, $100 in all", async () => {
    // $200 credit-only, cancelled at 50% less $20 ($80 restored), two $20 shares.
    const rule = TIERS[1]!.rule;
    bookingIs("CANCELLED");
    rows.frozenAppliedCents = 20_000;
    h.loadCancellationPolicy.mockResolvedValue([rule]);
    restored(8_000);

    const first = await write(2_000);
    expect(first.givenBackCents).toBe(1_000);

    // The second sees the first: its share, its give-back, and an applied
    // figure (and mirror) it lowered - which must not be re-tiered.
    rows.earlierSharesCents = 2_000;
    h.applied.cents = 19_000;
    h.applied.mirrorCents = 19_000;
    const second = await write(2_000);

    expect(second).toEqual({ givenBackCents: 1_000, mintedCents: 0, cancelled: true, invoiceReductionCents: 0, agreedGiveBackCents: null });
    expect(8_000 + first.givenBackCents + second.givenBackCents).toBe(10_000);
  });

  it("MUTATION: #3835 - siblings count as since the cancel by the ids it froze, not by the clock: one before, one after", async () => {
    // $200 credit-only; a $20 review gave $20 back BEFORE the cancel at 50% less $20
    // ($180 tiered, $70 restored); another $20 review gave $10 back after it.
    bookingIs("CANCELLED");
    h.loadCancellationPolicy.mockResolvedValue([TIERS[1]!.rule]);
    restored(7_000);
    h.applied.cents = 17_000;
    h.applied.mirrorCents = 17_000;
    store.bookingEvent.findFirst.mockResolvedValueOnce({
      snapshot: { ledger: { appliedCreditCents: 18_000 }, completedReviewTaskIds: ["task-before"] },
    } as never);
    // The frozen clock stamps both siblings with the restore's own instant.
    rows.siblings = [
      { id: "task-before", amountCents: 2_000, completedAt: RESTORED_AT },
      { id: "task-1", amountCents: 2_000, completedAt: RESTORED_AT },
    ];

    // $40 since the cancel + 50% of the $140 left less $20 - $70 restored - $10 given back.
    expect((await write(2_000)).givenBackCents).toBe(1_000);
  });

  it("MUTATION: without a CANCELLED snapshot, the frozen figure is the applied net as the restore was written", async () => {
    bookingIs("CANCELLED");
    rows.appliedAsRestoredCents = 20_000;
    h.loadCancellationPolicy.mockResolvedValue([TIERS[1]!.rule]);
    restored(8_000);

    expect((await write()).givenBackCents).toBe(2_500);
  });

  it("MUTATION: #3809 - $200 applied, $150 tiered, $150 restored at 100%: a $50 share comes out of the untiered $50, as the share first would", async () => {
    bookingIs("CANCELLED");
    h.loadCancellationPolicy.mockResolvedValue([TIERS[0]!.rule]);
    restored(15_000);
    store.bookingEvent.findFirst.mockResolvedValueOnce({
      snapshot: { ledger: { appliedCreditCents: 20_000, appliedCreditBaseCents: 15_000 } },
    } as never);

    // Share first: $50 back, then the cancel tiers min($150, cap $150) - $200 in all.
    expect((await write()).givenBackCents).toBe(5_000);
  });

  it("MUTATION: #3809 - and at 50% the base the cancel tiered is untouched by a share the untiered $50 covers", async () => {
    bookingIs("CANCELLED");
    h.loadCancellationPolicy.mockResolvedValue([{ daysBeforeStay: 0, refundPercentage: 50, fixedFeeCents: 0 }]);
    restored(7_500);
    store.bookingEvent.findFirst.mockResolvedValueOnce({
      snapshot: { ledger: { appliedCreditCents: 20_000, appliedCreditBaseCents: 15_000 } },
    } as never);

    // $50 from the untiered credit + 50% of the same $150 base - $75 restored.
    expect((await write()).givenBackCents).toBe(5_000);
  });

  it("MUTATION: refuses, with nothing written, when no frozen figure can be derived", async () => {
    bookingIs("CANCELLED");
    restored(8_000);

    await expect(write()).rejects.toMatchObject({ message: REVIEW_CANCELLATION_RESTORE_UNREPRODUCIBLE_MESSAGE, status: 409 });
    expect(store.payment.update).not.toHaveBeenCalled();
  });

  it("MUTATION: a restore in full (an unpaid cancel returns everything) already returned the share, with no tier to consult", async () => {
    bookingIs("CANCELLED");
    rows.frozenAppliedCents = 20_000;
    restored(20_000);

    expect(await write()).toEqual({ givenBackCents: 0, mintedCents: 0, cancelled: true, invoiceReductionCents: 0, agreedGiveBackCents: null });
    expect(h.loadCancellationPolicy).not.toHaveBeenCalled();
  });

  it("MUTATION: a cancellation that restored nothing leaves the whole credit slice owed", async () => {
    bookingIs("CANCELLED");
    restored(null);

    expect(await write()).toEqual({ givenBackCents: 5_000, mintedCents: 0, cancelled: true, invoiceReductionCents: 0, agreedGiveBackCents: null });
    expect(h.loadCancellationPolicy).not.toHaveBeenCalled();
  });

  it("MUTATION (#3809): re-runs the tier on the cap the cancellation froze - $195 applied above a $150 price, $55 restored - instead of refusing", async () => {
    // A $50 reduction at 50% less $20 gave $5 back; the cancel at the same tier
    // tiered the $150 the booking was worth (INV-PAY-115), not the $195 applied.
    bookingIs("CANCELLED", 15_000);
    rows.frozenAppliedCents = 19_500;
    rows.frozenBaseCents = 15_000;
    h.applied.cents = 19_500;
    h.applied.mirrorCents = 19_500;
    h.loadCancellationPolicy.mockResolvedValue([TIERS[1]!.rule]);
    restored(5_500);

    // Had the $50 come back first: $50 + tier($145) = $50 + $52.50; the
    // member holds $55, so $47.50 is still owed.
    expect((await write()).givenBackCents).toBe(4_750);
  });

  it("MUTATION: refuses, with nothing written, when the policy in force no longer reproduces the restore", async () => {
    bookingIs("CANCELLED");
    rows.frozenAppliedCents = 20_000;
    // Restored at 50% less $20, but the policy now says 75%.
    restored(8_000);
    h.loadCancellationPolicy.mockResolvedValue([{ daysBeforeStay: 0, refundPercentage: 75, fixedFeeCents: 0 }]);

    await expect(write()).rejects.toMatchObject({ message: REVIEW_CANCELLATION_RESTORE_UNREPRODUCIBLE_MESSAGE, status: 409 });
    expect(store.payment.update).not.toHaveBeenCalled();
    expect(h.createBookingModificationCredit).not.toHaveBeenCalled();
  });
});

describe("a restore written before the marker existed (8 Jul 2026, #1636) is still a restore", () => {
  it("MUTATION: an unmarked restore is netted exactly as a marked one, so the slice is not handed back a second time", async () => {
    const rule = TIERS[1]!.rule;
    bookingIs("CANCELLED");
    rows.frozenAppliedCents = 20_000;
    h.loadCancellationPolicy.mockResolvedValue([rule]);
    restored(cancelRestore(20_000, rule), { marked: false });

    // $25, as the marked case at this tier - not the whole $50 slice on top of
    // the $80 the cancellation already restored.
    expect((await write()).givenBackCents).toBe(TIERS[1]!.totalBackCents - cancelRestore(20_000, rule));
  });

  it("MUTATION: two restore rows (a double restore before the unique marker) refuse, with nothing written", async () => {
    bookingIs("CANCELLED");
    rows.frozenAppliedCents = 20_000;
    h.loadCancellationPolicy.mockResolvedValue([TIERS[1]!.rule]);
    restored(8_000, { marked: false });
    restored(8_000, { marked: false });

    await expect(write()).rejects.toMatchObject({ message: REVIEW_CANCELLATION_RESTORE_UNREPRODUCIBLE_MESSAGE, status: 409 });
    expect(store.payment.update).not.toHaveBeenCalled();
  });

  it("MUTATION: another booking's restore, and this booking's other cancellation credit, are not this restore", async () => {
    bookingIs("CANCELLED");
    restored(8_000, { marked: false, bookingId: "booking-2" });
    rows.credits.push({
      type: "CANCELLATION_REFUND",
      amountCents: 3_000,
      description: "Cancellation credit for booking booking-1",
      sourceBookingId: "booking-1",
      restoredFromBookingId: null,
      createdAt: RESTORED_AT,
    });

    // Nothing restored: the whole slice is owed, with no tier consulted.
    expect((await write()).givenBackCents).toBe(5_000);
    expect(h.loadCancellationPolicy).not.toHaveBeenCalled();
  });

  it("the query and the one test agree, row for row", () => {
    const candidates: CreditRow[] = [
      { type: "CANCELLATION_REFUND", amountCents: 1, description: `${RESTORED_CREDIT_PREFIX} booking-`, sourceBookingId: "booking-1", restoredFromBookingId: "booking-1", createdAt: RESTORED_AT },
      { type: "CANCELLATION_REFUND", amountCents: 1, description: `${RESTORED_CREDIT_PREFIX} booking-`, sourceBookingId: "booking-1", restoredFromBookingId: null, createdAt: RESTORED_AT },
      { type: "CANCELLATION_REFUND", amountCents: 1, description: "Cancellation credit", sourceBookingId: "booking-1", restoredFromBookingId: null, createdAt: RESTORED_AT },
      { type: "CANCELLATION_REFUND", amountCents: 1, description: null, sourceBookingId: "booking-1", restoredFromBookingId: null, createdAt: RESTORED_AT },
      { type: "BOOKING_MODIFICATION_REFUND", amountCents: 1, description: `${RESTORED_CREDIT_PREFIX} booking-`, sourceBookingId: "booking-1", restoredFromBookingId: null, createdAt: RESTORED_AT },
    ];
    for (const row of candidates) {
      expect(matchesWhere(row, cancellationCreditRestoreWhere("booking-1"))).toBe(isCancellationCreditRestoreRow(row));
    }
  });
});

describe("what of the share is applied credit coming back", () => {
  it("MUTATION: never more than is applied; the rest is minted, as before", async () => {
    h.applied.cents = 3_000;
    h.applied.mirrorCents = 3_000;
    bookingIs("PAID", 3_000);

    expect(await write()).toEqual({ givenBackCents: 3_000, mintedCents: 2_000, cancelled: false, invoiceReductionCents: 3_000, agreedGiveBackCents: 3_000 });
    expect(h.createBookingModificationCredit).toHaveBeenCalledWith("member-1", 2_000, "booking-1", "mod-1", undefined, store, undefined);
  });

  it("MUTATION: the slice is held to the headroom only where there is one", () => {
    expect(creditSliceOfReviewShare({ shareCents: 5_000, appliedCreditCents: 5_000, repricedAwayHeadroomCents: 2_000 })).toBe(2_000);
    expect(creditSliceOfReviewShare({ shareCents: 5_000, appliedCreditCents: 5_000, repricedAwayHeadroomCents: -1_000 })).toBe(0);
    expect(creditSliceOfReviewShare({ shareCents: 5_000, appliedCreditCents: 20_000, repricedAwayHeadroomCents: null })).toBe(5_000);
  });

  it("MUTATION: on an unpaid booking, reads the limit from the closure's own re-price", async () => {
    h.applied.cents = 5_000;
    h.applied.mirrorCents = 5_000;

    expect(await write(5_000, { previousFinalPriceCents: 20_000, newFinalPriceCents: 17_000 })).toMatchObject({
      givenBackCents: 3_000,
      mintedCents: 2_000,
      cancelled: false,
    });
  });

  it("MUTATION: on a covered booking the give-back beyond the re-price is an agreed reduction; on an unpaid one there is none", async () => {
    expect((await write(5_000, { previousFinalPriceCents: 20_000, newFinalPriceCents: 18_000 })).agreedGiveBackCents).toBe(3_000);
    h.applied.cents = 5_000;
    h.applied.mirrorCents = 5_000;
    expect((await write(5_000, { previousFinalPriceCents: 20_000, newFinalPriceCents: 17_000 })).agreedGiveBackCents).toBeNull();
  });

  it("MUTATION: #3955 round 4 - an unpaid booking's invoice reduction counts the fee its payment records", async () => {
    // $100 re-priced to $80, $98 applied, a $5 fee: $10 back (the share), a $17 note.
    store.booking.findUniqueOrThrow.mockResolvedValue({
      status: "PAYMENT_PENDING",
      finalPriceCents: 8_000,
      checkIn: CHECK_IN,
      lodgeId: "lodge-1",
      payment: { changeFeeCents: 500 },
    });
    h.applied.cents = 9_800;
    h.applied.mirrorCents = 9_800;
    const outcome = await write(1_000, { previousFinalPriceCents: 10_000, newFinalPriceCents: 8_000 });
    expect(outcome).toMatchObject({ givenBackCents: 1_000, invoiceReductionCents: 1_700 });
    expect(store.booking.findUniqueOrThrow).toHaveBeenCalledWith(
      expect.objectContaining({ select: expect.objectContaining({ payment: { select: { changeFeeCents: true } } }) }),
    );
  });

  it("MUTATION: #3955 round 5 - credit that covers the price but not the recorded fee leaves the booking unpaid: nothing given back, the debt stays $50", async () => {
    // $300 price, a $50 fee on its payment, $300 applied, a $100 share, no
    // re-price. Against the bare price it read as covered: $100 given back and
    // the member owing $150 where Xero says $50.
    store.booking.findUniqueOrThrow.mockResolvedValue({
      status: "PAYMENT_PENDING",
      finalPriceCents: 30_000,
      checkIn: CHECK_IN,
      lodgeId: "lodge-1",
      payment: { changeFeeCents: 5_000 },
    });
    h.applied.cents = 30_000;
    h.applied.mirrorCents = 30_000;

    expect(await write(10_000, null)).toEqual({
      givenBackCents: 0,
      mintedCents: 10_000,
      cancelled: false,
      invoiceReductionCents: 0,
      agreedGiveBackCents: null,
    });
    expect(store.payment.update).not.toHaveBeenCalled();
    expect(h.createBookingModificationCredit).toHaveBeenCalledWith("member-1", 10_000, "booking-1", "mod-1", undefined, store, undefined);
  });

  it("MUTATION: a fully credit-paid booking is not held to the re-price", async () => {
    expect((await write(5_000, null)).givenBackCents).toBe(5_000);
    expect(store.bookingModification.findMany).not.toHaveBeenCalled();
  });

  it("MUTATION: the unpaid limit runs ACROSS THE BOOKING: a sibling review gives back what the first review's re-price left", async () => {
    // $200, $100 applied, one edit's two $30 shares, one $60 drop. The first
    // review re-priced and gave back $30; this one re-prices nothing.
    bookingIs("PAYMENT_PENDING", 14_000);
    h.applied.cents = 7_000;
    h.applied.mirrorCents = 7_000;
    rows.priceRebaseRows = [
      { newData: { financialReviewTaskId: "task-1", rebasedPriceMovementCents: -6_000 } },
      // Not a review's re-price: does not count.
      { newData: { rebasedPriceMovementCents: -9_000 } },
    ];
    rows.reviewGiveBacksCents = 3_000;

    // A $50 share here: $30 of headroom is left, so $30 back and $20 minted.
    expect(await write(5_000, null)).toMatchObject({ givenBackCents: 3_000, mintedCents: 2_000, cancelled: false });
  });

  it("MUTATION: #3835 - with a captured payment on a cancelled booking, mints only what the cancellation's refund left owed", async () => {
    // $200 by card, cancelled at 50% less $20: $80 refunded, so $25 of a $50 share.
    bookingIs("CANCELLED");
    h.loadCancellationPolicy.mockResolvedValue([TIERS[1]!.rule]);
    store.bookingEvent.findFirst.mockResolvedValueOnce({
      occurredAt: RESTORED_AT,
      snapshot: { refundMethod: "card", paidAmountCents: 20_000, settledAmountCents: 8_000, changeFeeCents: 0, ledger: { appliedCreditCents: 0, creditRestoredCents: 0 } },
    } as never);

    expect(await write(5_000, null, "payment-9")).toEqual({ givenBackCents: 0, mintedCents: 2_500, cancelled: false, invoiceReductionCents: null, agreedGiveBackCents: null });
    expect(h.createBookingModificationCredit).toHaveBeenCalledWith("member-1", 2_500, "booking-1", "mod-1", undefined, store, "payment-9");
  });

  it("MUTATION: #3835 - the applied-credit part of what is still owed is given back, never minted against the capture", async () => {
    // $50 card + $150 credit, cancelled at 50% (no fee): $25 refunded, $75 restored; a $100 share.
    bookingIs("CANCELLED");
    h.applied.cents = 15_000;
    h.applied.mirrorCents = 15_000;
    h.loadCancellationPolicy.mockResolvedValue([{ daysBeforeStay: 0, refundPercentage: 50, fixedFeeCents: 0 }]);
    store.bookingEvent.findFirst.mockResolvedValueOnce({
      occurredAt: RESTORED_AT,
      snapshot: {
        refundMethod: "card", paidAmountCents: 5_000, settledAmountCents: 2_500, changeFeeCents: 0,
        ledger: { appliedCreditCents: 15_000, creditRestoredCents: 7_500 },
        tierRefundMethod: "card", refundableBaseCents: 5_000, completedReviewTaskIds: [],
      },
    } as never);

    expect(await write(10_000, null, "payment-9")).toEqual({ givenBackCents: 2_500, mintedCents: 2_500, cancelled: false, invoiceReductionCents: null, agreedGiveBackCents: null });
    expect(h.createBookingModificationCredit).toHaveBeenCalledWith("member-1", 2_500, "booking-1", "mod-1", undefined, store, "payment-9");
    expect(h.giveBackAppliedCredit).toHaveBeenCalledWith(expect.objectContaining({ bookingId: "booking-1", sourceBookingId: "booking-1" }), store);
    // The member's credit-ledger lock (inside the give-back) before the mint's Payment row lock.
    expect(h.giveBackAppliedCredit.mock.invocationCallOrder[0]).toBeLessThan(h.createBookingModificationCredit.mock.invocationCallOrder[0]!);
  });

  it("MUTATION: #3835 - a credit part the applied rows cannot cover is refused, task OPEN, rather than half given back", async () => {
    h.applied.cents = 1_000;
    h.applied.mirrorCents = 1_000;

    await expect(giveBackCancelledShareCredit({ memberId: "member-1", bookingId: "booking-1", cents: 2_500, format: CLUB_FORMAT_TEST, store: store as never }))
      .rejects.toMatchObject({ status: 409 });
    expect(store.payment.update).not.toHaveBeenCalled();
  });

  it("MUTATION: #3835 - and mints nothing where the cancellation already refunded it all", async () => {
    bookingIs("CANCELLED");
    store.bookingEvent.findFirst.mockResolvedValueOnce({
      occurredAt: RESTORED_AT,
      snapshot: { refundMethod: "card", paidAmountCents: 20_000, settledAmountCents: 20_000, changeFeeCents: 0, ledger: { appliedCreditCents: 0, creditRestoredCents: 0 } },
    } as never);

    expect((await write(5_000, null, "payment-9")).mintedCents).toBe(0);
    expect(h.createBookingModificationCredit).not.toHaveBeenCalled();
  });

  it("with a captured payment, mints the whole share against it and gives nothing back", async () => {
    const outcome = await write(5_000, null, "payment-9");

    // No reduction figure: the invoice is judged by the document rule (F1).
    expect(outcome).toEqual({ givenBackCents: 0, mintedCents: 5_000, cancelled: false, invoiceReductionCents: null, agreedGiveBackCents: null });
    expect(h.giveBackAppliedCredit).not.toHaveBeenCalled();
    expect(h.createBookingModificationCredit).toHaveBeenCalledWith("member-1", 5_000, "booking-1", "mod-1", undefined, store, "payment-9");
  });
});

describe("what the issued invoice must come down by, so Xero owes what the app does", () => {
  /** Xero's due and the app's, once the give-back's deallocation and the note have landed. */
  /** `earlierGiveBacksCents`: an earlier review's agreed share, whose note the invoice already carries. */
  /** `feeCents`: a change fee recorded on the payment, which the invoice bills (`INV-PAY-119`). */
  const dues = (shape: { previousFinalPriceCents: number; finalPriceCents: number; appliedBeforeCents: number; givenBackCents: number; earlierGiveBacksCents?: number; feeCents?: number }) => {
    const feeCents = shape.feeCents ?? 0;
    const invoiceNetBeforeCents = shape.previousFinalPriceCents + feeCents - (shape.earlierGiveBacksCents ?? 0);
    const unpaid = shape.appliedBeforeCents + (shape.earlierGiveBacksCents ?? 0) < shape.previousFinalPriceCents;
    const note = reviewInvoiceReductionCents({ ...shape, recordedChangeFeeCents: feeCents, unpaid });
    const appliedAfter = shape.appliedBeforeCents - shape.givenBackCents;
    return {
      note,
      xeroDueCents: Math.max(0, invoiceNetBeforeCents - appliedAfter - note),
      appDueCents: unpaid ? Math.max(0, shape.finalPriceCents + feeCents - appliedAfter) : 0,
    };
  };

  it("MUTATION: the reviewer's unpaid example - $200, $80 applied, re-priced $50 down, $30 share: a $50 note, and both owe $100", () => {
    expect(dues({ previousFinalPriceCents: 20_000, finalPriceCents: 15_000, appliedBeforeCents: 8_000, givenBackCents: 3_000 })).toEqual({
      note: 5_000,
      xeroDueCents: 10_000,
      appDueCents: 10_000,
    });
  });

  it("MUTATION: #3955 round 4 - the recorded fee is in both owed figures, so a clamp at zero cannot drop it: a $17 note, and both owe nothing", () => {
    // Unpaid: $100 re-priced to $80, $98 applied, $10 given back, a $5 fee.
    // Without the fee the note is $12, and Xero would still say $5 is due.
    expect(
      dues({ previousFinalPriceCents: 10_000, finalPriceCents: 8_000, appliedBeforeCents: 9_800, givenBackCents: 1_000, feeCents: 500 }),
    ).toEqual({ note: 1_700, xeroDueCents: 0, appDueCents: 0 });
  });

  it.each([
    ["unpaid with a $5 fee, re-priced $50 down, $30 share", { previousFinalPriceCents: 20_000, finalPriceCents: 15_000, appliedBeforeCents: 8_000, givenBackCents: 3_000, feeCents: 500 }, 5_000],
    ["covered, no re-price, $50 given back", { previousFinalPriceCents: 20_000, finalPriceCents: 20_000, appliedBeforeCents: 20_000, givenBackCents: 5_000 }, 5_000],
    ["covered, a $20 re-price and a larger $50 agreed share", { previousFinalPriceCents: 20_000, finalPriceCents: 18_000, appliedBeforeCents: 20_000, givenBackCents: 5_000 }, 5_000],
    ["unpaid, a second review of the edit after the first re-priced", { previousFinalPriceCents: 14_000, finalPriceCents: 14_000, appliedBeforeCents: 7_000, givenBackCents: 3_000 }, 0],
    ["unpaid, re-priced $20, the share held to it", { previousFinalPriceCents: 20_000, finalPriceCents: 18_000, appliedBeforeCents: 8_000, givenBackCents: 2_000 }, 2_000],
    ["covered, a second review after the first gave $20 back with no re-price", { previousFinalPriceCents: 20_000, finalPriceCents: 20_000, appliedBeforeCents: 18_000, givenBackCents: 2_000, earlierGiveBacksCents: 2_000 }, 2_000],
  ])("MUTATION: %s", (_shape, shape, note) => {
    const result = dues(shape);
    expect(result.note).toBe(note);
    expect(result.xeroDueCents).toBe(result.appDueCents);
  });
});
