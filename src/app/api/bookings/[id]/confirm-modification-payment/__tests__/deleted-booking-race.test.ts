import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * #2700 surface 2 — a modification payment captured against a booking the club
 * has already deleted.
 *
 * THIS ENDPOINT DOES NOT REFUSE, and that is the decision rather than an
 * oversight. Every other surface in #2700 refuses; this one deliberately does
 * not, because Stripe has already captured the money by the time it is called.
 * A 404 here would leave a captured payment with no ledger row, which is worse
 * than a ledger row against a deleted booking. So the payment is recorded
 * exactly as it would be on a live booking — and then an OPEN
 * `ManualRefundTask` is raised, because a ledger row nobody looks at is not
 * "accounted for", and a person, not the system, decides whether to refund.
 *
 * Both of the issue body's original options were rejected by the owner on
 * 10 Aug 2026: "record it anyway" tells nobody, "refuse and let Stripe
 * reconciliation catch it" leaves the club holding a member's money with no
 * record of it. This is both halves.
 *
 * NO AUTOMATIC REFUND FROM HERE — a money movement triggered by a race, and if
 * the DELETION was itself the mistake an automatic refund compounds it rather
 * than surfacing it. Pinned below by asserting the refund path is never
 * reached.
 *
 * THE FLAG IS READ TWICE, AND BOTH READS ARE LOAD-BEARING. The opening read
 * happens before `getPaymentIntent` — a live Stripe round trip — so deciding
 * from it alone handles only ONE of the two orderings of the very race this
 * endpoint exists for: booking already deleted when we looked. The other
 * ordering, deleted WHILE we were talking to Stripe, recorded the capture and
 * raised nothing, which is the state `INV-ADDPAY-036` promises cannot occur. A
 * re-read immediately before the decision closes it. Either read seeing a
 * deletion is enough, because nothing in the tree un-deletes a booking.
 *
 * MUTATION PROOF. Delete the `if (deletedAt)` block and "records the payment AND
 * raises an OPEN ManualRefundTask" fails by name. Replace it with a 404 refusal
 * and "records the capture even though the booking is gone" fails. Move the task
 * raise ABOVE `markPaymentIntentTransactionSucceeded` and "records the money
 * before queueing the human decision" fails. Remove the try/catch and "still
 * reports success when the task cannot be raised" fails. Drop the re-read and
 * decide from the opening read alone, and "raises the task when the booking is
 * deleted DURING the Stripe round trip" fails. Move the re-read above
 * `markPaymentIntentTransactionSucceeded` and "re-reads the flag only after the
 * money is recorded" fails.
 */
const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  requireActiveSessionUser: vi.fn(),
  paymentFindUnique: vi.fn(),
  bookingFindUnique: vi.fn(),
  getPaymentIntent: vi.fn(),
  findPaymentTransactionByIntentId: vi.fn(),
  markPaymentIntentTransactionSucceeded: vi.fn(),
  refundPaymentTransactions: vi.fn(),
  raiseTask: vi.fn(),
  releaseXero: vi.fn(),
  kickXero: vi.fn(),
  logAudit: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ auth: mocks.auth }));
vi.mock("@/lib/session-guards", () => ({
  requireActiveSessionUser: mocks.requireActiveSessionUser,
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    payment: {
      findUnique: (...args: unknown[]) => mocks.paymentFindUnique(...args),
    },
    booking: {
      findUnique: (...args: unknown[]) => mocks.bookingFindUnique(...args),
    },
  },
}));
vi.mock("@/lib/stripe", () => ({
  getPaymentIntent: (...args: unknown[]) => mocks.getPaymentIntent(...args),
}));
vi.mock("@/lib/payment-transactions", () => ({
  findPaymentTransactionByIntentId: (...args: unknown[]) =>
    mocks.findPaymentTransactionByIntentId(...args),
  markPaymentIntentTransactionSucceeded: (...args: unknown[]) =>
    mocks.markPaymentIntentTransactionSucceeded(...args),
  // Never called by this route. Present so "no automatic refund" is asserted
  // against a real spy rather than merely asserted in prose.
  refundPaymentTransactions: (...args: unknown[]) =>
    mocks.refundPaymentTransactions(...args),
}));
vi.mock("@/lib/deleted-booking-modification-payment", () => ({
  raiseDeletedBookingModificationRefundTask: (...args: unknown[]) =>
    mocks.raiseTask(...args),
}));
vi.mock("@/lib/xero-operation-outbox", () => ({
  releaseXeroSupplementaryInvoiceForCapturedPaymentIntent: (
    ...args: unknown[]
  ) => mocks.releaseXero(...args),
  kickQueuedXeroOutboxOperationsIfConnected: (...args: unknown[]) =>
    mocks.kickXero(...args),
}));
vi.mock("@/lib/audit", () => ({
  logAudit: (...args: unknown[]) => mocks.logAudit(...args),
}));

import { POST } from "@/app/api/bookings/[id]/confirm-modification-payment/route";

const OWNER = {
  user: { id: "member-1", role: "MEMBER", accessRoles: [{ role: "USER" }] },
};
const STRANGER = {
  user: { id: "stranger-1", role: "MEMBER", accessRoles: [{ role: "USER" }] },
};

const INTENT_ID = "pi_modification";
const AMOUNT_CENTS = 2500;
const DELETED_AT = new Date("2026-06-01T00:00:00.000Z");

/**
 * The producible shape. `getCancelledBookingDeleteBlockers` refuses a delete
 * over CAPTURED payment history but permits one over a PaymentTransaction that
 * has not captured yet — which is exactly this row a moment before Stripe took
 * the money.
 */
function payment(deletedAt: Date | null) {
  return {
    id: "payment-1",
    additionalPaymentIntentId: INTENT_ID,
    booking: { memberId: "member-1", deletedAt },
  };
}

function callRoute() {
  return POST(
    new NextRequest(
      "http://localhost/api/bookings/booking-1/confirm-modification-payment",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ paymentIntentId: INTENT_ID }),
      },
    ),
    { params: Promise.resolve({ id: "booking-1" }) },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireActiveSessionUser.mockResolvedValue(null);
  mocks.auth.mockResolvedValue(OWNER);
  mocks.findPaymentTransactionByIntentId.mockResolvedValue({
    id: "ptx-1",
    status: "PENDING",
    amountCents: AMOUNT_CENTS,
  });
  mocks.getPaymentIntent.mockResolvedValue({
    id: INTENT_ID,
    status: "succeeded",
    amount: AMOUNT_CENTS,
    payment_method: "pm_1",
  });
  mocks.markPaymentIntentTransactionSucceeded.mockResolvedValue({});
  // The re-read's default answer is "still live", so every pre-existing case
  // below keeps testing exactly what it did before.
  mocks.bookingFindUnique.mockResolvedValue({ deletedAt: null });
  mocks.raiseTask.mockResolvedValue({
    taskId: "task-1",
    created: true,
    alreadyRefunded: false,
  });
  mocks.releaseXero.mockResolvedValue({ released: 0 });
  // Armed to EXPLODE: this route must never issue a refund.
  mocks.refundPaymentTransactions.mockImplementation(() => {
    throw new Error(
      "confirm-modification-payment must never refund automatically (#2700)",
    );
  });
});

describe("POST confirm-modification-payment — capture on a deleted booking (#2700)", () => {
  it("records the payment AND raises an OPEN ManualRefundTask, exactly once", async () => {
    mocks.paymentFindUnique.mockResolvedValue(payment(DELETED_AT));

    const res = await callRoute();

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ success: true });

    // Half one: the money is on the ledger.
    expect(mocks.markPaymentIntentTransactionSucceeded).toHaveBeenCalledTimes(1);
    expect(mocks.markPaymentIntentTransactionSucceeded).toHaveBeenCalledWith({
      paymentIntentId: INTENT_ID,
      amountCents: AMOUNT_CENTS,
      paymentMethodId: "pm_1",
    });

    // Half two: a person is told, exactly once, with the booking, payment and
    // captured amount the task needs to be actionable.
    expect(mocks.raiseTask).toHaveBeenCalledTimes(1);
    expect(mocks.raiseTask).toHaveBeenCalledWith({
      bookingId: "booking-1",
      paymentId: "payment-1",
      paymentIntentId: INTENT_ID,
      amountCents: AMOUNT_CENTS,
    });
  });

  it("moves no money by itself — no automatic refund", async () => {
    mocks.paymentFindUnique.mockResolvedValue(payment(DELETED_AT));

    await callRoute();

    expect(mocks.refundPaymentTransactions).not.toHaveBeenCalled();
  });

  it("records the capture even though the booking is gone", async () => {
    // The complement to every other guard in #2700. A 404 here would be the
    // pattern-match, and it is the wrong answer: it would leave Stripe holding
    // captured money with nothing in the ledger against it.
    mocks.paymentFindUnique.mockResolvedValue(payment(DELETED_AT));

    const res = await callRoute();

    expect(res.status).not.toBe(404);
    expect(mocks.markPaymentIntentTransactionSucceeded).toHaveBeenCalled();
  });

  it("records the money before queueing the human decision", async () => {
    // Ordering matters: the task points at a payment, so the payment must
    // already be recorded when the queue row appears.
    mocks.paymentFindUnique.mockResolvedValue(payment(DELETED_AT));

    await callRoute();

    expect(
      mocks.markPaymentIntentTransactionSucceeded.mock.invocationCallOrder[0],
    ).toBeLessThan(mocks.raiseTask.mock.invocationCallOrder[0]);
  });

  it("still reports success when the task cannot be raised", async () => {
    // The money IS recorded by this point. Turning that into a 500 the member
    // sees would invite a retry that takes the already-captured early return and
    // never reaches the raise again — losing the task for good. Logged loudly
    // instead.
    mocks.paymentFindUnique.mockResolvedValue(payment(DELETED_AT));
    mocks.raiseTask.mockRejectedValue(new Error("database is down"));

    const res = await callRoute();

    expect(res.status).toBe(200);
    expect(mocks.markPaymentIntentTransactionSucceeded).toHaveBeenCalledTimes(1);
  });

  it("raises no task on an identical booking that is NOT deleted", async () => {
    // The complement. Without it the suite would be satisfied by code that
    // queued a refund decision for every modification payment in the club.
    mocks.paymentFindUnique.mockResolvedValue(payment(null));

    const res = await callRoute();

    expect(res.status).toBe(200);
    expect(mocks.markPaymentIntentTransactionSucceeded).toHaveBeenCalledTimes(1);
    expect(mocks.raiseTask).not.toHaveBeenCalled();
  });

  it("selects deletedAt beside the authority field", async () => {
    mocks.paymentFindUnique.mockResolvedValue(payment(DELETED_AT));

    await callRoute();

    expect(mocks.paymentFindUnique).toHaveBeenCalledWith({
      where: { bookingId: "booking-1" },
      include: { booking: { select: { memberId: true, deletedAt: true } } },
    });
  });

  it("gives a caller with no claim 403, recording nothing and raising nothing", async () => {
    // The authorisation check still comes first. A stranger cannot use this
    // endpoint to plant a ManualRefundTask against somebody else's booking.
    mocks.auth.mockResolvedValue(STRANGER);
    mocks.paymentFindUnique.mockResolvedValue(payment(DELETED_AT));

    const res = await callRoute();

    expect(res.status).toBe(403);
    expect(mocks.markPaymentIntentTransactionSucceeded).not.toHaveBeenCalled();
    expect(mocks.raiseTask).not.toHaveBeenCalled();
  });

  it("gives that same caller the identical 403 on a booking that is NOT deleted", async () => {
    mocks.auth.mockResolvedValue(STRANGER);
    mocks.paymentFindUnique.mockResolvedValue(payment(null));

    const res = await callRoute();

    expect(res.status).toBe(403);
  });

  it("raises nothing on a replay of an already-captured transaction", async () => {
    // A second confirm of the same intent takes the already-captured early
    // return, so the task is not re-raised from here. (The helper is idempotent
    // on the intent as well, which is the belt to this braces.)
    mocks.paymentFindUnique.mockResolvedValue(payment(DELETED_AT));
    mocks.findPaymentTransactionByIntentId.mockResolvedValue({
      id: "ptx-1",
      status: "SUCCEEDED",
      amountCents: AMOUNT_CENTS,
    });

    const res = await callRoute();

    expect(res.status).toBe(200);
    expect(mocks.raiseTask).not.toHaveBeenCalled();
    expect(mocks.markPaymentIntentTransactionSucceeded).not.toHaveBeenCalled();
  });

  it("raises the task when the booking is deleted DURING the Stripe round trip", async () => {
    // THE OTHER ORDERING OF THE RACE, and the one that used to be silently
    // lost. The opening read sees a live booking; the admin's DELETE commits
    // while this handler is inside `getPaymentIntent`; by the time the capture
    // is recorded the booking is gone. Deciding from the stale value recorded
    // the money and told nobody — the exact state INV-ADDPAY-036 promises
    // cannot happen.
    mocks.paymentFindUnique.mockResolvedValue(payment(null));
    mocks.bookingFindUnique.mockResolvedValue({ deletedAt: DELETED_AT });

    const res = await callRoute();

    expect(res.status).toBe(200);
    expect(mocks.markPaymentIntentTransactionSucceeded).toHaveBeenCalledTimes(1);
    expect(mocks.raiseTask).toHaveBeenCalledTimes(1);
    expect(mocks.raiseTask).toHaveBeenCalledWith({
      bookingId: "booking-1",
      paymentId: "payment-1",
      paymentIntentId: INTENT_ID,
      amountCents: AMOUNT_CENTS,
    });
    expect(mocks.bookingFindUnique).toHaveBeenCalledWith({
      where: { id: "booking-1" },
      select: { deletedAt: true },
    });
  });

  it("re-reads the flag only after the money is recorded", async () => {
    // The re-read must not become a THIRD reason to refuse before the capture
    // is on the ledger: recording the money is unconditional, and only the
    // decision about telling a human depends on this read.
    mocks.paymentFindUnique.mockResolvedValue(payment(null));
    mocks.bookingFindUnique.mockResolvedValue({ deletedAt: DELETED_AT });

    await callRoute();

    expect(
      mocks.markPaymentIntentTransactionSucceeded.mock.invocationCallOrder[0],
    ).toBeLessThan(mocks.bookingFindUnique.mock.invocationCallOrder[0]);
  });

  it("does not re-read when the opening read already saw the deletion", async () => {
    // Nothing un-deletes a booking, so the two reads can only disagree in one
    // direction and the second query is pure cost once the first has answered.
    mocks.paymentFindUnique.mockResolvedValue(payment(DELETED_AT));

    await callRoute();

    expect(mocks.bookingFindUnique).not.toHaveBeenCalled();
    expect(mocks.raiseTask).toHaveBeenCalledTimes(1);
  });

  it("still reports success when the re-read itself fails", async () => {
    // Same reasoning as the raise: the capture is already recorded, and a 500
    // here would invite a retry that takes the already-captured early return
    // and never reaches this block again.
    mocks.paymentFindUnique.mockResolvedValue(payment(null));
    mocks.bookingFindUnique.mockRejectedValue(new Error("database is down"));

    const res = await callRoute();

    expect(res.status).toBe(200);
    expect(mocks.markPaymentIntentTransactionSucceeded).toHaveBeenCalledTimes(1);
  });

  it("raises nothing when both reads say the booking is live", async () => {
    // The complement to the re-read: it must not manufacture a task out of a
    // null.
    mocks.paymentFindUnique.mockResolvedValue(payment(null));
    mocks.bookingFindUnique.mockResolvedValue({ deletedAt: null });

    const res = await callRoute();

    expect(res.status).toBe(200);
    expect(mocks.raiseTask).not.toHaveBeenCalled();
  });

  it("raises nothing when Stripe says the intent has not succeeded", async () => {
    mocks.paymentFindUnique.mockResolvedValue(payment(DELETED_AT));
    mocks.getPaymentIntent.mockResolvedValue({
      id: INTENT_ID,
      status: "requires_payment_method",
      amount: AMOUNT_CENTS,
    });

    const res = await callRoute();

    expect(res.status).toBe(400);
    expect(mocks.raiseTask).not.toHaveBeenCalled();
    expect(mocks.markPaymentIntentTransactionSucceeded).not.toHaveBeenCalled();
  });
});
