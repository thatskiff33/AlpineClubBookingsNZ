/**
 * #4052: the intent a door minted for a re-issued ask whose recovery ended
 * without it mid-mint (a later reduction or increase closed it, or the runner
 * wrote another intent) is cancelled at Stripe as abandoned -
 * only on proof that nobody owns it, never written locally, safe to repeat.
 * The door-level interleavings are in `booking-modify-reduction-unpaid-ask.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  recovery: null as null | Record<string, unknown>,
  row: null as null | { id: string },
  recoveryFind: vi.fn(),
  rowFind: vi.fn(),
  ownerOpFind: vi.fn(),
  cancel: vi.fn(),
  get: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    paymentRecoveryOperation: { findUnique: h.recoveryFind, findFirst: h.ownerOpFind },
    paymentTransaction: { findUnique: h.rowFind },
  },
}));
vi.mock("@/lib/stripe", () => ({ cancelPaymentIntentIfCancellableWithResult: h.cancel, getPaymentIntent: h.get }));
vi.mock("@/lib/logger", () => ({ default: { info: h.info, warn: h.warn, error: h.error } }));

const { ABANDONED_REISSUE_INTENT_LOG_EVENT, settleLostRecoveryClaimHold, settleLostReissuedAskFence } = await import("@/lib/reissued-ask-abandoned-intent");
const { PENDING_ASK_NETTED_BY_REDUCTION_NOTE } = await import("@/lib/additional-ask-recovery-close");
const { WAITING_REISSUE_FOLDED_BY_INCREASE_NOTE } = await import("@/lib/additional-ask-reissue");

const CALL = { bookingId: "booking_1", bookingModificationId: "mod_reduction", paymentIntentId: "pi_door", stripeKey: "mod_reissued_ask_mod_reduction" };
const NETTED = {
  id: "op_reissue",
  status: "SUCCEEDED",
  lastError: PENDING_ASK_NETTED_BY_REDUCTION_NOTE,
  paymentIntentId: "mod_reissued_ask_mod_reduction",
};

beforeEach(() => {
  vi.clearAllMocks();
  h.recovery = { ...NETTED };
  h.row = null;
  h.recoveryFind.mockImplementation(async () => h.recovery);
  h.rowFind.mockImplementation(async () => h.row);
  h.ownerOpFind.mockResolvedValue(null);
  h.cancel.mockImplementation(async (id: string) => ({ paymentIntent: { id, status: "canceled" }, canceled: true }));
  h.get.mockImplementation(async (id: string) => ({ id, status: "requires_payment_method" }));
});

describe("settleLostReissuedAskFence", () => {
  it("MUTATION: cancels a proven abandoned intent as abandoned and hands back the re-read", async () => {
    await expect(settleLostReissuedAskFence(CALL)).resolves.toEqual(NETTED);
    expect(h.rowFind).toHaveBeenCalledWith({ where: { stripePaymentIntentId: "pi_door" }, select: { id: true } });
    expect(h.cancel).toHaveBeenCalledWith("pi_door", { cancellationReason: "abandoned", timeoutMs: 5_000 });
    expect(h.info).toHaveBeenCalledWith(expect.objectContaining({ canceled: true, paymentIntentId: "pi_door" }), expect.any(String));
  });

  it("repeated cleanup is safe: an intent already cancelled is left alone, not reported cancelled", async () => {
    await settleLostReissuedAskFence(CALL);
    h.cancel.mockResolvedValueOnce({ paymentIntent: { id: "pi_door", status: "canceled" }, canceled: false });
    await settleLostReissuedAskFence(CALL);
    expect(h.cancel).toHaveBeenCalledTimes(2);
    expect(h.info.mock.calls.filter(([context]) => (context as { outcome?: string }).outcome === "cancelled")).toHaveLength(1);
    // #4693 (review of PR #4698): already cancelled - by another settle or sweep - is not a refusal.
    expect(h.info).toHaveBeenCalledWith(expect.objectContaining({ outcome: "already-cancelled", intentStatus: "canceled" }), expect.any(String));
    expect(h.warn).not.toHaveBeenCalled();
  });

  it("MUTATION (#4693 review): a cancel refused because another settle or sweep cancelled it first is read back and logged already-cancelled, never cancel-failed", async () => {
    h.cancel.mockRejectedValueOnce(Object.assign(new Error("This PaymentIntent's status is canceled"), { code: "payment_intent_unexpected_state" }));
    h.get.mockResolvedValueOnce({ id: "pi_door", status: "canceled" });
    await settleLostReissuedAskFence(CALL);
    expect(h.get).toHaveBeenCalledWith("pi_door", { timeoutMs: 5_000 });
    expect(h.info).toHaveBeenCalledWith(expect.objectContaining({ outcome: "already-cancelled", paymentIntentId: "pi_door" }), expect.any(String));
    expect(h.error).not.toHaveBeenCalled();
  });

  it("a cancel that fails while the intent still reads open, or whose read-back fails, is cancel-failed", async () => {
    h.cancel.mockRejectedValueOnce(new Error("Stripe is down"));
    await settleLostReissuedAskFence(CALL);
    h.cancel.mockRejectedValueOnce(new Error("Stripe is down"));
    h.get.mockRejectedValueOnce(new Error("timed out"));
    await settleLostReissuedAskFence(CALL);
    expect(h.error.mock.calls.map(([context]) => (context as { outcome?: string }).outcome)).toEqual(["cancel-failed", "cancel-failed"]);
  });

  it("a recovery re-read that fails proves nothing: null back, nothing cancelled", async () => {
    h.recoveryFind.mockRejectedValueOnce(new Error("connection reset"));
    await expect(settleLostReissuedAskFence(CALL)).resolves.toBeNull();
    expect(h.cancel).not.toHaveBeenCalled();
  });

  it("a payment-row check that fails proves nothing: nothing cancelled", async () => {
    h.rowFind.mockRejectedValueOnce(new Error("connection reset"));
    await settleLostReissuedAskFence(CALL);
    expect(h.cancel).not.toHaveBeenCalled();
    expect(h.error).toHaveBeenCalledTimes(1);
  });

  it("MUTATION: a recovery carrying this intent's own id (a runner wrote it) is never cancelled", async () => {
    h.recovery = { ...NETTED, paymentIntentId: "pi_door" };
    await settleLostReissuedAskFence(CALL);
    expect(h.rowFind).not.toHaveBeenCalled();
    expect(h.cancel).not.toHaveBeenCalled();
  });

  // #4052 review (F1): the runner can mint under an amount-suffixed key
  // (`planReissuedAskMint`) and write that intent instead of the door's.
  it("MUTATION: a recovery the runner completed with ANOTHER intent leaves the door's abandoned - cancelled", async () => {
    h.recovery = { id: "op_reissue", status: "SUCCEEDED", lastError: null, paymentIntentId: "pi_runner_suffixed_key" };
    await settleLostReissuedAskFence(CALL);
    expect(h.ownerOpFind).toHaveBeenCalledWith({ where: { paymentIntentId: "pi_door" }, select: { id: true } });
    expect(h.cancel).toHaveBeenCalledWith("pi_door", { cancellationReason: "abandoned", timeoutMs: 5_000 });
  });

  // Delta review: the runner's locked write repoints the recovery at the intent
  // it wrote, then stays PROCESSING through its Stripe cancels and invoice steps.
  it("MUTATION: a recovery the runner still holds, already repointed at ANOTHER intent, leaves the door's abandoned - cancelled", async () => {
    h.recovery = { id: "op_reissue", status: "PROCESSING", lastError: null, paymentIntentId: "pi_runner_suffixed_key" };
    await settleLostReissuedAskFence(CALL);
    expect(h.cancel).toHaveBeenCalledWith("pi_door", { cancellationReason: "abandoned", timeoutMs: 5_000 });
  });

  it.each([
    ["claimed by the runner (PROCESSING), still naming the key", { status: "PROCESSING", lastError: null, paymentIntentId: "mod_reissued_ask_mod_reduction" }],
    ["claimed by the runner (PROCESSING), which wrote the door's own intent", { status: "PROCESSING", lastError: null, paymentIntentId: "pi_door" }],
    // #4693: a FAILED row with attempts left is no proof; one failed for good is (below).
    ["failed with a retry left", { status: "FAILED", lastError: "Stripe is down", attempts: 2, paymentIntentId: "mod_reissued_ask_mod_reduction" }],
    ["still waiting", { status: "PENDING", lastError: null, paymentIntentId: "mod_reissued_ask_mod_reduction" }],
  ])("MUTATION: a recovery %s is never a proof - nothing cancelled", async (_label, moved) => {
    h.recovery = { id: "op_reissue", ...moved };
    await settleLostReissuedAskFence(CALL);
    expect(h.cancel).not.toHaveBeenCalled();
  });

  // #4693: no claim takes a row failed for good again, the door writes only a PENDING one, and
  // no reduction nets it off - so nobody records an intent under its key again.
  it("MUTATION: a recovery failed for good (its attempts spent) leaves the door's abandoned - cancelled", async () => {
    h.recovery = { id: "op_reissue", status: "FAILED", lastError: "out of attempts", attempts: 5, paymentIntentId: "mod_reissued_ask_mod_reduction" };
    await settleLostReissuedAskFence(CALL);
    expect(h.cancel).toHaveBeenCalledWith("pi_door", { cancellationReason: "abandoned", timeoutMs: 5_000 });
    expect(h.info).toHaveBeenCalledWith(expect.objectContaining({ outcome: "cancelled", closedBy: "failed-for-good" }), expect.any(String));
  });

  it("MUTATION: an intent another recovery names (a queued cancel, a refund) is left to it", async () => {
    h.ownerOpFind.mockResolvedValueOnce({ id: "op_other" });
    await settleLostReissuedAskFence(CALL);
    expect(h.cancel).not.toHaveBeenCalled();
  });

  it("logs every outcome under one searchable event, the failure included", async () => {
    h.cancel.mockRejectedValueOnce(new Error("Stripe is down"));
    await settleLostReissuedAskFence(CALL);
    expect(h.error).toHaveBeenCalledWith(
      expect.objectContaining({ event: ABANDONED_REISSUE_INTENT_LOG_EVENT, outcome: "cancel-failed", paymentIntentId: "pi_door" }),
      expect.any(String),
    );
    expect(ABANDONED_REISSUE_INTENT_LOG_EVENT).toBe("reissued-ask.abandoned-intent-cleanup");
  });

  it("a recovery that is gone proves nothing", async () => {
    h.recovery = null;
    await expect(settleLostReissuedAskFence(CALL)).resolves.toBeNull();
    expect(h.cancel).not.toHaveBeenCalled();
  });
});

/**
 * #4631: the runner's side - its claim hold lost, so the intent it minted is
 * written nowhere. The same proof and cancel as the door's; the runner-level
 * interleavings (after the hold's transaction, never inside one) are in
 * `payment-recovery.test.ts`, and the real-PostgreSQL ones in
 * `additional-ask-reduction.realdb.test.ts`.
 */
describe("settleLostRecoveryClaimHold (#4631, #4652)", () => {
  const RUNNER = { operationId: "op_recovery", bookingId: "booking_1", paymentIntentId: "pi_runner", adopted: false };
  /** The Stripe key the recovery names until a hold writes an intent over it. */
  const KEY = "credit_release_ask_pi_release_1";

  beforeEach(() => {
    h.recovery = { status: "SUCCEEDED", lastError: PENDING_ASK_NETTED_BY_REDUCTION_NOTE, paymentIntentId: KEY };
  });

  it.each([
    ["netted off by a reduction", PENDING_ASK_NETTED_BY_REDUCTION_NOTE, KEY, "netted"],
    ["folded in by an increase", WAITING_REISSUE_FOLDED_BY_INCREASE_NOTE, KEY, "folded"],
    // #4652: a stale reclaim - the runner that took the claim over wrote another intent
    // (an amount-suffixed key), or closed the row without one, and nothing reopens it.
    ["closed by a reclaiming runner with ANOTHER intent", null, "pi_reclaimer", "minted-elsewhere"],
    ["closed by a reclaiming runner with no intent", null, KEY, "minted-elsewhere"],
    // #4693: failed for good - no claim, door or reduction takes the row again.
    ["failed for good (its attempts spent)", "out of attempts", KEY, "failed-for-good"],
  ])("MUTATION: a recovery %s has the runner's unwritten intent cancelled as abandoned", async (_label, lastError, paymentIntentId, closedBy) => {
    h.recovery =
      closedBy === "failed-for-good"
        ? { status: "FAILED", lastError, paymentIntentId, attempts: 5, nextRetryAt: null }
        : { status: "SUCCEEDED", lastError, paymentIntentId, attempts: 2 };
    await settleLostRecoveryClaimHold(RUNNER);
    expect(h.recoveryFind).toHaveBeenCalledWith({ where: { id: "op_recovery" }, select: { status: true, lastError: true, paymentIntentId: true, attempts: true } });
    expect(h.rowFind).toHaveBeenCalledWith({ where: { stripePaymentIntentId: "pi_runner" }, select: { id: true } });
    expect(h.ownerOpFind).toHaveBeenCalledWith({ where: { paymentIntentId: "pi_runner" }, select: { id: true } });
    expect(h.cancel).toHaveBeenCalledWith("pi_runner", { cancellationReason: "abandoned", timeoutMs: 5_000 });
    expect(h.info).toHaveBeenCalledWith(
      expect.objectContaining({ event: ABANDONED_REISSUE_INTENT_LOG_EVENT, outcome: "cancelled", operationId: "op_recovery", closedBy }),
      expect.any(String),
    );
  });

  it("MUTATION: an intent a payment row names is never cancelled", async () => {
    h.row = { id: "txn_recorded" };
    await settleLostRecoveryClaimHold(RUNNER);
    expect(h.cancel).not.toHaveBeenCalled();
    // Review (F3): the runner's own recovery id survives beside the owner's.
    expect(h.warn).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "owned", paymentTransactionId: "txn_recorded", operationId: "op_recovery", ownerOperationId: undefined }),
      expect.any(String),
    );
  });

  it("MUTATION: an intent a recovery names (its own, another's, a queued cancel) is never cancelled", async () => {
    h.ownerOpFind.mockResolvedValueOnce({ id: "op_other" });
    await settleLostRecoveryClaimHold(RUNNER);
    expect(h.cancel).not.toHaveBeenCalled();
    expect(h.warn).toHaveBeenCalledWith(expect.objectContaining({ outcome: "owned", operationId: "op_recovery", ownerOperationId: "op_other" }), expect.any(String));
  });

  it.each([
    ["reset for retry (PENDING)", { status: "PENDING", lastError: null, paymentIntentId: KEY }],
    ["reclaimed by another runner (PROCESSING)", { status: "PROCESSING", lastError: null, paymentIntentId: KEY }],
    // #4652: a stated limit - a live claim, and a later run of it may still mint under this key.
    ["reclaimed by a runner that already wrote ANOTHER intent (PROCESSING)", { status: "PROCESSING", lastError: null, paymentIntentId: "pi_reclaimer" }],
    ["completed naming THIS intent (the reclaiming runner wrote it)", { status: "SUCCEEDED", lastError: null, paymentIntentId: "pi_runner" }],
    // #4693: a FAILED row with attempts left will run again, so it is no proof; only one failed for good is.
    ["failed with a retry left", { status: "FAILED", lastError: "Stripe is down", paymentIntentId: KEY, attempts: 4, nextRetryAt: new Date("2026-07-01T01:00:00.000Z") }],
    ["failed after writing ANOTHER intent, with a retry left", { status: "FAILED", lastError: "Xero is down", paymentIntentId: "pi_reclaimer", attempts: 2, nextRetryAt: new Date("2026-07-01T01:00:00.000Z") }],
    ["failed for good naming THIS intent", { status: "FAILED", lastError: "out of attempts", paymentIntentId: "pi_runner", attempts: 5, nextRetryAt: null }],
    ["gone", null],
  ])("MUTATION: a recovery %s is never a proof - nothing cancelled", async (_label, moved) => {
    h.recovery = moved;
    await settleLostRecoveryClaimHold(RUNNER);
    expect(h.rowFind).not.toHaveBeenCalled();
    expect(h.cancel).not.toHaveBeenCalled();
    expect(h.warn).toHaveBeenCalledTimes(1);
  });

  // Review (F2): an intent the runner found by matching (#4036) is not its own.
  it.each([
    ["netted off", PENDING_ASK_NETTED_BY_REDUCTION_NOTE, KEY],
    ["folded in", WAITING_REISSUE_FOLDED_BY_INCREASE_NOTE, KEY],
    ["closed by a reclaiming runner with another intent", null, "pi_reclaimer"],
  ])("MUTATION: an ADOPTED intent is never cancelled, even with its recovery %s", async (_label, lastError, paymentIntentId) => {
    h.recovery = { status: "SUCCEEDED", lastError, paymentIntentId };
    await settleLostRecoveryClaimHold({ ...RUNNER, adopted: true });
    expect(h.rowFind).not.toHaveBeenCalled();
    expect(h.cancel).not.toHaveBeenCalled();
    expect(h.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: ABANDONED_REISSUE_INTENT_LOG_EVENT, outcome: "adopted", operationId: "op_recovery", paymentIntentId: "pi_runner" }),
      expect.any(String),
    );
  });

  // #4652: the interleaving - a writer records the intent after the proof's re-read and
  // before the owner check; the owner check sees it, and the cancel never reaches it.
  it("MUTATION: a writer recording the intent between the proof's re-read and the owner check wins - nothing cancelled", async () => {
    h.recovery = { status: "SUCCEEDED", lastError: null, paymentIntentId: "pi_reclaimer" };
    h.recoveryFind.mockImplementationOnce(async () => {
      const read = h.recovery;
      h.row = { id: "txn_written_meanwhile" };
      return read;
    });
    await settleLostRecoveryClaimHold(RUNNER);
    expect(h.rowFind).toHaveBeenCalledWith({ where: { stripePaymentIntentId: "pi_runner" }, select: { id: true } });
    expect(h.cancel).not.toHaveBeenCalled();
    expect(h.warn).toHaveBeenCalledWith(expect.objectContaining({ outcome: "owned", paymentTransactionId: "txn_written_meanwhile" }), expect.any(String));
  });

  it("a recovery re-read that fails proves nothing: logged, nothing cancelled, nothing thrown", async () => {
    h.recoveryFind.mockRejectedValueOnce(new Error("connection reset"));
    await expect(settleLostRecoveryClaimHold(RUNNER)).resolves.toBeUndefined();
    expect(h.cancel).not.toHaveBeenCalled();
    expect(h.error).toHaveBeenCalledWith(expect.objectContaining({ outcome: "unread", operationId: "op_recovery" }), expect.any(String));
  });

  it("a Stripe cancel that fails is logged and swallowed: best-effort", async () => {
    h.cancel.mockRejectedValueOnce(new Error("Stripe is down"));
    await expect(settleLostRecoveryClaimHold(RUNNER)).resolves.toBeUndefined();
    expect(h.error).toHaveBeenCalledWith(
      expect.objectContaining({ event: ABANDONED_REISSUE_INTENT_LOG_EVENT, outcome: "cancel-failed", paymentIntentId: "pi_runner" }),
      expect.any(String),
    );
  });

  it("repeated: an intent Stripe already cancelled is left alone, not reported cancelled", async () => {
    h.cancel.mockResolvedValueOnce({ paymentIntent: { id: "pi_runner", status: "canceled" }, canceled: false });
    await settleLostRecoveryClaimHold(RUNNER);
    // #4693 review: already cancelled is no refusal; never reported as cancelled.
    expect(h.info).not.toHaveBeenCalledWith(expect.objectContaining({ outcome: "cancelled" }), expect.any(String));
    expect(h.info).toHaveBeenCalledWith(expect.objectContaining({ outcome: "already-cancelled", intentStatus: "canceled" }), expect.any(String));
  });

  it("an intent Stripe will not cancel for another reason (captured) is still uncancellable", async () => {
    h.cancel.mockResolvedValueOnce({ paymentIntent: { id: "pi_runner", status: "succeeded" }, canceled: false });
    await settleLostRecoveryClaimHold(RUNNER);
    expect(h.warn).toHaveBeenCalledWith(expect.objectContaining({ outcome: "uncancellable", intentStatus: "succeeded" }), expect.any(String));
  });
});
