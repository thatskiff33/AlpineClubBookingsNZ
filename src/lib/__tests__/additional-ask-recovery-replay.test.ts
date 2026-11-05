/**
 * #4015: an increase whose mint failed is never overtaken by a later ask.
 *
 * A later ask is sized off the `Payment`, and a failed mint never reached the
 * `Payment`, so no later ask carries that increase's money unless its edit
 * folded it in. A recovery the replay can size is therefore settled only by
 * its OWN row. Its replay carries the later ask's unpaid balance and
 * supersedes it. Only a `frozen` figure, whose carried part nobody recorded,
 * keeps #3340's recency rule. Pure, so no database: the real-PostgreSQL races
 * are in `additional-ask-reduction.realdb.test.ts`.
 */
import { PaymentRecoveryOperationStatus } from "@prisma/client";
import { describe, expect, it } from "vitest";

import type { AskRecoveryOperation } from "@/lib/additional-ask-pending-recoveries";
import { pendingAskRecoveries } from "@/lib/additional-ask-pending-recoveries";
import type { AskTransaction } from "@/lib/additional-ask-reduction";
import { ADDITIONAL_PAYABLE_BOOKING_STATUSES, resolveAdditionalPaymentDoor } from "@/lib/additional-payment-chase";
import { staleIntentAction } from "@/lib/stale-intent-action";
import {
  CARRIED_ASK_PAYMENT_WAIT_MAX_MS,
  CarriedAskPaymentWaitExpiredError,
  carriedAskPaymentWait,
  findOwnRecoveryRow,
  isRecoveryOvertakenByLaterAsk,
  isRecoveryReplaySettled,
  recoveryAskBeyondPaymentAskCents,
  sizeRecoveryReplayAsk,
} from "@/lib/additional-ask-recovery-replay";
import {
  buildAdditionalIntentRecoveryIdempotencyKey,
  buildEditFinancialReviewAdditionalIntentRecoveryIdempotencyKey,
} from "@/lib/payment-recovery-keys";

const QUEUED_AT = new Date("2026-06-20T00:00:00.000Z");
const LATER = new Date("2026-06-25T00:00:00.000Z");
const EARLIER = new Date("2026-06-10T00:00:00.000Z");

/** E1's failed mint, waiting under its Stripe key. */
const E1_RECOVERY = {
  createdAt: QUEUED_AT,
  paymentIntentId: "mod_guest_bk1_e1",
  idempotencyKey: buildAdditionalIntentRecoveryIdempotencyKey("mod-e1"),
};

function additionalRow(
  stripePaymentIntentId: string,
  createdAt: Date,
  stamp: { bookingModificationId?: string; withdrawnAt?: Date; status?: string } = {},
) {
  return {
    kind: "ADDITIONAL",
    status: stamp.status ?? "PENDING",
    createdAt,
    stripePaymentIntentId,
    bookingModificationId: stamp.bookingModificationId ?? null,
    withdrawnAt: stamp.withdrawnAt ?? null,
  };
}

/** E1 raised the price by $50 and its mint failed; nothing was folded. */
const E1 = { priceDiffCents: 5_000, changeFeeCents: 0, newData: {} };

describe("isRecoveryReplaySettled (#4015)", () => {
  it("case 2: a later edit's ask, sized off a Payment that never showed E1, does not settle E1's recovery", () => {
    // E2 +$20 minted after E1's mint failed; the Payment shows only E2's ask.
    const payment = { additionalAmountCents: 2_000, additionalPaymentStatus: "PENDING" };
    const replay = sizeRecoveryReplayAsk({ frozenAmountCents: 5_000, modification: E1, payment });

    expect(isRecoveryReplaySettled(replay, E1_RECOVERY, [additionalRow("pi_e2", LATER)])).toBe(false);
    // Its replay asks for E1's own $50 AND carries E2's unpaid $20, superseding it.
    expect(replay).toEqual({
      kind: "increase",
      ask: expect.objectContaining({ amountCents: 7_000, carriedCents: 2_000 }),
      foldedCents: 0,
    });
  });

  it("case 1: two increase retries pending - whichever wrote its row first does not settle the other", () => {
    // E2's replay minted first and wrote its row; E1 still waits.
    const payment = { additionalAmountCents: 2_000, additionalPaymentStatus: "PENDING" };
    const replay = sizeRecoveryReplayAsk({ frozenAmountCents: 5_000, modification: E1, payment });
    expect(isRecoveryReplaySettled(replay, E1_RECOVERY, [additionalRow("pi_e2_replayed", LATER)])).toBe(false);
  });

  it("comment 2: a folded E3 that replayed first does not settle the unfolded E4", () => {
    // E3 (+$10, folding a $30 re-issue) replayed into a $40 row; E4 +$5 waits.
    const payment = { additionalAmountCents: 4_000, additionalPaymentStatus: "PENDING" };
    const e4 = { priceDiffCents: 500, changeFeeCents: 0, newData: {} };
    const replay = sizeRecoveryReplayAsk({ frozenAmountCents: 500, modification: e4, payment });

    expect(isRecoveryReplaySettled(replay, E1_RECOVERY, [additionalRow("pi_e3", LATER)])).toBe(false);
    expect(replay.kind === "increase" && replay.ask.amountCents).toBe(4_500);
  });

  it("is settled once its OWN row exists, newer or older than the recovery, so a retry never mints twice", () => {
    const payment = { additionalAmountCents: 5_000, additionalPaymentStatus: "PENDING" };
    const replay = sizeRecoveryReplayAsk({ frozenAmountCents: 5_000, modification: E1, payment });
    const recorded = { ...E1_RECOVERY, paymentIntentId: "pi_e1_recovered" };

    expect(isRecoveryReplaySettled(replay, recorded, [additionalRow("pi_e1_recovered", LATER)])).toBe(true);
    expect(isRecoveryReplaySettled(replay, recorded, [additionalRow("pi_e1_recovered", EARLIER)])).toBe(true);
  });

  it("a row older than the recovery that is not its own never settles it", () => {
    const payment = { additionalAmountCents: 2_000, additionalPaymentStatus: "PENDING" };
    const replay = sizeRecoveryReplayAsk({ frozenAmountCents: 5_000, modification: E1, payment });
    expect(isRecoveryReplaySettled(replay, E1_RECOVERY, [additionalRow("pi_before", EARLIER)])).toBe(false);
  });

  it("a FROZEN figure keeps #3340's recency rule: its carried part is unknown, so carrying a later ask could charge it twice", () => {
    const payment = { additionalAmountCents: 2_000, additionalPaymentStatus: "PENDING" };
    const frozen = sizeRecoveryReplayAsk({ frozenAmountCents: 5_000, modification: null, payment });
    expect(frozen.kind).toBe("frozen");

    const later = [additionalRow("pi_e2", LATER)];
    expect(isRecoveryReplaySettled(frozen, E1_RECOVERY, later)).toBe(true);
    expect(isRecoveryReplaySettled(frozen, E1_RECOVERY, [additionalRow("pi_before", EARLIER)])).toBe(false);
    // The recency predicate itself is unchanged.
    expect(isRecoveryOvertakenByLaterAsk(E1_RECOVERY, later)).toBe(true);
  });
});

describe("pendingAskRecoveries: a reduction nets a waiting increase a later ask did not carry (#4015)", () => {
  const booking = {
    id: "bk1",
    status: "PAID",
    payment: { id: "pay1", additionalAmountCents: 2_000, additionalPaymentStatus: "PENDING", additionalPaymentIntentId: "pi_e2" },
  };
  const operation: AskRecoveryOperation = {
    id: "op-e1",
    status: PaymentRecoveryOperationStatus.PENDING,
    attempts: 1,
    nextRetryAt: LATER,
    processingStartedAt: null,
    idempotencyKey: buildAdditionalIntentRecoveryIdempotencyKey("mod-e1"),
    paymentIntentId: E1_RECOVERY.paymentIntentId,
    amountCents: 5_000,
    hadIssuedXeroInvoice: true,
    createdAt: QUEUED_AT,
  };
  const e2Row = {
    id: "txn-e2",
    kind: "ADDITIONAL",
    source: "STRIPE",
    status: "PENDING",
    reason: "guest_add_price_increase",
    amountCents: 2_000,
    carriedAskCents: 0,
    stripePaymentIntentId: "pi_e2",
    createdAt: LATER,
    withdrawnAt: null,
    hadIssuedXeroInvoice: true,
    bookingModificationId: "mod-e2",
  } as unknown as AskTransaction;

  it("counts E1's own $50 as still owed beside E2's live ask - the ask a later reduction must set against", () => {
    const pending = pendingAskRecoveries(booking, booking.payment, [operation], [e2Row], [{ id: "mod-e1", ...E1 }]);

    expect(pending).toEqual([
      expect.objectContaining({ id: "op-e1", bookingModificationId: "mod-e1", kind: "increase", askCents: 5_000, invoiceCents: 5_000 }),
    ]);
    // What the replay adds beyond the Payment's ask is E1's own money, never E2's twice.
    const replay = sizeRecoveryReplayAsk({ frozenAmountCents: 5_000, modification: E1, payment: booking.payment });
    expect(recoveryAskBeyondPaymentAskCents(replay)).toBe(5_000);
  });
});

describe("findOwnRecoveryRow: one own-row rule for the replay's resume and the settled check (#4015 review L5)", () => {
  const payment = { additionalAmountCents: 5_000, additionalPaymentStatus: "PENDING" };
  const replay = sizeRecoveryReplayAsk({ frozenAmountCents: 5_000, modification: E1, payment });

  it("the door's own row, stamped with the edit, is the recovery's own though the recovery holds only the Stripe key - never a later ask to carry", () => {
    // The door wrote its row, then a later step threw (or the commit's reply was lost) and enqueued the recovery.
    const doorRow = additionalRow("pi_e1_door", EARLIER, { bookingModificationId: "mod-e1" });
    expect(findOwnRecoveryRow(E1_RECOVERY, [doorRow])).toBe(doorRow);
    expect(isRecoveryReplaySettled(replay, E1_RECOVERY, [doorRow])).toBe(true);
  });

  it("a row stamped with ANOTHER edit is never its own", () => {
    const e2Row = additionalRow("pi_e2", LATER, { bookingModificationId: "mod-e2" });
    expect(findOwnRecoveryRow(E1_RECOVERY, [e2Row])).toBeNull();
    expect(isRecoveryReplaySettled(replay, E1_RECOVERY, [e2Row])).toBe(false);
  });

  it("a stamped row a reduction withdrew is still its own - the reduction netted it, so the replay must not ask for it again", () => {
    const withdrawn = additionalRow("pi_e1_door", EARLIER, { bookingModificationId: "mod-e1", withdrawnAt: LATER });
    expect(findOwnRecoveryRow(E1_RECOVERY, [withdrawn])).toBe(withdrawn);
    expect(isRecoveryReplaySettled(replay, E1_RECOVERY, [withdrawn])).toBe(true);
  });

  it("prefers the live stamped row over a withdrawn one, and the recorded intent over either", () => {
    const withdrawn = additionalRow("pi_e1_old", EARLIER, { bookingModificationId: "mod-e1", withdrawnAt: LATER });
    const live = additionalRow("pi_e1_reissued", LATER, { bookingModificationId: "mod-e1" });
    expect(findOwnRecoveryRow(E1_RECOVERY, [withdrawn, live])).toBe(live);
    const recordedRow = additionalRow("pi_e1_recovered", LATER);
    expect(findOwnRecoveryRow({ ...E1_RECOVERY, paymentIntentId: "pi_e1_recovered" }, [withdrawn, live, recordedRow])).toBe(recordedRow);
  });

  it("REVIEW 4: a currency re-issue left the old row FAILED, not withdrawn - the open re-issued row wins, so the invoice waits on the intent the member can pay", () => {
    const stale = additionalRow("pi_e1_nzd_stale", EARLIER, { bookingModificationId: "mod-e1", status: "FAILED" });
    const reissued = additionalRow("pi_e1_reissued", LATER, { bookingModificationId: "mod-e1", status: "PENDING" });
    // Ledger order is oldest first, so the stale row comes first.
    expect(findOwnRecoveryRow(E1_RECOVERY, [stale, reissued])).toBe(reissued);
    // A captured stamped row also beats a dead one.
    const captured = additionalRow("pi_e1_paid", EARLIER, { bookingModificationId: "mod-e1", status: "SUCCEEDED" });
    expect(findOwnRecoveryRow(E1_RECOVERY, [captured, { ...stale, createdAt: LATER }])).toBe(captured);
  });

  it("REVIEW L-1(a): a stale FAILED predecessor never outranks the newer re-issue a reduction withdrew - the newest stamped row decides, and it is withdrawn", () => {
    // E1's door wrote pi_old (a later step threw, so R1 was queued); a currency
    // re-issue wrote pi_new with the same stamp and left pi_old FAILED; a reduction withdrew pi_new.
    const old = additionalRow("pi_old", EARLIER, { bookingModificationId: "mod-e1", status: "FAILED" });
    const withdrawnNew = additionalRow("pi_new", LATER, { bookingModificationId: "mod-e1", status: "FAILED", withdrawnAt: LATER });
    expect(findOwnRecoveryRow(E1_RECOVERY, [old, withdrawnNew])).toBe(withdrawnNew);
    // Still settled: the reduction netted it, and the replay finishes without an invoice.
    const payment = { additionalAmountCents: 0, additionalPaymentStatus: null };
    expect(isRecoveryReplaySettled(sizeRecoveryReplayAsk({ frozenAmountCents: 5_000, modification: E1, payment }), E1_RECOVERY, [old, withdrawnNew])).toBe(true);
  });

  it("REVIEW L-1(b): the recorded intent's row is dead and an open row carries the same stamp - the open one wins; a live recorded intent still wins outright", () => {
    const recorded = { ...E1_RECOVERY, paymentIntentId: "pi_e1_recovered" };
    const deadRecorded = additionalRow("pi_e1_recovered", EARLIER, { bookingModificationId: "mod-e1", status: "FAILED" });
    const reissued = additionalRow("pi_e1_reissued", LATER, { bookingModificationId: "mod-e1", status: "PENDING" });
    expect(findOwnRecoveryRow(recorded, [deadRecorded, reissued])).toBe(reissued);
    // With no open or captured stamped row, the recorded intent's own row (superseded, withdrawn or not).
    const deadStamped = { ...reissued, status: "FAILED" };
    expect(findOwnRecoveryRow(recorded, [deadRecorded, deadStamped])).toBe(deadRecorded);
    // A live recorded intent beats a newer open stamped row.
    const liveRecorded = { ...deadRecorded, status: "PENDING" };
    expect(findOwnRecoveryRow(recorded, [liveRecorded, reissued])).toBe(liveRecorded);
  });

  it("REVIEW 4: with no open or captured stamped row, the newest stamped row, live or withdrawn", () => {
    const older = additionalRow("pi_e1_a", EARLIER, { bookingModificationId: "mod-e1", status: "FAILED" });
    const newer = additionalRow("pi_e1_b", LATER, { bookingModificationId: "mod-e1", status: "FAILED" });
    expect(findOwnRecoveryRow(E1_RECOVERY, [older, newer])).toBe(newer);
    const withdrawnOld = { ...older, withdrawnAt: LATER };
    const withdrawnNew = { ...newer, withdrawnAt: LATER };
    expect(findOwnRecoveryRow(E1_RECOVERY, [withdrawnOld, withdrawnNew])).toBe(withdrawnNew);
  });

  it("an officer's review charge is never matched by the edit stamp, only by its recorded intent", () => {
    const review = { ...E1_RECOVERY, idempotencyKey: buildEditFinancialReviewAdditionalIntentRecoveryIdempotencyKey("mod-e1") };
    expect(findOwnRecoveryRow(review, [additionalRow("pi_e1_door", EARLIER, { bookingModificationId: "mod-e1" })])).toBeNull();
    const recordedRow = additionalRow("pi_review", LATER);
    expect(findOwnRecoveryRow({ ...review, paymentIntentId: "pi_review" }, [recordedRow])).toBe(recordedRow);
  });

  it("only ADDITIONAL rows count", () => {
    const primary = { ...additionalRow("mod_guest_bk1_e1", EARLIER, { bookingModificationId: "mod-e1" }), kind: "PRIMARY" };
    expect(findOwnRecoveryRow(E1_RECOVERY, [primary])).toBeNull();
  });
});

describe("carriedAskPaymentWait: a replay never supersedes an ask Stripe is taking money on (#4015 review C1, items 1-2)", () => {
  const livePayment = { additionalAmountCents: 2_000, additionalPaymentStatus: "PENDING", additionalPaymentIntentId: "pi_e2" };
  const QUEUED = new Date("2026-06-29T00:00:00.000Z");
  const NOW = new Date("2026-07-01T00:00:00.000Z");
  /** Stripe's answer: the intent created and charged the day the recovery was queued, unless a test says. */
  const answering = (status: string, began: { created?: Date; charged?: Date | null } = {}) => {
    const calls: string[] = [];
    const seconds = (at: Date) => Math.floor(at.getTime() / 1000);
    return {
      calls,
      retrieve: async (id: string) => {
        calls.push(id);
        const charged = began.charged === undefined ? QUEUED : began.charged;
        return { status, created: seconds(began.created ?? QUEUED), latest_charge: charged ? { created: seconds(charged) } : null };
      },
    };
  };

  it.each(["succeeded", "processing", "requires_capture", "some_future_status"])(
    "waits - never supersedes - while the carried ask is %s (an unknown status fails safe)",
    async (status) => {
      const stripe = answering(status);
      const wait = await carriedAskPaymentWait(livePayment, stripe.retrieve, QUEUED, NOW);
      expect(wait).toContain(`(pi_e2) is ${status} at Stripe`);
      expect(wait).toContain("until that payment is recorded");
      expect(stripe.calls).toEqual(["pi_e2"]);
    },
  );

  it.each(["requires_payment_method", "requires_confirmation", "requires_action", "canceled"])(
    "lets the replay supersede an ask that is %s (unpaid by `staleIntentAction`, or cancelled)",
    async (status) => {
      await expect(carriedAskPaymentWait(livePayment, answering(status).retrieve, QUEUED, NOW)).resolves.toBeNull();
    },
  );

  it("stops for good once both the recovery and the payment are older than the cap, naming the intent and its status", async () => {
    const longAgo = new Date(NOW.getTime() - CARRIED_ASK_PAYMENT_WAIT_MAX_MS - 1000);
    const old = { created: longAgo, charged: longAgo };
    const stopped = carriedAskPaymentWait(livePayment, answering("processing", old).retrieve, longAgo, NOW);
    await expect(stopped).rejects.toBeInstanceOf(CarriedAskPaymentWaitExpiredError);
    await expect(stopped).rejects.toMatchObject({ paymentIntentId: "pi_e2", status: "processing" });
    // At the cap exactly it still waits.
    const atCap = new Date(NOW.getTime() - CARRIED_ASK_PAYMENT_WAIT_MAX_MS);
    await expect(carriedAskPaymentWait(livePayment, answering("processing", { created: atCap, charged: atCap }).retrieve, atCap, NOW)).resolves.toContain("waiting");
    // An unpaid ask past the cap is simply superseded.
    await expect(carriedAskPaymentWait(livePayment, answering("requires_payment_method", old).retrieve, longAgo, NOW)).resolves.toBeNull();
  });

  it("REVIEW L-2: an OLD recovery meeting a payment that has just begun waits - the clock starts at the later of the two", async () => {
    const longAgo = new Date(NOW.getTime() - 30 * 86_400_000);
    // An old intent whose charge (a bank debit) began yesterday.
    const freshCharge = answering("processing", { created: longAgo, charged: new Date(NOW.getTime() - 86_400_000) });
    await expect(carriedAskPaymentWait(livePayment, freshCharge.retrieve, longAgo, NOW)).resolves.toContain("(pi_e2) is processing at Stripe");
    // No charge yet (an unknown status, say): the intent's own creation is the start.
    const freshIntent = answering("some_future_status", { created: new Date(NOW.getTime() - 86_400_000), charged: null });
    await expect(carriedAskPaymentWait(livePayment, freshIntent.retrieve, longAgo, NOW)).resolves.toContain("waiting");
    // A charge that began past the cap, on an old recovery, stops.
    const staleCharge = answering("processing", { created: longAgo, charged: longAgo });
    await expect(carriedAskPaymentWait(livePayment, staleCharge.retrieve, longAgo, NOW)).rejects.toBeInstanceOf(CarriedAskPaymentWaitExpiredError);
  });

  it("an intent Stripe has no record of is nothing being paid", async () => {
    const missing = async () => {
      throw Object.assign(new Error("No such payment_intent"), { code: "resource_missing" });
    };
    await expect(carriedAskPaymentWait(livePayment, missing, QUEUED, NOW)).resolves.toBeNull();
  });

  it("asks Stripe nothing when there is no unpaid ask to carry", async () => {
    for (const payment of [
      { ...livePayment, additionalPaymentStatus: "SUCCEEDED" },
      { ...livePayment, additionalAmountCents: 0 },
      { ...livePayment, additionalPaymentIntentId: null },
    ]) {
      const stripe = answering("succeeded");
      await expect(carriedAskPaymentWait(payment, stripe.retrieve, QUEUED, NOW)).resolves.toBeNull();
      expect(stripe.calls).toEqual([]);
    }
  });

  it("any other Stripe read error (a timeout, an outage) propagates, so the replay retries rather than superseding blind", async () => {
    const outage = async () => {
      throw new Error("Request timed out");
    };
    await expect(carriedAskPaymentWait(livePayment, outage, QUEUED, NOW)).rejects.toThrow("Request timed out");
  });
});

describe("REVIEW I-1: the pay door and `staleIntentAction` agree on every status Stripe documents", () => {
  const door = (status: string) =>
    resolveAdditionalPaymentDoor(
      {
        bookingStatus: ADDITIONAL_PAYABLE_BOOKING_STATUSES[0],
        bookingDeletedAt: null,
        payment: { additionalPaymentIntentId: "pi_x", additionalPaymentStatus: "PENDING" },
      },
      async () => ({ status }),
    );

  it.each([
    "requires_payment_method",
    "requires_confirmation",
    "requires_action",
    "processing",
    "requires_capture",
    "succeeded",
  ])("%s: the door refuses a second form exactly when the replay would not supersede", async (status) => {
    const answer = await door(status);
    expect(answer.state === "captured-at-provider").toBe(staleIntentAction({ status }) !== "reissue");
    expect(answer.state).not.toBe("closed");
  });

  it("canceled closes the door, and is never waited on by the replay", async () => {
    expect((await door("canceled")).state).toBe("closed");
  });

  it("the one deliberate difference: an unknown status stays payable at the door, while the replay fails safe and waits", async () => {
    expect((await door("some_future_status")).state).toBe("payable");
    expect(staleIntentAction({ status: "some_future_status" })).not.toBe("reissue");
  });
});
