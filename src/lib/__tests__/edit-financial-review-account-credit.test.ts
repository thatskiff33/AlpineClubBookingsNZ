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
  reviewInvoiceReductionCents,
  reviewShareGiveBackDescription,
  writeEditReviewAccountCredit,
} from "@/lib/edit-financial-review-account-credit";
import { REVIEW_CANCELLATION_RESTORE_UNREPRODUCIBLE_MESSAGE } from "@/lib/edit-financial-review-refund-refusals";
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
  /** The applied net as the restore row was written. */
  appliedAsRestoredCents: null as number | null,
  /** Review give-backs on the booking. */
  reviewGiveBacksCents: 0,
  /** Shares other reviews settled since the restore. */
  earlierSharesCents: 0,
  priceRebaseRows: [] as Array<{ newData: unknown }>,
};

const store = {
  booking: { findUniqueOrThrow: vi.fn() },
  memberCredit: {
    findUnique: vi.fn(),
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
      rows.frozenAppliedCents === null ? null : { snapshot: { ledger: { appliedCreditCents: rows.frozenAppliedCents } } },
    ),
  },
  manualRefundTask: { aggregate: vi.fn(async () => ({ _sum: { amountCents: rows.earlierSharesCents } })) },
  bookingModification: { findMany: vi.fn(async () => rows.priceRebaseRows) },
  payment: { update: vi.fn() },
};

function bookingIs(status: string, finalPriceCents = 20_000) {
  store.booking.findUniqueOrThrow.mockResolvedValue({ status, finalPriceCents, checkIn: CHECK_IN, lodgeId: "lodge-1" });
}

/** The cancellation's restore row, as `restoreCreditFromBooking` left it. */
function restored(amountCents: number | null) {
  store.memberCredit.findUnique.mockResolvedValue(amountCents === null ? null : { amountCents, createdAt: RESTORED_AT });
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
    appliedAsRestoredCents: null,
    reviewGiveBacksCents: 0,
    earlierSharesCents: 0,
    priceRebaseRows: [],
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

    expect(outcome).toEqual({ givenBackCents: 5_000, mintedCents: 0, cancelled: false, invoiceReductionCents: 5_000 });
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
    expect(outcome).toEqual({ givenBackCents: totalBackCents - restoredCents, mintedCents: 0, cancelled: true, invoiceReductionCents: 0 });
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

    expect(second).toEqual({ givenBackCents: 1_000, mintedCents: 0, cancelled: true, invoiceReductionCents: 0 });
    expect(8_000 + first.givenBackCents + second.givenBackCents).toBe(10_000);
  });

  it("MUTATION: without a CANCELLED snapshot, the frozen figure is the applied net as the restore was written", async () => {
    bookingIs("CANCELLED");
    rows.appliedAsRestoredCents = 20_000;
    h.loadCancellationPolicy.mockResolvedValue([TIERS[1]!.rule]);
    restored(8_000);

    expect((await write()).givenBackCents).toBe(2_500);
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

    expect(await write()).toEqual({ givenBackCents: 0, mintedCents: 0, cancelled: true, invoiceReductionCents: 0 });
    expect(h.loadCancellationPolicy).not.toHaveBeenCalled();
  });

  it("MUTATION: a cancellation that restored nothing leaves the whole credit slice owed", async () => {
    bookingIs("CANCELLED");
    restored(null);

    expect(await write()).toEqual({ givenBackCents: 5_000, mintedCents: 0, cancelled: true, invoiceReductionCents: 0 });
    expect(h.loadCancellationPolicy).not.toHaveBeenCalled();
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

describe("what of the share is applied credit coming back", () => {
  it("MUTATION: never more than is applied; the rest is minted, as before", async () => {
    h.applied.cents = 3_000;
    h.applied.mirrorCents = 3_000;
    bookingIs("PAID", 3_000);

    expect(await write()).toEqual({ givenBackCents: 3_000, mintedCents: 2_000, cancelled: false, invoiceReductionCents: 3_000 });
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

  it("with a captured payment, mints the whole share against it and gives nothing back", async () => {
    const outcome = await write(5_000, null, "payment-9");

    expect(outcome).toEqual({ givenBackCents: 0, mintedCents: 5_000, cancelled: false, invoiceReductionCents: 0 });
    expect(h.giveBackAppliedCredit).not.toHaveBeenCalled();
    expect(h.createBookingModificationCredit).toHaveBeenCalledWith("member-1", 5_000, "booking-1", "mod-1", undefined, store, "payment-9");
  });
});

describe("what the issued invoice must come down by, so Xero owes what the app does", () => {
  /** Xero's due and the app's, once the give-back's deallocation and the note have landed. */
  /** `earlierGiveBacksCents`: an earlier review's agreed share, whose note the invoice already carries. */
  const dues = (shape: { previousFinalPriceCents: number; finalPriceCents: number; appliedBeforeCents: number; givenBackCents: number; earlierGiveBacksCents?: number }) => {
    const invoiceNetBeforeCents = shape.previousFinalPriceCents - (shape.earlierGiveBacksCents ?? 0);
    const unpaid = shape.appliedBeforeCents + (shape.earlierGiveBacksCents ?? 0) < shape.previousFinalPriceCents;
    const note = reviewInvoiceReductionCents({ ...shape, unpaid });
    const appliedAfter = shape.appliedBeforeCents - shape.givenBackCents;
    return {
      note,
      xeroDueCents: Math.max(0, invoiceNetBeforeCents - appliedAfter - note),
      appDueCents: unpaid ? Math.max(0, shape.finalPriceCents - appliedAfter) : 0,
    };
  };

  it("MUTATION: the reviewer's unpaid example - $200, $80 applied, re-priced $50 down, $30 share: a $50 note, and both owe $100", () => {
    expect(dues({ previousFinalPriceCents: 20_000, finalPriceCents: 15_000, appliedBeforeCents: 8_000, givenBackCents: 3_000 })).toEqual({
      note: 5_000,
      xeroDueCents: 10_000,
      appDueCents: 10_000,
    });
  });

  it.each([
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
