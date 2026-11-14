/**
 * #4911 (`INV-PAY-154`): the one read of "is this capture disputed", and the
 * refusal every card-refund door and the recovery runner act on. The cancel
 * door's use of it runs on PostgreSQL (`stripe-dispute-cancel.realdb.test.ts`);
 * the card-refund chokepoint's in `stripe.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PaymentRecoveryOperationType, type Prisma } from "@prisma/client";

const db = vi.hoisted(() => ({
  stripeDispute: { findMany: vi.fn() },
  paymentTransaction: { findMany: vi.fn() },
}));
vi.mock("@/lib/prisma", () => ({ prisma: db }));
/** The double, as the reader the helpers take (each test sets only the one query it reads). */
const reader = db as unknown as Prisma.TransactionClient;

import {
  assertCaptureNotDisputed,
  disputedCaptureCents,
  disputedCaptureRefusal,
  DisputedCaptureRefundRefusedError,
  paymentCaptureIntentIds,
} from "@/lib/stripe-dispute-hold";
import { HOLDING_DISPUTE_STATUSES, disputeHoldsCapture } from "@/lib/stripe-dispute-note";
import { disputedCaptureRefundCause, unretryableRecoveryCause } from "@/lib/recovery-unretryable-cause";
import { PartialRefundError } from "@/lib/payment-transactions";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";

const OPEN = { stripeDisputeId: "dp_open", stripePaymentIntentId: "pi_1", status: "OPEN" as const, amountCents: 3000 };
const LOST = { stripeDisputeId: "dp_lost", stripePaymentIntentId: "pi_2", status: "LOST" as const, amountCents: 2000 };

beforeEach(() => {
  db.stripeDispute.findMany.mockReset().mockResolvedValue([]);
  db.paymentTransaction.findMany.mockReset().mockResolvedValue([]);
});

describe("disputedCaptureCents (#4911)", () => {
  it("holds only on open and lost disputes", () => {
    expect([...HOLDING_DISPUTE_STATUSES]).toEqual(["OPEN", "LOST"]);
    expect((["OPEN", "WON", "LOST", "CLOSED_OTHER"] as const).filter(disputeHoldsCapture)).toEqual(["OPEN", "LOST"]);
  });

  it("asks nothing when there is no capture to ask about", async () => {
    expect(await disputedCaptureCents(reader, [null, undefined, ""])).toEqual({ cents: 0, disputes: [] });
    expect(db.stripeDispute.findMany).not.toHaveBeenCalled();
  });

  it("reads each capture once, for holding disputes only, and sums what they claim", async () => {
    db.stripeDispute.findMany.mockResolvedValue([OPEN, LOST]);

    expect(await disputedCaptureCents(reader, ["pi_1", "pi_2", "pi_1", null])).toEqual({ cents: 5000, disputes: [OPEN, LOST] });
    expect(db.stripeDispute.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { stripePaymentIntentId: { in: ["pi_1", "pi_2"] }, status: { in: ["OPEN", "LOST"] } },
    }));
  });
});

describe("paymentCaptureIntentIds (#4911)", () => {
  it("names the payment's own intents and every ledger row's, once each", async () => {
    db.paymentTransaction.findMany.mockResolvedValue([{ stripePaymentIntentId: "pi_1" }, { stripePaymentIntentId: "pi_3" }]);

    expect(await paymentCaptureIntentIds(reader, { id: "payment_1", stripePaymentIntentId: "pi_1", additionalPaymentIntentId: "pi_2" }))
      .toEqual(["pi_1", "pi_2", "pi_3"]);
    expect(db.paymentTransaction.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { paymentId: "payment_1", stripePaymentIntentId: { not: null } },
    }));
  });
});

describe("the refusal (#4911)", () => {
  it("throws for a held capture, naming each dispute, and passes one with none", async () => {
    await expect(assertCaptureNotDisputed("pi_1")).resolves.toBeUndefined();

    db.stripeDispute.findMany.mockResolvedValue([OPEN]);
    const refused = assertCaptureNotDisputed("pi_1");
    await expect(refused).rejects.toBeInstanceOf(DisputedCaptureRefundRefusedError);
    await expect(refused).rejects.toThrow(/dp_open, open/);
  });

  it("says a lost dispute will not release the refund, and an open one may", () => {
    expect(new DisputedCaptureRefundRefusedError("pi_1", [OPEN]).lost).toBe(false);
    expect(new DisputedCaptureRefundRefusedError("pi_1", [OPEN, LOST]).lost).toBe(true);
  });

  it("is found bare or as a partial refund's cause, and nowhere else", () => {
    const bare = new DisputedCaptureRefundRefusedError("pi_1", [OPEN]);
    const wrapped = new PartialRefundError({ completedRefundCents: 0, refunds: [], cause: bare, format: CLUB_FORMAT_TEST });

    expect(disputedCaptureRefusal(bare)).toBe(bare);
    expect(disputedCaptureRefusal(wrapped)).toBe(bare);
    expect(disputedCaptureRefusal(new PartialRefundError({ completedRefundCents: 0, refunds: [], cause: new Error("Stripe down"), format: CLUB_FORMAT_TEST }))).toBeNull();
    expect(disputedCaptureRefusal(new Error("Stripe down"))).toBeNull();
  });
});

describe("the recovery runner stops a disputed refund (#4911)", () => {
  it("ends the row on the first refusal, naming the dispute, for any recovery type", async () => {
    const refused = new PartialRefundError({
      completedRefundCents: 0,
      refunds: [],
      cause: new DisputedCaptureRefundRefusedError("pi_2", [LOST]),
      format: CLUB_FORMAT_TEST,
    });

    for (const type of Object.values(PaymentRecoveryOperationType)) {
      expect(await unretryableRecoveryCause({ type }, refused)).toBe(disputedCaptureRefundCause([LOST]));
    }
    expect(disputedCaptureRefundCause([LOST])).toContain("Stripe dispute dp_lost (lost)");
  });

  it("still retries a refund that failed for any other reason", async () => {
    const failed = new PartialRefundError({ completedRefundCents: 0, refunds: [], cause: new Error("Stripe down"), format: CLUB_FORMAT_TEST });

    expect(await unretryableRecoveryCause({ type: PaymentRecoveryOperationType.REFUND_BOOKING_MODIFICATION }, failed)).toBeNull();
  });
});
