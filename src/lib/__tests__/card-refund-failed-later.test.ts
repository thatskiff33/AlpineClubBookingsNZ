// #4104 (`INV-PAY-128`): a card refund Stripe accepted and failed later is owed
// again, by one row. These are the rules of `keepFailedLaterCardRefundOwed`
// against a fake transaction: whose refund it is, which row owes it, when a row
// is left alone, the retry's generation, the cutoff, and the alert after
// commit. The real-database proof is `card-refund-failed-later.realdb.test.ts`.
import { beforeEach, describe, expect, it, vi } from "vitest";

const alertPaymentRecoveryOfficers = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<undefined>>(async () => undefined));
vi.mock("@/lib/payment-recovery-alert", () => ({ alertPaymentRecoveryOfficers }));
vi.mock("@/lib/club-format-server", async () => ({
  clubFormatValues: async () => (await import("./support/club-format-fixture")).CLUB_FORMAT_TEST,
}));

import { lastErrorSuggestsStripeMayHaveRefunded } from "@/lib/card-refund-paid-another-way";
import {
  alertFailedLaterCardRefunds,
  FailedLaterRefundHeldError,
  keepFailedLaterCardRefundOwed,
  keepFailedLaterCardRefundsOwed,
  type FailedLaterCardRefundDebt,
  type FailedLaterKind,
  type FailedLaterRefundInput,
} from "@/lib/card-refund-failed-later";
import { MAX_PAYMENT_RECOVERY_ATTEMPTS } from "@/lib/payment-recovery-constants";
import { bookingModificationRefundReasonForKeyPrefix, SUPERSEDED_PAYMENT_REFUND_METADATA_REASON } from "@/lib/payment-recovery-keys";

const RAISED_AT = new Date("2026-06-20T00:00:00.000Z");
const REFUNDED_AT = new Date("2026-06-20T00:00:05.000Z");

type Row = {
  id: string;
  type: string;
  status: string;
  attempts: number;
  nextRetryAt: Date | null;
  idempotencyKey: string;
  stripeKeyPrefix: string | null;
  amountCents: number;
  allocationPlan: unknown;
  paymentTransactionId: string | null;
  bookingId: string;
  paymentIntentId: string;
  createdAt: Date;
  succeededAt: Date | null;
};

function row(over: Partial<Row> = {}): Row {
  return {
    id: "op-open",
    type: "REFUND_BOOKING_MODIFICATION",
    status: "FAILED",
    attempts: 1,
    nextRetryAt: new Date("2026-06-20T00:10:00.000Z"),
    idempotencyKey: "payment_recovery_modification_refund_mod-1",
    stripeKeyPrefix: null,
    amountCents: 4_000,
    allocationPlan: [{ paymentTransactionId: "txn-1", amountCents: 4_000 }],
    paymentTransactionId: null,
    bookingId: "booking-1",
    paymentIntentId: "pi_open",
    createdAt: RAISED_AT,
    succeededAt: null,
    ...over,
  };
}

function fakeTx({
  rows = [] as Row[],
  inserted = 1,
  moved = 1,
  transactionIntent = "pi_txn" as string | null,
  cutoff = null as Date | null,
  recordedStatus = "failed",
} = {}) {
  return {
    $queryRaw: vi.fn(async (strings: TemplateStringsArray) =>
      strings.join("?").includes("to_regclass") ? [{ present: true }] : cutoff ? [{ finished_at: cutoff }] : [],
    ),
    payment: {
      findUnique: vi.fn(async () => ({ id: "pay-1", bookingId: "booking-1", status: "PARTIALLY_REFUNDED", amountCents: 20_000, refundedAmountCents: 0 })),
    },
    paymentRefund: {
      findMany: vi.fn(async () => [
        { stripeRefundId: "re_1", paymentTransactionId: "txn-1", amountCents: 4_000, status: recordedStatus, createdAt: REFUNDED_AT, stripeCreatedAt: REFUNDED_AT },
      ]),
    },
    paymentTransaction: { findUnique: vi.fn(async () => ({ stripePaymentIntentId: transactionIntent })) },
    auditLog: { create: vi.fn<(args: unknown) => Promise<object>>(async () => ({})) },
    manualRefundTask: { findFirst: vi.fn<(args: unknown) => Promise<Record<string, unknown> | null>>(async () => null) },
    paymentRecoveryOperation: {
      findMany: vi.fn(async () => rows),
      createMany: vi.fn<(args: unknown) => Promise<{ count: number }>>(async () => ({ count: inserted })),
      updateMany: vi.fn<(args: unknown) => Promise<{ count: number }>>(async () => ({ count: moved })),
      findUniqueOrThrow: vi.fn(async () => ({ id: "op-new" })),
    },
  };
}

const REFUND: FailedLaterRefundInput = {
  id: "re_1",
  amount: 4_000,
  status: "failed",
  created: Math.floor(REFUNDED_AT.getTime() / 1000),
  metadata: { bookingId: "booking-1", reason: "cancellation" },
};

const keep = (
  tx: ReturnType<typeof fakeTx>,
  refund: FailedLaterRefundInput = REFUND,
  { kind = "transition" as FailedLaterKind, paymentIntentId = "pi_1" as string | null, cutoffSeconds = null as number | null } = {},
) => keepFailedLaterCardRefundOwed(tx as never, { paymentId: "pay-1", paymentTransactionId: "txn-1", refund, kind, paymentIntentId, cutoffSeconds });

const inserted = (tx: ReturnType<typeof fakeTx>) =>
  (tx.paymentRecoveryOperation.createMany.mock.calls[0]?.[0] as { data: Array<Record<string, unknown>> } | undefined)?.data[0];
const replan = (tx: ReturnType<typeof fakeTx>) =>
  tx.paymentRecoveryOperation.updateMany.mock.calls[0]?.[0] as { where: Record<string, unknown>; data: Record<string, unknown> } | undefined;

beforeEach(() => alertPaymentRecoveryOfficers.mockClear());

describe("with no row that counted it, one new row owes it", () => {
  it.each([
    ["the cancellation's", { bookingId: "booking-1", reason: "cancellation" }],
    ["an edit's", { bookingId: "booking-1", reason: "date_change_price_decrease" }],
    ["an approved refund request's", { bookingId: "booking-1", reason: "refund_appeal_approved", refundRequestId: "rr-1" }],
    ["the runner's", { bookingId: "booking-1", reason: "booking_modification_refund_recovery" }],
  ])("%s refund, made for this booking, raises one row for exactly that refund", async (_door, metadata) => {
    const tx = fakeTx();
    expect(await keep(tx, { ...REFUND, metadata })).toEqual({
      debt: { outcome: "raised", operationId: "op-new", bookingId: "booking-1", paymentIntentId: "pi_1", amountCents: 4_000, stripeRefundId: "re_1" },
    });
    expect(inserted(tx)).toMatchObject({
      type: "REFUND_BOOKING_MODIFICATION",
      status: "PENDING",
      bookingId: "booking-1",
      paymentId: "pay-1",
      paymentIntentId: "pi_1",
      amountCents: 4_000,
      idempotencyKey: "card_refund_failed_later_re_1",
      // Its own key is the Stripe prefix: a request Stripe has never seen.
      stripeKeyPrefix: "card_refund_failed_later_re_1",
      allocationPlan: [{ paymentTransactionId: "txn-1", amountCents: 4_000 }],
      attempts: 0,
    });
  });

  it("a closed row that counted it is never reopened: a new row owes it", async () => {
    const tx = fakeTx({ rows: [row({ status: "SUCCEEDED", succeededAt: new Date("2026-06-20T00:00:10.000Z") })] });
    expect(await keep(tx)).toMatchObject({ debt: { outcome: "raised" } });
    expect(tx.paymentRecoveryOperation.updateMany).not.toHaveBeenCalled();
  });

  it("takes the charge's own intent when the refund names none, and raises nothing for a charge with none", async () => {
    expect(await keep(fakeTx({ transactionIntent: "pi_txn" }), REFUND, { paymentIntentId: null })).toMatchObject({ debt: { paymentIntentId: "pi_txn" } });
    const none = fakeTx({ transactionIntent: null });
    expect(await keep(none, REFUND, { paymentIntentId: null })).toEqual({});
    expect(none.paymentRecoveryOperation.createMany).not.toHaveBeenCalled();
  });

  it("a second writer seeing the same refund writes nothing more", async () => {
    expect(await keep(fakeTx({ inserted: 0 }))).toEqual({});
  });
});

describe("never re-sent automatically", () => {
  it("a retry that fails later too is raised dead - attempts spent, never claimed - for Paid another way", async () => {
    const tx = fakeTx();
    const retry = { ...REFUND, id: "re_retry", metadata: { bookingId: "booking-1", reason: bookingModificationRefundReasonForKeyPrefix("card_refund_failed_later_re_1") } };
    expect(await keep(tx, retry)).toMatchObject({ debt: { outcome: "raised-dead" } });
    expect(inserted(tx)).toMatchObject({ idempotencyKey: "card_refund_failed_later_re_retry", attempts: MAX_PAYMENT_RECOVERY_ATTEMPTS });
    // Stripe sent nothing: the dead row carries no "Stripe may have refunded" warning.
    expect(lastErrorSuggestsStripeMayHaveRefunded(String(inserted(tx)?.lastError))).toBe(false);
  });

  it("MUTATION (ops 8): a refund Stripe created before the cutoff is raised dead; one created at or after it, live", async () => {
    const created = REFUND.created as number;
    const before = fakeTx();
    expect(await keep(before, REFUND, { cutoffSeconds: created + 1 })).toMatchObject({ debt: { outcome: "raised-backlog" } });
    expect(inserted(before)).toMatchObject({ attempts: MAX_PAYMENT_RECOVERY_ATTEMPTS });
    expect(lastErrorSuggestsStripeMayHaveRefunded(String(inserted(before)?.lastError))).toBe(false);
    const at = fakeTx();
    expect(await keep(at, REFUND, { cutoffSeconds: created })).toMatchObject({ debt: { outcome: "raised" } });
    expect(inserted(at)).toMatchObject({ attempts: 0 });
    expect(await keep(fakeTx(), REFUND, { cutoffSeconds: null })).toMatchObject({ debt: { outcome: "raised" } });
  });

  it("MUTATION (ML3): with a migration history but no finished cutoff, every refund is raised dead, never re-sent", async () => {
    const tx = fakeTx({ cutoff: null });
    const decided = await keepFailedLaterCardRefundsOwed(tx as never, {
      paymentId: "pay-1",
      paymentTransactionId: "txn-1",
      seen: [{ refund: REFUND, kind: "transition" }],
    });
    expect(decided.debts.map((debt) => debt.outcome)).toEqual(["raised-backlog"]);
  });

  it("with no migration history at all (a `db push` database) nothing is backlog", async () => {
    const tx = fakeTx();
    tx.$queryRaw.mockImplementation(async () => [{ present: false }]);
    const decided = await keepFailedLaterCardRefundsOwed(tx as never, {
      paymentId: "pay-1",
      paymentTransactionId: "txn-1",
      seen: [{ refund: REFUND, kind: "transition" }],
    });
    expect(decided.debts.map((debt) => debt.outcome)).toEqual(["raised"]);
  });

  it("reads the cutoff from the marker migration's finish, once per write, in whole seconds", async () => {
    const tx = fakeTx({ cutoff: new Date(REFUNDED_AT.getTime() + 1_500) });
    const decided = await keepFailedLaterCardRefundsOwed(tx as never, {
      paymentId: "pay-1",
      paymentTransactionId: "txn-1",
      seen: [{ refund: REFUND, kind: "transition" }, { refund: { ...REFUND, id: "re_2" }, kind: "transition" }],
    });
    expect(decided.debts.map((debt) => debt.outcome)).toEqual(["raised-backlog", "raised-backlog"]);
    expect(String(tx.$queryRaw.mock.calls[1]?.[0]?.join("?"))).toContain("_prisma_migrations");
    expect(tx.$queryRaw.mock.calls[1]?.slice(1)).toEqual(["20261115010000_card_refund_failed_later_cutoff"]);
    expect(tx.$queryRaw).toHaveBeenCalledTimes(2);
  });
});

describe("not the club's refund for this booking: alerted, never re-sent", () => {
  it.each([
    ["names no booking (made by hand in the Stripe dashboard, or a legacy group refund)", null],
    ["names another booking", { bookingId: "booking-2", reason: "cancellation" }],
  ])("one that %s", async (_case, metadata) => {
    const tx = fakeTx();
    expect(await keep(tx, { ...REFUND, metadata })).toEqual({
      debt: { outcome: "not-resent", operationId: null, bookingId: "booking-1", paymentIntentId: "pi_1", amountCents: 4_000, stripeRefundId: "re_1" },
    });
    expect(tx.paymentRecoveryOperation.createMany).not.toHaveBeenCalled();
    expect(tx.paymentRecoveryOperation.updateMany).not.toHaveBeenCalled();
    // #4104 review (CL3): the audit log keeps it, on the ledger writer's transaction.
    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);
    expect(tx.auditLog.create.mock.calls[0]?.[0]).toMatchObject({
      data: { action: "booking-payment.card-refund.failed-later-not-resent", entityType: "PaymentRefund", entityId: "re_1", targetId: "booking-1", category: "payment" },
    });
    // Seen again by a replay, it is not alerted or recorded twice.
    const replay = fakeTx();
    expect(await keep(replay, { ...REFUND, metadata }, { kind: "replayed" })).toEqual({});
    expect(replay.auditLog.create).not.toHaveBeenCalled();
  });
});

describe("already owed: a second observer writes nothing (concurrency A)", () => {
  it("a row of its own", async () => {
    const tx = fakeTx({ rows: [row({ idempotencyKey: "card_refund_failed_later_re_1", status: "PENDING", attempts: 0 })] });
    expect(await keep(tx)).toEqual({});
    expect(tx.paymentRecoveryOperation.createMany).not.toHaveBeenCalled();
  });

  it("MUTATION: an open row whose slice already records this failure", async () => {
    const plan = [{ paymentTransactionId: "txn-1", amountCents: 4_000, stripeKeySuffix: "refused1", failedRefundIds: ["re_1"] }];
    const tx = fakeTx({ rows: [row({ allocationPlan: plan })] });
    expect(await keep(tx)).toEqual({});
    expect(tx.paymentRecoveryOperation.createMany).not.toHaveBeenCalled();
    expect(tx.paymentRecoveryOperation.updateMany).not.toHaveBeenCalled();
  });
});

describe("an open row that counted it as made owes it again (money 1)", () => {
  const marked = [
    { paymentTransactionId: "txn-1", amountCents: 4_000, madeRefundId: "re_1" },
    { paymentTransactionId: "txn-2", amountCents: 1_000, stripeKeySuffix: "refused1" },
  ];

  it("a slice marked with it: moved to its next key, recording the failure, and no second row", async () => {
    const tx = fakeTx({ rows: [row({ allocationPlan: marked, amountCents: 5_000 })] });
    expect(await keep(tx)).toMatchObject({ debt: { outcome: "re-planned", operationId: "op-open", amountCents: 4_000 } });
    expect(tx.paymentRecoveryOperation.createMany).not.toHaveBeenCalled();
    // #4104 review (CL2): fenced on everything the plan and the outcome were read from.
    expect(replan(tx)?.where).toEqual({
      id: "op-open",
      status: "FAILED",
      attempts: 1,
      nextRetryAt: new Date("2026-06-20T00:10:00.000Z"),
      allocationPlan: { equals: marked },
    });
    expect(replan(tx)?.data.allocationPlan).toEqual([
      { paymentTransactionId: "txn-1", amountCents: 4_000, stripeKeySuffix: "refused1", failedRefundIds: ["re_1"] },
      marked[1],
    ]);
  });

  // The metadata this row's runner sends (`cardRefundOperationRefundMetadata`).
  const RUNNERS = { ...REFUND, metadata: { bookingId: "booking-1", reason: "booking_modification_refund_recovery" } };

  it("MUTATION: an UNMARKED slice the owed figure fills with it, as the payment stood before the failure", async () => {
    const tx = fakeTx({ rows: [row()] });
    expect(await keep(tx, RUNNERS)).toMatchObject({ debt: { outcome: "re-planned", operationId: "op-open" } });
    expect(tx.paymentRecoveryOperation.createMany).not.toHaveBeenCalled();
    expect(replan(tx)?.data.allocationPlan).toEqual([
      { paymentTransactionId: "txn-1", amountCents: 4_000, stripeKeySuffix: "refused1", failedRefundIds: ["re_1"] },
    ]);
  });

  it("an unmarked slice of another amount, or raised after the refund, is not its owner", async () => {
    expect(await keep(fakeTx({ rows: [row({ allocationPlan: [{ paymentTransactionId: "txn-1", amountCents: 3_999 }] })] }), RUNNERS)).toMatchObject({
      debt: { outcome: "raised" },
    });
    expect(await keep(fakeTx({ rows: [row({ createdAt: new Date("2026-06-21T00:00:00.000Z") })] }), RUNNERS)).toMatchObject({ debt: { outcome: "raised" } });
  });

  it("MUTATION (CM): an unmarked slice is not its owner when the refund is not what that row's runner sends", async () => {
    // A cancellation's refund matched by amount to an edit row's unsent slice:
    // the runner sends that slice anyway, so the cancellation's refund needs a row of its own.
    const tx = fakeTx({ rows: [row()] });
    expect(await keep(tx)).toMatchObject({ debt: { outcome: "raised", operationId: "op-new" } });
    expect(tx.paymentRecoveryOperation.updateMany).not.toHaveBeenCalled();
  });

  it.each([
    ["FAILED, its attempts spent", { attempts: MAX_PAYMENT_RECOVERY_ATTEMPTS, nextRetryAt: null }],
    ["PENDING, its attempts spent (raised dead)", { status: "PENDING", attempts: MAX_PAYMENT_RECOVERY_ATTEMPTS }],
  ])("MUTATION (CL4): on a dead row (%s) it is moved, and said to be not asked for again (money 6)", async (_case, over) => {
    const tx = fakeTx({ rows: [row(over)] });
    expect(await keep(tx, RUNNERS)).toMatchObject({ debt: { outcome: "re-planned-dead" } });
    expect(String(replan(tx)?.data.lastError)).toMatch(/retries are already spent, so it is not asked for again automatically: pay the member another way and close it under "Card refunds Stripe gave up on"/);
  });

  it("on a row the runner will claim again it is moved, and said to be asked for again", async () => {
    const tx = fakeTx({ rows: [row({ attempts: MAX_PAYMENT_RECOVERY_ATTEMPTS - 1 })] });
    expect(await keep(tx, RUNNERS)).toMatchObject({ debt: { outcome: "re-planned" } });
    expect(String(replan(tx)?.data.lastError)).toMatch(/is asked for again as a new request/);
  });

  it("a plan that moved since it was read is not overwritten", async () => {
    await expect(keep(fakeTx({ rows: [row()], moved: 0 }), RUNNERS)).rejects.toBeInstanceOf(FailedLaterRefundHeldError);
  });

  it.each([
    ["a worker holds (PROCESSING)", { status: "PROCESSING" }],
    ["no worker has claimed yet (PENDING, no attempt)", { status: "PENDING", attempts: 0 }],
  ])("never touches a row %s: its own failure write fails and is retried; a replay is handed back as refused", async (_case, over) => {
    const transition = fakeTx({ rows: [row(over)] });
    await expect(keep(transition, RUNNERS)).rejects.toBeInstanceOf(FailedLaterRefundHeldError);
    expect(transition.paymentRecoveryOperation.updateMany).not.toHaveBeenCalled();
    expect(transition.paymentRecoveryOperation.createMany).not.toHaveBeenCalled();
    const replayed = fakeTx({ rows: [row(over)] });
    expect(await keep(replayed, RUNNERS, { kind: "replayed" })).toEqual({ readAsRefused: true });
    expect(replayed.paymentRecoveryOperation.updateMany).not.toHaveBeenCalled();
    expect(replayed.paymentRecoveryOperation.createMany).not.toHaveBeenCalled();
  });

  describe("an open row with no plan (a superseded intent's)", () => {
    const superseded = () =>
      fakeTx({
        rows: [row({ type: "REFUND_SUPERSEDED_PAYMENT", allocationPlan: null, paymentTransactionId: "txn-1", idempotencyKey: "payment_recovery_refund_x" })],
      });
    const ITS_OWN = { ...REFUND, metadata: { bookingId: "booking-1", reason: SUPERSEDED_PAYMENT_REFUND_METADATA_REASON } };

    it("re-derives its own refund by itself: nothing is written", async () => {
      const tx = superseded();
      expect(await keep(tx, ITS_OWN)).toEqual({});
      expect(tx.paymentRecoveryOperation.createMany).not.toHaveBeenCalled();
    });

    it("MUTATION (ML2): its own replay of the key is told the refund failed, so it asks again rather than closing", async () => {
      expect(await keep(superseded(), ITS_OWN, { kind: "replayed" })).toEqual({ readAsRefused: true });
    });

    it("another door's refund it would re-derive is owed by a row of its own", async () => {
      expect(await keep(superseded())).toMatchObject({ debt: { outcome: "raised" } });
    });
  });
});

describe("each refund the ledger writer saw fail later", () => {
  it("is decided in turn, on the intent the refund names or else the writer's, with the replays handed back", async () => {
    const tx = fakeTx({ rows: [row({ id: "op-held", status: "PROCESSING", allocationPlan: [{ paymentTransactionId: "txn-1", amountCents: 4_000, madeRefundId: "re_3" }] })] });
    const decided = await keepFailedLaterCardRefundsOwed(tx as never, {
      paymentId: "pay-1",
      paymentTransactionId: "txn-1",
      seen: [
        { refund: { ...REFUND, id: "re_a", payment_intent: "pi_named" }, kind: "transition" },
        { refund: { ...REFUND, id: "re_b", payment_intent: null }, kind: "transition" },
        { refund: { ...REFUND, id: "re_3" }, kind: "replayed" },
      ],
      fallbackPaymentIntentId: "pi_fallback",
    });
    expect(decided.debts.map((debt) => [debt.stripeRefundId, debt.paymentIntentId])).toEqual([
      ["re_a", "pi_named"],
      ["re_b", "pi_fallback"],
    ]);
    expect(decided.readAsRefused).toEqual(["re_3"]);
  });

  it("reads nothing when nothing was seen", async () => {
    const tx = fakeTx();
    expect(await keepFailedLaterCardRefundsOwed(tx as never, { paymentId: "pay-1", paymentTransactionId: "txn-1", seen: [] })).toEqual({ debts: [], readAsRefused: [] });
    expect(tx.$queryRaw).not.toHaveBeenCalled();
  });
});

describe("the officers' alert", () => {
  const debt = { operationId: "op-1", bookingId: "booking-1", paymentIntentId: "pi_1", amountCents: 4_000, stripeRefundId: "re_1" };
  const messageOf = () => (alertPaymentRecoveryOfficers.mock.calls[0] as unknown as [{ errorMessage: string }])[0].errorMessage;

  it.each([
    ["raised", /\$40\.00 .*will be asked for again automatically/],
    ["re-planned", /will be asked for again automatically/],
    ["re-planned-dead", /retries are already spent: pay the member another way and close it under "Card refunds Stripe gave up on" on the Stuck states page/],
    ["raised-dead", /will not be asked for again automatically: pay the member another way and close it under "Card refunds Stripe gave up on"/],
    ["raised-backlog", /before this release .* check whether the member has already been paid back, and close it under "Card refunds Stripe gave up on"/],
    // #4104 review (D2): which refund, and what to do about it.
    ["not-resent", /card refund re_1 of \$40\.00 .*did not make it for this booking .* not asked for again .*refund them again there or pay them another way\. Raise no refund note for it in Xero: the card refund credit note raised while Stripe counted it, if there is one, already records it/],
  ] as const)("says what a %s decision means, once", async (outcome, words) => {
    await alertFailedLaterCardRefunds([{ ...debt, outcome } as FailedLaterCardRefundDebt]);
    expect(alertPaymentRecoveryOfficers).toHaveBeenCalledTimes(1);
    expect(messageOf()).toMatch(words);
  });

  it("names no operation for a refund nothing owes", async () => {
    await alertFailedLaterCardRefunds([{ ...debt, operationId: null, paymentIntentId: null, outcome: "not-resent" }]);
    expect(alertPaymentRecoveryOfficers.mock.calls[0]?.[0]).toMatchObject({ operationId: undefined, paymentIntentId: "" });
  });

  it("sends nothing for nothing, and never throws", async () => {
    await alertFailedLaterCardRefunds([]);
    expect(alertPaymentRecoveryOfficers).not.toHaveBeenCalled();
    alertPaymentRecoveryOfficers.mockRejectedValueOnce(new Error("mail down"));
    await expect(alertFailedLaterCardRefunds([{ ...debt, outcome: "raised" }])).resolves.toBeUndefined();
  });
});

// #4166 (F1): the row raised to owe a refund records which row made it - by the
// metadata that row's runner sends, never by amount alone - so the booking page
// tells a cancel's failed refund from another door's of the same amount.
describe("#4166: the new row records which row made the refund, by what was sent", () => {
  const CLOSED_AT = new Date("2026-06-20T00:00:10.000Z");
  const cancelRow = row({
    id: "op-cancel",
    status: "SUCCEEDED",
    nextRetryAt: null,
    idempotencyKey: "booking_cancel_refund_recovery_booking-1",
    succeededAt: CLOSED_AT,
  });
  const APPEAL = { bookingId: "booking-1", reason: "refund_appeal_approved", refundRequestId: "rr-1" };
  const recorded = (stripeRefundId: string, status: string, at: Date) => ({ stripeRefundId, paymentTransactionId: "txn-1", amountCents: 4_000, status, createdAt: at, stripeCreatedAt: at });
  /** R, an approved appeal's refund made inline (no row), recorded first; X, the cancel's - both $40.00 on txn-1, inside the cancel row's window. */
  function bothRecorded(failing: "re_appeal" | "re_1") {
    const tx = fakeTx({ rows: [cancelRow] });
    tx.paymentRefund.findMany = vi.fn(async () => [
      recorded("re_appeal", failing === "re_appeal" ? "failed" : "succeeded", new Date("2026-06-20T00:00:02.000Z")),
      recorded("re_1", failing === "re_1" ? "failed" : "succeeded", REFUNDED_AT),
    ]);
    return tx;
  }
  const madeBy = (tx: ReturnType<typeof fakeTx>) => (inserted(tx)?.allocationPlan as Array<{ madeByOperationId?: string | null }>)[0]?.madeByOperationId;

  it("the cancel's own refund: the cancel row", async () => {
    const tx = fakeTx({ rows: [cancelRow] });
    await keep(tx);
    expect(inserted(tx)?.allocationPlan).toEqual([{ paymentTransactionId: "txn-1", amountCents: 4_000, madeByOperationId: "op-cancel" }]);
  });

  it("MUTATION: X (the cancel's) fails while R of the same amount holds the cancel slice by amount: still the cancel row", async () => {
    const tx = bothRecorded("re_1");
    await keep(tx);
    expect(madeBy(tx)).toBe("op-cancel");
  });

  it("MUTATION: R (the appeal's) fails, filling the cancel slice by amount: no row of this payment sent it, so none", async () => {
    const tx = bothRecorded("re_appeal");
    await keep(tx, { ...REFUND, id: "re_appeal", metadata: APPEAL });
    expect(inserted(tx)?.idempotencyKey).toBe("card_refund_failed_later_re_appeal");
    expect(madeBy(tx)).toBeNull();
  });

  it("several rows that send the same metadata (failed-later retries): the one whose slice it fills", async () => {
    const retry = (id: string, at: Date) =>
      row({ id, status: "SUCCEEDED", nextRetryAt: null, idempotencyKey: `card_refund_failed_later_re_${id}`, stripeKeyPrefix: `card_refund_failed_later_re_${id}`, createdAt: at, succeededAt: new Date(at.getTime() + 10_000) });
    const tx = fakeTx({ rows: [retry("a", new Date("2026-06-10T00:00:00.000Z")), retry("b", RAISED_AT)] });
    await keep(tx, { ...REFUND, metadata: { bookingId: "booking-1", reason: "card_refund_failed_later" } });
    expect(madeBy(tx)).toBe("b");
  });
});

// #4166 round 3: re-planning an open failed-later row - its retry failed later
// too while the row was still open - keeps the maker its slice records.
describe("#4166: a re-planned failed-later row keeps its recorded maker", () => {
  const openFailedLater = (madeByOperationId: string | null) =>
    row({
      id: "op-fl",
      idempotencyKey: "card_refund_failed_later_re_0",
      stripeKeyPrefix: "card_refund_failed_later_re_0",
      allocationPlan: [{ paymentTransactionId: "txn-1", amountCents: 4_000, madeByOperationId }],
    });

  it.each([
    ["a row it names", "op-cancel"],
    ["none (null)", null],
  ] as const)("MUTATION: the maker recorded as %s survives the re-plan", async (_label, maker) => {
    const tx = fakeTx({ rows: [openFailedLater(maker)] });
    const decided = await keep(tx, { ...REFUND, metadata: { bookingId: "booking-1", reason: "card_refund_failed_later" } });
    expect(decided.debt).toMatchObject({ outcome: "re-planned", operationId: "op-fl" });
    expect(tx.paymentRecoveryOperation.createMany).not.toHaveBeenCalled();
    expect(replan(tx)?.data.allocationPlan).toEqual([
      { paymentTransactionId: "txn-1", amountCents: 4_000, stripeKeySuffix: "refused1", failedRefundIds: ["re_1"], madeByOperationId: maker },
    ]);
  });
});
