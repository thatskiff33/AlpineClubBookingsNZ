/**
 * #4693 (`INV-PAY-120`): once an ask's recovery has ended - closed, netted off,
 * folded in or failed for good - the intents it minted and never wrote are found
 * by the row's own marker and cancelled as abandoned, on the lost hold's proof
 * and owner check. The runner-level wiring is in `payment-recovery.test.ts`, the
 * credit release's on real PostgreSQL in `credit-release-merge-into-edit.realdb.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type Intent = { id: string; amount: number; status: string; metadata: Record<string, string> };

const h = vi.hoisted(() => ({
  row: null as null | Record<string, unknown>,
  intents: [] as Intent[],
  complete: true,
  recorded: new Set<string>(),
  recoveryFind: vi.fn(),
  recoveryFindMany: vi.fn(),
  ownerOpFind: vi.fn(),
  rowFind: vi.fn(),
  editFind: vi.fn(),
  list: vi.fn(),
  cancel: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    paymentRecoveryOperation: { findUnique: h.recoveryFind, findFirst: h.ownerOpFind, findMany: h.recoveryFindMany },
    paymentTransaction: { findUnique: h.rowFind },
    bookingModification: { findUnique: h.editFind },
  },
}));
vi.mock("@/lib/stripe", () => ({ cancelPaymentIntentIfCancellableWithResult: h.cancel, listRecentPaymentIntentsMatching: h.list }));
vi.mock("@/lib/logger", () => ({ default: { info: h.info, warn: h.warn, error: h.error, debug: vi.fn() } }));

const {
  ABANDONED_ASK_SWEEP_MAX_SCANNED,
  askRecoveryIntentMarker,
  sweepAbandonedAskIntents,
  sweepAfterRunnerClose,
  sweepAskRecoveriesClosedByEdit,
} = await import("@/lib/abandoned-ask-intent-sweep");
const { ABANDONED_REISSUE_INTENT_LOG_EVENT } = await import("@/lib/reissued-ask-abandoned-intent");
const { PENDING_ASK_NETTED_BY_REDUCTION_NOTE } = await import("@/lib/additional-ask-recovery-close");
const { WAITING_REISSUE_FOLDED_BY_INCREASE_NOTE } = await import("@/lib/additional-ask-reissue");
const { buildAdditionalIntentRecoveryIdempotencyKey } = await import("@/lib/payment-recovery-keys");

const CREATED_AT = new Date("2026-06-30T20:00:00.000Z");
const ASK = { bookingId: "booking_1", type: "modification_additional" };

const ORDINARY_ROW = {
  id: "op_ordinary",
  type: "CREATE_ADDITIONAL_PAYMENT_INTENT",
  bookingId: "booking_1",
  idempotencyKey: "payment_recovery_additional_intent_mod_increase",
  status: "SUCCEEDED",
  lastError: null,
  attempts: 2,
  paymentIntentId: "pi_recorded",
  createdAt: CREATED_AT,
  payment: { stripeCustomerId: "cus_1" },
};

const stamped = (id: string, operationId = "op_ordinary", status = "requires_payment_method"): Intent => ({
  id,
  amount: 5000,
  status,
  metadata: { ...ASK, reason: "guest_add_price_increase", askRecoveryId: operationId },
});

beforeEach(() => {
  vi.clearAllMocks();
  h.row = { ...ORDINARY_ROW };
  h.intents = [];
  h.complete = true;
  h.recorded = new Set();
  h.recoveryFind.mockImplementation(async () => h.row);
  h.ownerOpFind.mockResolvedValue(null);
  h.rowFind.mockImplementation(async ({ where }: { where: { stripePaymentIntentId: string } }) =>
    h.recorded.has(where.stripePaymentIntentId) ? { id: `txn_${where.stripePaymentIntentId}` } : null,
  );
  // The real list applies `matches` to what it reads; so does this one.
  h.list.mockImplementation(async ({ matches }: { matches: (intent: Intent) => boolean }) => ({
    intents: h.intents.filter((intent) => matches(intent)),
    complete: h.complete,
  }));
  h.cancel.mockImplementation(async (id: string) => ({ paymentIntent: { id, status: "canceled" }, canceled: true }));
});

describe("askRecoveryIntentMarker - only this row's own intents", () => {
  it("MUTATION: an ordinary ask's row matches the id the runner stamped, and nothing unstamped", () => {
    const marker = askRecoveryIntentMarker(ORDINARY_ROW)!;
    expect(marker(stamped("pi_a"))).toBe(true);
    expect(marker(stamped("pi_b", "op_other_edit"))).toBe(false);
    // The door's own intent, or one minted before #4693, is never swept.
    expect(marker({ amount: 5000, metadata: { ...ASK, reason: "guest_add_price_increase" } })).toBe(false);
    expect(marker({ amount: 5000, metadata: { ...ASK, bookingId: "booking_2", askRecoveryId: "op_ordinary" } })).toBe(false);
    expect(marker({ amount: 5000, metadata: { bookingId: "booking_1", type: "booking", askRecoveryId: "op_ordinary" } })).toBe(false);
  });

  it("MUTATION: a credit release's row matches its own release id only", () => {
    const marker = askRecoveryIntentMarker({ id: "op_release", bookingId: "booking_1", idempotencyKey: "credit_release_ask_release_1" })!;
    expect(marker({ amount: 3000, metadata: { ...ASK, creditReleaseId: "release_1" } })).toBe(true);
    expect(marker({ amount: 3000, metadata: { ...ASK, creditReleaseId: "release_2" } })).toBe(false);
    expect(marker({ amount: 3000, metadata: { ...ASK, askRecoveryId: "op_release" } })).toBe(false);
  });

  it("MUTATION: a re-issue's row matches its edit's key, bare or naming the intent's own amount", () => {
    const marker = askRecoveryIntentMarker({ id: "op_reissue", bookingId: "booking_1", idempotencyKey: buildAdditionalIntentRecoveryIdempotencyKey("mod_cut") })!;
    expect(marker({ amount: 4000, metadata: { ...ASK, reissuedAskKey: "mod_reissued_ask_mod_cut" } })).toBe(true);
    expect(marker({ amount: 3500, metadata: { ...ASK, reissuedAskKey: "mod_reissued_ask_mod_cut_3500" } })).toBe(true);
    expect(marker({ amount: 3500, metadata: { ...ASK, reissuedAskKey: "mod_reissued_ask_mod_cut_4000" } })).toBe(false);
    expect(marker({ amount: 4000, metadata: { ...ASK, reissuedAskKey: "mod_reissued_ask_mod_other" } })).toBe(false);
  });

  it("a review charge's row is never swept: it can be re-armed after it closes", () => {
    expect(askRecoveryIntentMarker({ id: "op_review", bookingId: "booking_1", idempotencyKey: "edit_financial_review_additional_intent_recovery_mod_1" })).toBeNull();
  });
});

describe("sweepAbandonedAskIntents", () => {
  it("MUTATION: a closed row's unwritten intent is cancelled once as abandoned; its recorded intent and an already-cancelled one are left", async () => {
    h.intents = [stamped("pi_recorded"), stamped("pi_left_open"), stamped("pi_already", "op_ordinary", "canceled")];
    await sweepAbandonedAskIntents("op_ordinary", "runner-close");

    expect(h.list).toHaveBeenCalledWith(
      expect.objectContaining({
        createdSince: new Date(CREATED_AT.getTime() - 5 * 60 * 1000),
        customerId: "cus_1",
        maxScanned: ABANDONED_ASK_SWEEP_MAX_SCANNED,
        // #4693 review: each Stripe request is bounded - it runs in a member's edit request.
        timeoutMs: 5_000,
      }),
    );
    expect(h.cancel).toHaveBeenCalledTimes(1);
    expect(h.cancel).toHaveBeenCalledWith("pi_left_open", { cancellationReason: "abandoned", timeoutMs: 5_000 });
    expect(h.info).toHaveBeenCalledWith(
      expect.objectContaining({ event: ABANDONED_REISSUE_INTENT_LOG_EVENT, outcome: "cancelled", paymentIntentId: "pi_left_open", closedBy: "minted-elsewhere" }),
      expect.any(String),
    );
    expect(h.info).toHaveBeenCalledWith(expect.objectContaining({ outcome: "swept", complete: true, trigger: "runner-close" }), expect.any(String));
  });

  it("MUTATION (marker filter): an intent of another recovery, or with no marker, is never cancelled", async () => {
    h.intents = [stamped("pi_other_edit", "op_other_edit"), { id: "pi_door", amount: 5000, status: "requires_payment_method", metadata: { ...ASK } }];
    await sweepAbandonedAskIntents("op_ordinary", "runner-close");
    expect(h.list).toHaveBeenCalledTimes(1);
    expect(h.cancel).not.toHaveBeenCalled();
  });

  it("MUTATION (owner check): an intent a payment row or another recovery names is never cancelled", async () => {
    h.intents = [stamped("pi_on_ledger"), stamped("pi_on_recovery")];
    h.recorded.add("pi_on_ledger");
    h.ownerOpFind.mockImplementation(async ({ where }: { where: { paymentIntentId: string } }) =>
      where.paymentIntentId === "pi_on_recovery" ? { id: "op_cancel" } : null,
    );
    await sweepAbandonedAskIntents("op_ordinary", "runner-close");
    expect(h.rowFind).toHaveBeenCalledWith({ where: { stripePaymentIntentId: "pi_on_ledger" }, select: { id: true } });
    expect(h.cancel).not.toHaveBeenCalled();
    expect(h.warn).toHaveBeenCalledWith(expect.objectContaining({ outcome: "owned", paymentIntentId: "pi_on_ledger" }), expect.any(String));
    expect(h.warn).toHaveBeenCalledWith(expect.objectContaining({ outcome: "owned", paymentIntentId: "pi_on_recovery", ownerOperationId: "op_cancel" }), expect.any(String));
  });

  it.each([
    ["netted off", { lastError: PENDING_ASK_NETTED_BY_REDUCTION_NOTE, attempts: 1, paymentIntentId: "mod_guest_booking_1_mod_increase" }, "netted"],
    ["folded in", { lastError: WAITING_REISSUE_FOLDED_BY_INCREASE_NOTE, attempts: 1, paymentIntentId: "mod_guest_booking_1_mod_increase" }, "folded"],
    ["failed for good", { status: "FAILED", lastError: "out of attempts", attempts: 5, nextRetryAt: null }, "failed-for-good"],
  ])("MUTATION: a row %s has its unwritten intent cancelled", async (_label, moved, closedBy) => {
    h.row = { ...ORDINARY_ROW, ...moved };
    h.intents = [stamped("pi_left_open")];
    await sweepAbandonedAskIntents("op_ordinary", "net-off-or-fold");
    expect(h.cancel).toHaveBeenCalledWith("pi_left_open", { cancellationReason: "abandoned", timeoutMs: 5_000 });
    expect(h.info).toHaveBeenCalledWith(expect.objectContaining({ outcome: "cancelled", closedBy }), expect.any(String));
  });

  it.each([
    ["claimed (PROCESSING)", { status: "PROCESSING" }],
    ["waiting (PENDING)", { status: "PENDING", attempts: 1 }],
    ["failed with a retry left", { status: "FAILED", attempts: 3, nextRetryAt: new Date("2026-07-01T01:00:00.000Z") }],
    ["gone", null],
  ])("MUTATION: a row still %s is no proof - nothing listed, nothing cancelled", async (_label, moved) => {
    h.row = moved === null ? null : { ...ORDINARY_ROW, ...moved };
    h.intents = [stamped("pi_left_open")];
    await sweepAbandonedAskIntents("op_ordinary", "runner-close");
    expect(h.list).not.toHaveBeenCalled();
    expect(h.cancel).not.toHaveBeenCalled();
  });

  it("a review charge's row is never listed", async () => {
    h.row = { ...ORDINARY_ROW, idempotencyKey: "edit_financial_review_additional_intent_recovery_mod_1" };
    await sweepAbandonedAskIntents("op_ordinary", "runner-close");
    expect(h.list).not.toHaveBeenCalled();
  });

  it("MUTATION (complete:false): a scan that stopped early settles only what it read and never reports the row swept", async () => {
    h.intents = [stamped("pi_left_open")];
    h.complete = false;
    await sweepAbandonedAskIntents("op_ordinary", "runner-close");
    expect(h.cancel).toHaveBeenCalledWith("pi_left_open", { cancellationReason: "abandoned", timeoutMs: 5_000 });
    expect(h.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: ABANDONED_REISSUE_INTENT_LOG_EVENT, outcome: "sweep-incomplete", complete: false, sweptIntentIds: ["pi_left_open"] }),
      expect.stringContaining("an older one may stay open"),
    );
    expect(h.info).not.toHaveBeenCalledWith(expect.objectContaining({ outcome: "swept" }), expect.any(String));
  });

  it("a failed read or listing is logged and swallowed: nothing cancelled, nothing thrown", async () => {
    h.recoveryFind.mockRejectedValueOnce(new Error("connection reset"));
    await expect(sweepAbandonedAskIntents("op_ordinary", "failed-for-good")).resolves.toBeUndefined();
    h.list.mockRejectedValueOnce(new Error("Stripe is down"));
    await expect(sweepAbandonedAskIntents("op_ordinary", "failed-for-good")).resolves.toBeUndefined();
    expect(h.cancel).not.toHaveBeenCalled();
    expect(h.error).toHaveBeenCalledTimes(2);
    expect(h.error).toHaveBeenCalledWith(expect.objectContaining({ outcome: "sweep-failed", trigger: "failed-for-good" }), expect.any(String));
  });
});

describe("sweepAfterRunnerClose", () => {
  it.each([
    ["the row's first attempt", 1, "done"],
    ["an attempt put back to wait", 3, "waited"],
  ])("MUTATION: %s sweeps nothing", async (_label, attempts, outcome) => {
    await sweepAfterRunnerClose({ id: "op_ordinary", attempts, idempotencyKey: ORDINARY_ROW.idempotencyKey, paymentIntentId: "mod_guest_booking_1_mod_increase" }, outcome as "done" | "waited");
    expect(h.recoveryFind).not.toHaveBeenCalled();
  });

  it("a later attempt that ended the row sweeps it", async () => {
    h.intents = [stamped("pi_left_open")];
    await sweepAfterRunnerClose({ id: "op_ordinary", attempts: 2, idempotencyKey: ORDINARY_ROW.idempotencyKey, paymentIntentId: "pi_recorded" }, "done");
    expect(h.cancel).toHaveBeenCalledWith("pi_left_open", { cancellationReason: "abandoned", timeoutMs: 5_000 });
  });

  // #4693 review: the re-issue's door mints under the row's key before any attempt; its write
  // loses the PENDING fence once a runner claims, so the runner's FIRST attempt may close the
  // row with its own intent and leave the door's.
  it("MUTATION: a re-issue's first attempt that ends the row still naming its door's key sweeps the door's intent", async () => {
    const reissueKey = buildAdditionalIntentRecoveryIdempotencyKey("mod_cut");
    h.row = { ...ORDINARY_ROW, id: "op_reissue", idempotencyKey: reissueKey, attempts: 1, paymentIntentId: "pi_runner_y" };
    h.intents = [
      { id: "pi_door_x", amount: 3000, status: "requires_payment_method", metadata: { ...ASK, reason: "modification_reissued_ask", reissuedAskKey: "mod_reissued_ask_mod_cut" } },
    ];
    await sweepAfterRunnerClose({ id: "op_reissue", attempts: 1, idempotencyKey: reissueKey, paymentIntentId: "mod_reissued_ask_mod_cut" }, "done");
    expect(h.cancel).toHaveBeenCalledWith("pi_door_x", { cancellationReason: "abandoned", timeoutMs: 5_000 });
  });
});

describe("sweepAskRecoveriesClosedByEdit", () => {
  it("MUTATION: sweeps exactly the rows the edit's history says it netted off or folded in, once a runner had claimed them", async () => {
    h.editFind.mockResolvedValue({
      newData: { unpaidAskRetiredModificationIds: ["mod_increase", "mod_row_only"], foldedReissuedAskModificationIds: ["mod_cut"] },
    });
    h.recoveryFindMany.mockResolvedValue([
      { id: "op_ordinary", status: "SUCCEEDED", lastError: PENDING_ASK_NETTED_BY_REDUCTION_NOTE },
      { id: "op_cut", status: "SUCCEEDED", lastError: WAITING_REISSUE_FOLDED_BY_INCREASE_NOTE },
      // Closed long ago by its own runner: not this edit's to sweep.
      { id: "op_row_only", status: "SUCCEEDED", lastError: null },
    ]);
    h.row = null;
    await sweepAskRecoveriesClosedByEdit({ bookingId: "booking_1", bookingModificationId: "mod_reduction" });

    expect(h.editFind).toHaveBeenCalledWith({ where: { id: "mod_reduction" }, select: { newData: true } });
    expect(h.recoveryFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          bookingId: "booking_1",
          status: "SUCCEEDED",
          // #4693 review: or a re-issue still naming its door's key, whose door may have minted at attempts 0.
          OR: [{ attempts: { gte: 1 } }, { paymentIntentId: { in: ["mod_reissued_ask_mod_increase", "mod_reissued_ask_mod_row_only", "mod_reissued_ask_mod_cut"] } }],
          idempotencyKey: { in: ["mod_increase", "mod_row_only", "mod_cut"].map(buildAdditionalIntentRecoveryIdempotencyKey) },
        }),
      }),
    );
    expect(h.recoveryFind.mock.calls.map(([args]) => (args as { where: { id: string } }).where.id)).toEqual(["op_ordinary", "op_cut"]);
  });

  it("MUTATION (#4693 review): a re-issue netted off at attempts 0 - its door minted, then died before its write - has the door's intent swept", async () => {
    h.editFind.mockResolvedValue({ newData: { unpaidAskRetiredModificationIds: ["mod_cut"] } });
    h.recoveryFindMany.mockResolvedValue([{ id: "op_cut", status: "SUCCEEDED", lastError: PENDING_ASK_NETTED_BY_REDUCTION_NOTE }]);
    h.row = {
      ...ORDINARY_ROW, id: "op_cut", idempotencyKey: buildAdditionalIntentRecoveryIdempotencyKey("mod_cut"), attempts: 0,
      lastError: PENDING_ASK_NETTED_BY_REDUCTION_NOTE, paymentIntentId: "mod_reissued_ask_mod_cut",
    };
    h.intents = [
      { id: "pi_door_x", amount: 3000, status: "requires_payment_method", metadata: { ...ASK, reason: "modification_reissued_ask", reissuedAskKey: "mod_reissued_ask_mod_cut" } },
    ];
    await sweepAskRecoveriesClosedByEdit({ bookingId: "booking_1", bookingModificationId: "mod_reduction" });
    expect(h.cancel).toHaveBeenCalledWith("pi_door_x", { cancellationReason: "abandoned", timeoutMs: 5_000 });
  });

  it("an edit whose history names no ask reads no recovery", async () => {
    h.editFind.mockResolvedValue({ newData: { priceDiffCents: -2000 } });
    await sweepAskRecoveriesClosedByEdit({ bookingId: "booking_1", bookingModificationId: "mod_reduction" });
    expect(h.recoveryFindMany).not.toHaveBeenCalled();
  });

  it("a failed read is logged and swallowed", async () => {
    h.editFind.mockRejectedValueOnce(new Error("connection reset"));
    await expect(sweepAskRecoveriesClosedByEdit({ bookingId: "booking_1", bookingModificationId: "mod_reduction" })).resolves.toBeUndefined();
    expect(h.error).toHaveBeenCalledWith(expect.objectContaining({ outcome: "sweep-failed" }), expect.any(String));
  });
});
