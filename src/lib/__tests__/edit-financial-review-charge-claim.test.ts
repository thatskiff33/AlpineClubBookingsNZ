import { PaymentStatus } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";

/**
 * #3402 (`INV-PAY-112`): how `syncEditFinancialReviewChargeRequest` uses the
 * edit's raise claim. That the claim itself excludes a concurrent claimant is a
 * property of PostgreSQL, proved in `edit-financial-review-charge-raise-claim.realdb.test.ts`;
 * these cases pin the ORCHESTRATION around it - who may call Stripe, what a run
 * that may not does instead, and that the holder looks again after releasing.
 */

const mocks = vi.hoisted(() => ({
  claim: vi.fn(),
  recordIntent: vi.fn(),
  release: vi.fn(),
  sumShares: vi.fn(),
  findRequest: vi.fn(),
  recordUncollected: vi.fn(),
  updatePaymentIntentAmount: vi.fn(),
  reissue: vi.fn(),
  writeRaisedAmount: vi.fn(),
  enqueueRecovery: vi.fn(),
  logError: vi.fn(),
  mint: vi.fn(),
  paymentFindUnique: vi.fn(),
  recordCarried: vi.fn(),
  recoveryDead: vi.fn(),
  calls: [] as string[],
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/edit-financial-review-charge-raise-claim", () => ({
  claimEditReviewChargeRaise: (...a: unknown[]) => mocks.claim(...a),
  recordEditReviewChargeRaiseIntent: (...a: unknown[]) => mocks.recordIntent(...a),
  releaseEditReviewChargeRaise: (...a: unknown[]) => mocks.release(...a),
}));
vi.mock("@/lib/edit-financial-review-charge-request", () => ({
  findEditReviewChargeRequest: (...a: unknown[]) => mocks.findRequest(...a),
  hasIssuedSupplementaryInvoice: vi.fn(),
  recordUncollectedEditReviewChargeShare: (...a: unknown[]) => mocks.recordUncollected(...a),
  sumEditReviewChargeSharesCents: (...a: unknown[]) => mocks.sumShares(...a),
}));
vi.mock("@/lib/stripe", () => ({
  updatePaymentIntentAmount: (...a: unknown[]) => mocks.updatePaymentIntentAmount(...a),
}));
vi.mock("@/lib/additional-intent-currency", () => ({
  reissueRaisedAskIfCurrencyChanged: (...a: unknown[]) => mocks.reissue(...a),
}));
vi.mock("@/lib/payment-transactions", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/payment-transactions")),
  writeRaisedAdditionalRequestAmount: (...a: unknown[]) => mocks.writeRaisedAmount(...a),
}));
vi.mock("@/lib/payment-recovery", () => ({
  enqueueEditFinancialReviewChargeRecovery: (...a: unknown[]) => mocks.enqueueRecovery(...a),
  isEditFinancialReviewChargeRecoveryDead: (...a: unknown[]) => mocks.recoveryDead(...a),
}));
vi.mock("@/lib/booking-modification-settlement", () => ({
  createModificationAdditionalPaymentIntent: (...a: unknown[]) => mocks.mint(...a),
}));
vi.mock("@/lib/edit-financial-review-carried-balance", () => ({
  recordCarriedEditReviewChargeBalance: (...a: unknown[]) => mocks.recordCarried(...a),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: { payment: { findUnique: (...a: unknown[]) => mocks.paymentFindUnique(...a) } },
}));
vi.mock("@/lib/logger", () => ({
  default: { error: (...a: unknown[]) => mocks.logError(...a), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { syncEditFinancialReviewChargeRequest } from "@/lib/edit-financial-review-charge";

const CLAIM = { bookingModificationId: "mod-1", token: "token-1" };

const sync = () =>
  syncEditFinancialReviewChargeRequest({
    format: CLUB_FORMAT_TEST,
    bookingId: "booking-1",
    bookingModificationId: "mod-1",
    paymentId: "payment-1",
    member: { id: "member-1", email: "m@example.invalid", name: "M", stripeCustomerId: null },
    hasIssuedXeroInvoice: false,
  });

/** The edit's request, as the first share left it at $50. */
function requestAt(amountCents: number) {
  return {
    paymentTransactionId: "txn-1",
    stripePaymentIntentId: "pi_request",
    amountCents,
    carriedAskCents: 0,
    status: PaymentStatus.PENDING,
  };
}

/** The share total each successive read returns; the last value then repeats. */
function sharesRead(...totals: number[]) {
  let index = 0;
  mocks.sumShares.mockImplementation(async () => {
    const total = totals[Math.min(index, totals.length - 1)];
    index += 1;
    return total;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.calls.length = 0;
  mocks.claim.mockImplementation(async () => {
    mocks.calls.push("claim");
    return CLAIM;
  });
  mocks.recordIntent.mockImplementation(async (_claim: unknown, amount: number) => {
    mocks.calls.push(`intent:${amount}`);
    return true;
  });
  mocks.release.mockImplementation(async () => {
    mocks.calls.push("release");
    return true;
  });
  mocks.reissue.mockResolvedValue(null);
  mocks.updatePaymentIntentAmount.mockImplementation(async (id: string, amount: number) => {
    mocks.calls.push(`stripe:${amount}`);
    return { id, amount };
  });
  mocks.writeRaisedAmount.mockImplementation(
    async ({ amountCents }: { amountCents: number }) => {
      mocks.calls.push(`row:${amountCents}`);
      return true;
    },
  );
  mocks.enqueueRecovery.mockResolvedValue({ id: "recovery-1" });
  // mockReset, not just clear: a case's unconsumed `...Once` answers must not
  // leak into the next case.
  mocks.findRequest.mockReset();
  mocks.findRequest.mockResolvedValue(requestAt(5_000));
  mocks.recoveryDead.mockResolvedValue(false);
});

describe("the review-charge raise claim (#3402)", () => {
  it("a run that cannot claim calls NO provider, makes the debt durable, and says `deferred`", async () => {
    sharesRead(10_000);
    mocks.claim.mockResolvedValue(null);

    const result = await sync();

    // No carried figure is asserted here: a deferral mints and raises nothing,
    // and what a mint carries is proved where the minter runs for real
    // (`edit-financial-review-charge.test.ts`, `INV-OPS-015`).
    expect(result).toMatchObject({
      outcome: "deferred",
      paymentIntentId: null,
      totalCents: 10_000,
    });
    expect(mocks.updatePaymentIntentAmount).not.toHaveBeenCalled();
    expect(mocks.reissue).not.toHaveBeenCalled();
    expect(mocks.mint).not.toHaveBeenCalled();
    expect(mocks.writeRaisedAmount).not.toHaveBeenCalled();
    expect(mocks.release).not.toHaveBeenCalled();
    expect(mocks.enqueueRecovery).toHaveBeenCalledWith({
      bookingId: "booking-1",
      paymentId: "payment-1",
      bookingModificationId: "mod-1",
      advisoryAmountCents: 10_000,
      hadIssuedXeroInvoice: false,
    });
  });

  it("records the intent under the claim, THEN calls Stripe, THEN writes the row from Stripe's answer (the update arm), THEN releases", async () => {
    sharesRead(7_000);

    const result = await sync();

    expect(result).toMatchObject({ outcome: "raised", totalCents: 7_000 });
    expect(mocks.calls).toEqual(["claim", "intent:7000", "stripe:7000", "row:7000", "release"]);
    expect(mocks.recordIntent).toHaveBeenCalledWith(CLAIM, 7_000);
    // The carried figure is the minter's to prove (`INV-OPS-015`), not this file's.
    expect(mocks.writeRaisedAmount).toHaveBeenCalledWith(
      expect.objectContaining({ paymentId: "payment-1", paymentIntentId: "pi_request" }),
    );
  });

  it("the holder looks again AFTER releasing, and raises for a share that committed while it held the claim", async () => {
    // Pass 1 sees $60 (before the claim and under it); the read after release
    // sees B's share at $100. Pass 2 raises for it.
    const reads = [6_000, 6_000, 10_000];
    mocks.sumShares.mockImplementation(async () => {
      const total = reads.shift() ?? 10_000;
      mocks.calls.push(`read:${total}`);
      return total;
    });
    mocks.findRequest
      .mockResolvedValueOnce(requestAt(5_000))
      .mockResolvedValueOnce(requestAt(6_000));

    const result = await sync();

    expect(result).toMatchObject({ outcome: "raised", totalCents: 10_000 });
    // The read that finds B's share comes AFTER the release - B committed
    // before its own claim attempt, which was before that release.
    expect(mocks.calls).toEqual([
      "read:6000", "claim", "read:6000", "intent:6000", "stripe:6000", "row:6000", "release",
      "read:10000",
      "read:10000", "claim", "read:10000", "intent:10000", "stripe:10000", "row:10000", "release",
      "read:10000",
    ]);
    expect(mocks.enqueueRecovery).not.toHaveBeenCalled();
  });

  it("a raise Stripe REFUSES writes nothing to the row, still releases, and throws for the caller to make durable", async () => {
    sharesRead(7_000);
    mocks.updatePaymentIntentAmount.mockRejectedValue(new Error("amount could not be updated"));

    await expect(sync()).rejects.toThrow("amount could not be updated");

    expect(mocks.writeRaisedAmount).not.toHaveBeenCalled();
    expect(mocks.release).toHaveBeenCalledWith(CLAIM);
  });

  it("a run whose lease was taken over before the call makes NO provider call and defers", async () => {
    sharesRead(7_000);
    mocks.recordIntent.mockResolvedValue(false);

    const result = await sync();

    expect(result.outcome).toBe("deferred");
    expect(mocks.reissue).not.toHaveBeenCalled();
    expect(mocks.updatePaymentIntentAmount).not.toHaveBeenCalled();
    expect(mocks.enqueueRecovery).toHaveBeenCalledTimes(1);
  });

  it("the FIRST mint is under the claim too, and a lost lease mints nothing", async () => {
    sharesRead(7_000);
    mocks.findRequest.mockResolvedValue(null);
    mocks.paymentFindUnique.mockResolvedValue({
      id: "payment-1",
      status: PaymentStatus.SUCCEEDED,
      amountCents: 20_000,
      refundedAmountCents: 0,
      source: "STRIPE",
      stripeCustomerId: null,
      additionalAmountCents: 0,
      additionalPaymentStatus: null,
    });
    mocks.recordIntent.mockResolvedValue(false);

    await expect(sync()).resolves.toMatchObject({ outcome: "deferred" });
    expect(mocks.mint).not.toHaveBeenCalled();

    mocks.recordIntent.mockImplementation(async (_claim: unknown, amount: number) => {
      mocks.calls.push(`intent:${amount}`);
      return true;
    });
    mocks.mint.mockImplementation(async () => {
      mocks.calls.push("mint");
      return { additionalPaymentIntentId: "pi_minted" };
    });
    mocks.calls.length = 0;

    await expect(sync()).resolves.toMatchObject({ outcome: "raised", paymentIntentId: "pi_minted" });
    expect(mocks.calls).toEqual(["claim", "intent:7000", "mint", "release"]);
  });

  it("nothing owed claims nothing", async () => {
    sharesRead(0);

    await expect(sync()).resolves.toMatchObject({ outcome: "nothing-owed" });
    expect(mocks.claim).not.toHaveBeenCalled();
  });

  it("an exact replay claims, changes nothing at Stripe, and releases", async () => {
    sharesRead(5_000);

    await expect(sync()).resolves.toMatchObject({ outcome: "raised", totalCents: 5_000 });
    expect(mocks.calls).toEqual(["claim", "release"]);
  });

  it("shares that keep arriving faster than it can raise are handed to the recovery row after three passes", async () => {
    let total = 6_000;
    mocks.sumShares.mockImplementation(async () => {
      total += 1_000;
      return total;
    });
    mocks.findRequest.mockImplementation(async () => requestAt(5_000));

    const result = await sync();

    expect(mocks.claim).toHaveBeenCalledTimes(3);
    expect(mocks.release).toHaveBeenCalledTimes(3);
    expect(result.outcome).toBe("deferred");
    expect(mocks.enqueueRecovery).toHaveBeenCalledTimes(1);
  });

  it("the row records the amount STRIPE answered, and a short answer is raised again", async () => {
    sharesRead(7_000);
    mocks.updatePaymentIntentAmount
      .mockImplementationOnce(async (id: string) => {
        mocks.calls.push("stripe:short");
        return { id, amount: 6_500 };
      });
    mocks.findRequest
      .mockResolvedValueOnce(requestAt(5_000))
      .mockResolvedValueOnce(requestAt(6_500));

    const result = await sync();

    expect(mocks.calls.slice(0, 4)).toEqual(["claim", "intent:7000", "stripe:short", "row:6500"]);
    expect(result).toMatchObject({ outcome: "raised", totalCents: 7_000 });
  });

  it("a release that fails is logged, never thrown over a raise that succeeded", async () => {
    sharesRead(7_000);
    mocks.release.mockRejectedValue(new Error("connection reset"));

    await expect(sync()).resolves.toMatchObject({ outcome: "raised", totalCents: 7_000 });
  });

  it("a LOST lease after a provider call is never reported `raised`: it is logged and deferred to the recovery row", async () => {
    sharesRead(7_000);
    // The claim was taken over while this run was inside Stripe.
    mocks.release.mockResolvedValue(false);

    const result = await sync();

    expect(mocks.updatePaymentIntentAmount).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ outcome: "deferred", paymentIntentId: null, totalCents: 7_000 });
    expect(mocks.enqueueRecovery).toHaveBeenCalledTimes(1);
    expect(mocks.logError).toHaveBeenCalledWith(
      expect.objectContaining({ bookingModificationId: "mod-1", askedCents: 7_000, providerCents: 7_000 }),
      expect.stringContaining("lost its claim during the provider call"),
    );
  });

  it("a lost lease on a pass that called NO provider changes nothing it reported", async () => {
    // An exact replay: the request already covers the total, so nothing landed.
    sharesRead(5_000);
    mocks.release.mockResolvedValue(false);

    await expect(sync()).resolves.toMatchObject({ outcome: "raised", totalCents: 5_000 });
    expect(mocks.enqueueRecovery).not.toHaveBeenCalled();
  });

  it("a request PAID as it was raised keeps the status the payment wrote, and reports `already-paid`", async () => {
    sharesRead(7_000);
    // The status-fenced write matched nothing; the re-read finds the row captured.
    mocks.writeRaisedAmount.mockResolvedValue(false);
    mocks.findRequest
      .mockResolvedValueOnce(requestAt(5_000))
      .mockResolvedValueOnce({ ...requestAt(7_000), status: PaymentStatus.SUCCEEDED });

    const result = await sync();

    expect(result).toMatchObject({ outcome: "already-paid", paymentIntentId: "pi_request" });
    // Paid at the new amount, which covered every share this pass derived: no
    // shortfall to trace, and no recovery row to replay.
    expect(mocks.recordUncollected).not.toHaveBeenCalled();
    expect(mocks.enqueueRecovery).not.toHaveBeenCalled();
  });

  it("a holder that finds the request PAID leaves a deferred share to the armed recovery row: one trace per total, never two", async () => {
    // Pass 1 reads $60 and finds the request captured; B's $40 commits while it
    // holds the claim, and B defers - arming the recovery row, whose replay
    // traces the $100. Looking again here as well wrote the $100 twice.
    sharesRead(6_000, 6_000, 10_000);
    mocks.findRequest.mockResolvedValue({ ...requestAt(5_000), status: PaymentStatus.SUCCEEDED });

    const result = await sync();

    expect(result.outcome).toBe("already-paid");
    expect(mocks.recordUncollected.mock.calls.map(([args]) => args.derivedTotalCents)).toEqual([6_000]);
    expect(mocks.claim).toHaveBeenCalledTimes(1);
  });

  it("when the recovery row is DEAD (terminal FAILED, never re-armed) the holder looks again and traces the deferred share itself", async () => {
    sharesRead(6_000, 6_000, 10_000);
    mocks.findRequest.mockResolvedValue({ ...requestAt(5_000), status: PaymentStatus.SUCCEEDED });
    mocks.recoveryDead.mockResolvedValue(true);

    await expect(sync()).resolves.toMatchObject({ outcome: "already-paid" });
    expect(mocks.recordUncollected.mock.calls.map(([args]) => args.derivedTotalCents)).toEqual([
      6_000, 10_000,
    ]);
    expect(mocks.claim).toHaveBeenCalledTimes(2);
  });

  it("a PAID request that already covers every settled share is `already-paid` with NO audit row (nothing is uncollected)", async () => {
    // A replay a deferral reopened, after the holder raised to $100 and the
    // member paid it: an "ask-closed, $0.00 not added" record would be noise an
    // officer acts on.
    sharesRead(10_000);
    mocks.findRequest.mockResolvedValue({ ...requestAt(10_000), status: PaymentStatus.SUCCEEDED });

    await expect(sync()).resolves.toMatchObject({ outcome: "already-paid", totalCents: 10_000 });
    expect(mocks.recordUncollected).not.toHaveBeenCalled();
    expect(mocks.updatePaymentIntentAmount).not.toHaveBeenCalled();
  });

  it("a request WITHDRAWN as it was raised is not reported paid: the run defers to the recovery row", async () => {
    sharesRead(7_000);
    mocks.writeRaisedAmount.mockResolvedValue(false);
    // The re-read no longer finds a live request: an officer withdrew it (#3528).
    mocks.findRequest.mockResolvedValueOnce(requestAt(5_000)).mockResolvedValueOnce(null);

    await expect(sync()).resolves.toMatchObject({ outcome: "deferred", paymentIntentId: null });
    expect(mocks.enqueueRecovery).toHaveBeenCalledTimes(1);
    expect(mocks.recordUncollected).not.toHaveBeenCalled();
  });

  it("a PAID request with no share arriving meanwhile is traced exactly once", async () => {
    sharesRead(6_000);
    mocks.findRequest.mockResolvedValue({ ...requestAt(5_000), status: PaymentStatus.SUCCEEDED });

    await expect(sync()).resolves.toMatchObject({ outcome: "already-paid" });
    expect(mocks.recordUncollected).toHaveBeenCalledTimes(1);
    expect(mocks.claim).toHaveBeenCalledTimes(1);
  });
});
