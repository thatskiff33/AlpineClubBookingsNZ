import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #3791: what a review share on a booking with no captured payment gives back,
 * against the issue's worked example - a $200 booking paid entirely by account
 * credit and a $50 share - at a 100% tier and at 50% with a $20 fee.
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
  writeEditReviewAccountCredit,
} from "@/lib/edit-financial-review-account-credit";
import { REVIEW_CANCELLATION_RESTORE_UNREPRODUCIBLE_MESSAGE } from "@/lib/edit-financial-review-refund-refusals";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";

const CHECK_IN = new Date("2026-08-01T00:00:00.000Z");
const TIERS = [
  { tier: "100%", rule: { daysBeforeStay: 0, refundPercentage: 100, fixedFeeCents: 0 }, totalBackCents: 20_000 },
  { tier: "50% with a $20 fee", rule: { daysBeforeStay: 0, refundPercentage: 50, fixedFeeCents: 2_000 }, totalBackCents: 10_500 },
];

const store = {
  booking: { findUniqueOrThrow: vi.fn() },
  memberCredit: { findUnique: vi.fn() },
  payment: { update: vi.fn() },
};

function bookingIs(status: string, finalPriceCents = 20_000) {
  store.booking.findUniqueOrThrow.mockResolvedValue({ status, finalPriceCents, checkIn: CHECK_IN, lodgeId: "lodge-1" });
}

/** The cancellation's restore row, as `restoreCreditFromBooking` left it. */
function restored(amountCents: number | null) {
  store.memberCredit.findUnique.mockResolvedValue(
    amountCents === null ? null : { amountCents, createdAt: new Date("2026-07-01T00:00:00.000Z") },
  );
}

/** The cancel path's own restore, on whatever is applied when it runs (31 days out). */
const cancelRestore = (appliedCents: number, rule: (typeof TIERS)[number]["rule"]) =>
  calculateAppliedCreditRestore(appliedCents, 0, 31, [rule]).creditRestoredCents;

const write = (shareCents = 5_000, rebase: { previousFinalPriceCents: number; newFinalPriceCents: number } | null = null) =>
  writeEditReviewAccountCredit({
    route: { kind: "account-credit", bookingModificationId: "mod-1", allocateAgainstPaymentId: null },
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

    expect(outcome).toEqual({ givenBackCents: 5_000, mintedCents: 0 });
    // The mirror the cancellation tiers comes down by the share.
    expect(store.payment.update).toHaveBeenCalledWith({ where: { id: "payment-1" }, data: { creditAppliedCents: 15_000 } });
    expect(h.createBookingModificationCredit).not.toHaveBeenCalled();
    // The cancellation then tiers the $150 still applied, not the $200.
    expect(outcome.givenBackCents + cancelRestore(15_000, rule)).toBe(totalBackCents);
  });
});

describe("owner decision 2: the booking was cancelled before the review completed", () => {
  it.each(TIERS)("MUTATION: at $tier the share is netted against the restore, so the member again gets $totalBackCents cents in all", async ({ rule, totalBackCents }) => {
    bookingIs("CANCELLED");
    h.loadCancellationPolicy.mockResolvedValue([rule]);
    const restoredCents = cancelRestore(20_000, rule);
    restored(restoredCents);

    const outcome = await write();

    // $0 at 100%, $25 at 50% with a $20 fee - the issue's figures.
    expect(outcome.givenBackCents).toBe(totalBackCents - restoredCents);
    expect(outcome.mintedCents).toBe(0);
    expect(h.createBookingModificationCredit).not.toHaveBeenCalled();
  });

  it("MUTATION: a restore in full (an unpaid cancel returns everything) already returned the share, with no tier to consult", async () => {
    bookingIs("CANCELLED");
    restored(20_000);

    expect(await write()).toEqual({ givenBackCents: 0, mintedCents: 0 });
    expect(h.loadCancellationPolicy).not.toHaveBeenCalled();
  });

  it("MUTATION: a cancellation that restored nothing leaves the whole credit slice owed", async () => {
    bookingIs("CANCELLED");
    restored(null);

    expect(await write()).toEqual({ givenBackCents: 5_000, mintedCents: 0 });
    expect(h.loadCancellationPolicy).not.toHaveBeenCalled();
  });

  it("MUTATION: refuses, with nothing written, when the policy in force no longer reproduces the restore", async () => {
    bookingIs("CANCELLED");
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

    expect(await write()).toEqual({ givenBackCents: 3_000, mintedCents: 2_000 });
    expect(h.createBookingModificationCredit).toHaveBeenCalledWith("member-1", 2_000, "booking-1", "mod-1", undefined, store, undefined);
  });

  it("MUTATION: on an unpaid booking, never more than the re-price removed", () => {
    expect(creditSliceOfReviewShare({ shareCents: 5_000, appliedCreditCents: 5_000, previousFinalPriceCents: 20_000, repricedAwayCents: 2_000, cancelled: false })).toBe(2_000);
    expect(creditSliceOfReviewShare({ shareCents: 5_000, appliedCreditCents: 5_000, previousFinalPriceCents: 20_000, repricedAwayCents: 0, cancelled: false })).toBe(0);
    // A re-price that put the price UP removed nothing.
    expect(creditSliceOfReviewShare({ shareCents: 5_000, appliedCreditCents: 5_000, previousFinalPriceCents: 20_000, repricedAwayCents: -1_000, cancelled: false })).toBe(0);
  });

  it("MUTATION: a fully credit-paid booking, or a cancelled one, is not held to the re-price", () => {
    expect(creditSliceOfReviewShare({ shareCents: 5_000, appliedCreditCents: 20_000, previousFinalPriceCents: 20_000, repricedAwayCents: 0, cancelled: false })).toBe(5_000);
    expect(creditSliceOfReviewShare({ shareCents: 5_000, appliedCreditCents: 5_000, previousFinalPriceCents: 20_000, repricedAwayCents: 0, cancelled: true })).toBe(5_000);
  });

  it("reads the unpaid limit from the closure's own re-price", async () => {
    h.applied.cents = 5_000;
    h.applied.mirrorCents = 5_000;

    expect(await write(5_000, { previousFinalPriceCents: 20_000, newFinalPriceCents: 17_000 })).toEqual({ givenBackCents: 3_000, mintedCents: 2_000 });
  });

  it("with a captured payment, mints the whole share against it and gives nothing back", async () => {
    const outcome = await writeEditReviewAccountCredit({
      route: { kind: "account-credit", bookingModificationId: "mod-1", allocateAgainstPaymentId: "payment-9" },
      memberId: "member-1",
      bookingId: "booking-1",
      amountCents: 5_000,
      rebase: null,
      clubZone: requireClubTimeZone("Pacific/Auckland"),
      format: CLUB_FORMAT_TEST,
      store: store as never,
    });

    expect(outcome).toEqual({ givenBackCents: 0, mintedCents: 5_000 });
    expect(h.giveBackAppliedCredit).not.toHaveBeenCalled();
    expect(h.createBookingModificationCredit).toHaveBeenCalledWith("member-1", 5_000, "booking-1", "mod-1", undefined, store, "payment-9");
  });
});
