// #4210 (`INV-PAY-136`): a card refund a "Paid another way" close had already
// settled is not owed again when Stripe fails it later - and nothing else is
// hidden. These are the rules of `findPaidAnotherWayCloseThatSettled` as the
// failed-later writer (`keepFailedLaterCardRefundOwed`) applies them, against a
// fake transaction. The real-database proof is
// `cancel-card-refund-failed-later.realdb.test.ts`. Round 3 (money F1-F3): a
// close is weighed by what its record says it counted, and a close recorded
// before it kept that is weighed conservatively.
import { beforeEach, describe, expect, it, vi } from "vitest";

const alertPaymentRecoveryOfficers = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<undefined>>(async () => undefined));
const sendAdminCardRefundFailedAfterPaidAnotherWayAlert = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<void>>(async () => undefined));
vi.mock("@/lib/payment-recovery-alert", () => ({ alertPaymentRecoveryOfficers }));
vi.mock("@/lib/email/admin-alerts-card-refund", () => ({ alertCardRefundFailedAfterPaidAnotherWay: sendAdminCardRefundFailedAfterPaidAnotherWayAlert }));
vi.mock("@/lib/club-format-server", async () => ({
  clubFormatValues: async () => (await import("./support/club-format-fixture")).CLUB_FORMAT_TEST,
}));

import { lastErrorSuggestsStripeMayHaveRefunded } from "@/lib/card-refund-paid-another-way";
import {
  alertFailedLaterCardRefunds,
  keepFailedLaterCardRefundOwed,
  type FailedLaterCardRefundDebt,
  type FailedLaterKind,
  type FailedLaterRefundInput,
} from "@/lib/card-refund-failed-later";
import { cardRefundPaidAnotherWayOccurrenceKey } from "@/lib/manual-refund-task-settlement-rules";
import { MAX_PAYMENT_RECOVERY_ATTEMPTS } from "@/lib/payment-recovery-constants";
import { bookingModificationRefundReasonForKeyPrefix } from "@/lib/payment-recovery-keys";
import { paidAnotherWayCountedContext, type PaidAnotherWayCounted } from "@/lib/card-refund-paid-another-way-counted";

const RAISED_AT = new Date("2026-06-20T00:00:00.000Z");
/** When Stripe made X - its answer lost - and when the officer closed the row "Paid another way". */
const MADE_AT = new Date("2026-06-20T00:00:05.000Z");
const CLOSED_AT = new Date("2026-06-20T00:00:10.000Z");
/** After the close: the `charge.refunded` sync that finally recorded X. */
const RECORDED_LATE = new Date("2026-06-20T00:00:20.000Z");

type Row = Record<string, unknown> & { id: string };

function row(over: Partial<Row> = {}): Row {
  return {
    id: "op-cancel",
    type: "REFUND_BOOKING_MODIFICATION",
    status: "SUCCEEDED",
    attempts: MAX_PAYMENT_RECOVERY_ATTEMPTS,
    nextRetryAt: null,
    idempotencyKey: "booking_cancel_refund_recovery_booking-1",
    stripeKeyPrefix: null,
    amountCents: 4_000,
    allocationPlan: [{ paymentTransactionId: "txn-1", amountCents: 4_000 }],
    paymentTransactionId: null,
    bookingId: "booking-1",
    paymentIntentId: "pi_1",
    createdAt: RAISED_AT,
    succeededAt: CLOSED_AT,
    ...over,
  };
}

/** What a close counted: by default X's slice unsent and nothing made, so the close paid X's share. */
const counted = (over: Partial<PaidAnotherWayCounted> = {}) =>
  paidAnotherWayCountedContext({ refundIds: [], unsentSlices: [{ paymentTransactionId: "txn-1", amountCents: 4_000, exact: true }], ...over });

/** The close's record: paid back in full unless told otherwise, with what it counted. */
const closeRecord = (over: Record<string, unknown> = {}) => ({ id: "task-close", amountCents: 4_000, raisedAmountCents: 4_000, reviewContext: counted(), ...over });
/** A close recorded before round 3, which kept nothing of what it counted. */
const legacyClose = (over: Record<string, unknown> = {}) => closeRecord({ reviewContext: null, ...over });

type RefundRow = { stripeRefundId: string; paymentTransactionId: string; amountCents: number; status: string; createdAt: Date; stripeCreatedAt: Date };

function fakeTx({
  rows = [row()] as Row[],
  close = closeRecord() as Record<string, unknown> | null,
  recordedAt = RECORDED_LATE,
  madeAt = MADE_AT,
  refunds = undefined as RefundRow[] | undefined,
} = {}) {
  return {
    payment: {
      findUnique: vi.fn(async () => ({ id: "pay-1", bookingId: "booking-1", status: "PARTIALLY_REFUNDED", amountCents: 20_000, refundedAmountCents: 4_000 })),
    },
    paymentRefund: {
      findMany: vi.fn(async () => refunds ?? [{ stripeRefundId: "re_1", paymentTransactionId: "txn-1", amountCents: 4_000, status: "failed", createdAt: recordedAt, stripeCreatedAt: madeAt }]),
    },
    paymentTransaction: { findUnique: vi.fn(async () => ({ stripePaymentIntentId: "pi_txn" })) },
    auditLog: { create: vi.fn<(args: unknown) => Promise<object>>(async () => ({})) },
    manualRefundTask: { findFirst: vi.fn<(args: unknown) => Promise<Record<string, unknown> | null>>(async () => close) },
    paymentRecoveryOperation: {
      findMany: vi.fn(async () => rows),
      createMany: vi.fn<(args: unknown) => Promise<{ count: number }>>(async () => ({ count: 1 })),
      updateMany: vi.fn<(args: unknown) => Promise<{ count: number }>>(async () => ({ count: 1 })),
      findUniqueOrThrow: vi.fn(async () => ({ id: "op-new" })),
    },
  };
}

/** X: the cancellation row's own refund, carrying exactly what its runner sends. */
const X: FailedLaterRefundInput = { id: "re_1", amount: 4_000, status: "failed", created: Math.floor(MADE_AT.getTime() / 1000), metadata: { bookingId: "booking-1", reason: "cancellation" } };
const APPEAL = { bookingId: "booking-1", reason: "refund_appeal_approved", refundRequestId: "rr-1" };

const keep = (tx: ReturnType<typeof fakeTx>, refund: FailedLaterRefundInput = X, kind: FailedLaterKind = "transition") =>
  keepFailedLaterCardRefundOwed(tx as never, { paymentId: "pay-1", paymentTransactionId: "txn-1", refund, kind, paymentIntentId: "pi_1", cutoffSeconds: null });
const inserted = (tx: ReturnType<typeof fakeTx>) =>
  (tx.paymentRecoveryOperation.createMany.mock.calls[0]?.[0] as { data: Array<Record<string, unknown>> } | undefined)?.data[0];
const audited = (tx: ReturnType<typeof fakeTx>) => tx.auditLog.create.mock.calls[0]?.[0] as { data: Record<string, unknown> } | undefined;

beforeEach(() => {
  alertPaymentRecoveryOfficers.mockClear();
  sendAdminCardRefundFailedAfterPaidAnotherWayAlert.mockClear();
});

describe("settled: the row that sent it was closed \"Paid another way\", and that close paid it back", () => {
  it("MUTATION: recorded after the close (the paid-twice reading): no row, audited, the decision on the debt", async () => {
    const tx = fakeTx();
    expect(await keep(tx)).toEqual({
      debt: {
        outcome: "settled-paid-another-way",
        operationId: "op-cancel",
        bookingId: "booking-1",
        paymentIntentId: "pi_1",
        amountCents: 4_000,
        stripeRefundId: "re_1",
        paidAnotherWay: { recordId: "task-close", operationId: "op-cancel", paidBackCents: 4_000, owedCents: 4_000, checkCents: 0, onPaidTwiceList: true, recordedAfterClose: true, resolutionNote: null },
      },
    });
    expect(tx.paymentRecoveryOperation.createMany).not.toHaveBeenCalled();
    expect(tx.paymentRecoveryOperation.updateMany).not.toHaveBeenCalled();
    // The close's own record, by the one way to find it, COMPLETED.
    const where = (tx.manualRefundTask.findFirst.mock.calls[0]?.[0] as { where: { occurrenceKey: { in: string[] }; status: string } }).where;
    expect(where.occurrenceKey.in).toContain(cardRefundPaidAnotherWayOccurrenceKey("op-cancel", { xeroRefundNote: "now" }));
    expect(where.status).toBe("COMPLETED");
    expect(audited(tx)).toMatchObject({
      data: { action: "booking-payment.card-refund.failed-later-paid-another-way", entityType: "PaymentRefund", entityId: "re_1", targetId: "booking-1", category: "payment" },
    });
  });

  it("seen again by a replay, it writes and alerts nothing", async () => {
    const tx = fakeTx();
    expect(await keep(tx, X, "replayed")).toEqual({});
    expect(tx.auditLog.create).not.toHaveBeenCalled();
    expect(tx.paymentRecoveryOperation.createMany).not.toHaveBeenCalled();
  });

  it("MUTATION (concurrency F2): recorded BEFORE the close but filling a newer row's slice - the close paid it by bank: settled", async () => {
    const newer = row({ id: "op-edit", status: "FAILED", attempts: 1, nextRetryAt: CLOSED_AT, idempotencyKey: "payment_recovery_modification_refund_mod-1", createdAt: new Date("2026-06-20T00:00:01.000Z"), succeededAt: null });
    const tx = fakeTx({ rows: [row(), newer], recordedAt: MADE_AT });
    expect(await keep(tx)).toMatchObject({ debt: { outcome: "settled-paid-another-way", operationId: "op-cancel", paidAnotherWay: { onPaidTwiceList: false, recordedAfterClose: false } } });
    expect(tx.paymentRecoveryOperation.createMany).not.toHaveBeenCalled();
    expect(tx.paymentRecoveryOperation.updateMany).not.toHaveBeenCalled();
  });

  it("MUTATION: a failed-later row's retry, that row closed \"Paid another way\" first: settled, never raised dead for a second close", async () => {
    const retryRow = row({ id: "op-fl", idempotencyKey: "card_refund_failed_later_re_0", stripeKeyPrefix: "card_refund_failed_later_re_0" });
    const tx = fakeTx({ rows: [retryRow] });
    const retry = { ...X, metadata: { bookingId: "booking-1", reason: bookingModificationRefundReasonForKeyPrefix("card_refund_failed_later_re_0") } };
    expect(await keep(tx, retry)).toMatchObject({ debt: { outcome: "settled-paid-another-way", operationId: "op-fl" } });
    expect(tx.paymentRecoveryOperation.createMany).not.toHaveBeenCalled();
  });

  it("MUTATION (UX2): a dashboard refund (no metadata) the closed row's paid-twice figure counted: settled, never \"not re-sent\"", async () => {
    const tx = fakeTx();
    expect(await keep(tx, { ...X, metadata: null })).toMatchObject({ debt: { outcome: "settled-paid-another-way", operationId: "op-cancel" } });
    expect(audited(tx)?.data.action).toBe("booking-payment.card-refund.failed-later-paid-another-way");
  });

  // Round 3 (UX 6): a resolution speaks only for refunds its paid-twice row listed.
  it("MUTATION (UX6): a resolved paid-twice row does not speak for a refund that was never on it - settled, nothing raised", async () => {
    const newer = row({ id: "op-edit", status: "FAILED", attempts: 1, nextRetryAt: CLOSED_AT, idempotencyKey: "payment_recovery_modification_refund_mod-1", createdAt: new Date("2026-06-20T00:00:01.000Z"), succeededAt: null });
    const reviewContext = { ...counted(), paidTwiceResolved: { resolvedAt: "2026-06-21T00:00:00.000Z", resolvedByMemberId: "officer", note: "Another refund", refundedByCardCents: 4_000 } };
    const tx = fakeTx({ rows: [row(), newer], recordedAt: MADE_AT, close: closeRecord({ reviewContext }) });
    expect(await keep(tx)).toMatchObject({ debt: { outcome: "settled-paid-another-way", paidAnotherWay: { onPaidTwiceList: false, checkCents: 0, resolutionNote: null } } });
    expect(tx.paymentRecoveryOperation.createMany).not.toHaveBeenCalled();
  });
});

describe("owed again as before: never settled by a close that did not pay it back", () => {
  it("MUTATION (control): a refund the close counted as made - on its record - is re-sent", async () => {
    const tx = fakeTx({ recordedAt: MADE_AT, close: closeRecord({ reviewContext: counted({ refundIds: ["re_1"], unsentSlices: [] }) }) });
    expect(await keep(tx)).toMatchObject({ debt: { outcome: "raised" } });
    expect(inserted(tx)).toMatchObject({ attempts: 0, amountCents: 4_000 });
  });

  // Two slices of one amount on one charge (a capacity race's halves): X made
  // the first and the close counted it; it paid back only the second. X fits
  // that unsent slice by amount, but the close counted X - owed again.
  it("MUTATION (money F2): a refund the close counted fits its other, unsent slice of the same amount - still re-sent", async () => {
    const halves = row({ allocationPlan: [{ paymentTransactionId: "txn-1", amountCents: 4_000 }, { paymentTransactionId: "txn-1", amountCents: 4_000 }], amountCents: 8_000 });
    const close = closeRecord({ reviewContext: counted({ refundIds: ["re_1"], unsentSlices: [{ paymentTransactionId: "txn-1", amountCents: 4_000, exact: true }] }) });
    const tx = fakeTx({ rows: [halves], recordedAt: MADE_AT, close });
    expect(await keep(tx)).toMatchObject({ debt: { outcome: "raised" } });
    expect(inserted(tx)).toMatchObject({ attempts: 0, amountCents: 4_000 });
  });

  it("MUTATION (boundary): made by Stripe in the instant of the close is the close's; a second later is not (money F1)", async () => {
    expect(await keep(fakeTx({ madeAt: CLOSED_AT }))).toMatchObject({ debt: { outcome: "settled-paid-another-way" } });
    // A later refund carrying the closed row's metadata - a second change's, say - made after the close.
    const later = fakeTx({ madeAt: new Date(CLOSED_AT.getTime() + 1_000) });
    expect(await keep(later)).toMatchObject({ debt: { outcome: "raised" } });
    expect(inserted(later)).toMatchObject({ attempts: 0 });
  });

  it("MUTATION (control): a row closed by its own refund, with no \"Paid another way\" record: re-sent", async () => {
    const tx = fakeTx({ close: null });
    expect(await keep(tx)).toMatchObject({ debt: { outcome: "raised" } });
    expect(inserted(tx)).toMatchObject({ attempts: 0 });
  });

  it("MUTATION (money F2): another door's refund for this booking (an approved request's) that fills the closed row's slice by amount: re-sent", async () => {
    const tx = fakeTx();
    expect(await keep(tx, { ...X, metadata: APPEAL })).toMatchObject({ debt: { outcome: "raised" } });
    expect(inserted(tx)).toMatchObject({ attempts: 0, allocationPlan: [{ paymentTransactionId: "txn-1", amountCents: 4_000, madeByOperationId: null }] });
    expect(tx.manualRefundTask.findFirst).not.toHaveBeenCalled();
  });

  // Round 3, money F1: edit refunds share their metadata - the booking and a
  // reason - so a second date change's own refund reads as sent by the first's
  // closed row. It fits none of the slices that close found unsent: owed.
  describe("money F1: two date changes' refunds of different amounts", () => {
    const PREFIX = "mod_dates_refund_mod-1";
    const first = row({ id: "op-change-1", idempotencyKey: "payment_recovery_modification_refund_mod-1", stripeKeyPrefix: PREFIX });
    const E: FailedLaterRefundInput = { id: "re_e", amount: 2_500, status: "failed", created: Math.floor(MADE_AT.getTime() / 1000), metadata: { bookingId: "booking-1", reason: bookingModificationRefundReasonForKeyPrefix(PREFIX) } };
    const refunds = [{ stripeRefundId: "re_e", paymentTransactionId: "txn-1", amountCents: 2_500, status: "failed", createdAt: MADE_AT, stripeCreatedAt: MADE_AT }];

    it("MUTATION: the second change's own $25.00, recorded before the first's $40.00 close, is owed again and re-sent", async () => {
      const tx = fakeTx({ rows: [first], refunds });
      expect(await keep(tx, E)).toMatchObject({ debt: { outcome: "raised", amountCents: 2_500 } });
      expect(inserted(tx)).toMatchObject({ attempts: 0, amountCents: 2_500, allocationPlan: [{ madeByOperationId: "op-change-1" }] });
      expect(tx.auditLog.create).not.toHaveBeenCalled();
    });

    it("MUTATION: likewise against a close that kept no record of what it counted", async () => {
      const tx = fakeTx({ rows: [first], refunds, close: legacyClose() });
      expect(await keep(tx, E)).toMatchObject({ debt: { outcome: "raised", amountCents: 2_500 } });
      expect(inserted(tx)).toMatchObject({ attempts: 0 });
    });
  });

  // Round 3, money F2: the close counted X as made (its record owed only the
  // other slice); later another refund failed and today's matching moved X to
  // a newer open row's slice. What the close counted decides, not today's matching.
  describe("money F2: today's matching moved since the close", () => {
    const r = row({ allocationPlan: [{ paymentTransactionId: "txn-1", amountCents: 4_000 }, { paymentTransactionId: "txn-2", amountCents: 1_000 }], amountCents: 5_000 });
    const n = row({ id: "op-n", status: "FAILED", attempts: 1, nextRetryAt: CLOSED_AT, idempotencyKey: "payment_recovery_modification_refund_mod-1", stripeKeyPrefix: "mod_dates_refund_mod-1",
      allocationPlan: [{ paymentTransactionId: "txn-1", amountCents: 4_000 }], createdAt: new Date("2026-06-20T00:00:01.000Z"), succeededAt: null });
    const refunds = [
      { stripeRefundId: "re_z", paymentTransactionId: "txn-1", amountCents: 4_000, status: "failed", createdAt: new Date("2026-06-20T00:00:02.000Z"), stripeCreatedAt: new Date("2026-06-20T00:00:02.000Z") },
      { stripeRefundId: "re_1", paymentTransactionId: "txn-1", amountCents: 4_000, status: "failed", createdAt: MADE_AT, stripeCreatedAt: MADE_AT },
    ];
    const paidTheOtherSlice = { amountCents: 1_000, raisedAmountCents: 1_000 };

    it("MUTATION: the close counted it - owed again and re-sent, never settled", async () => {
      const close = closeRecord({ ...paidTheOtherSlice, reviewContext: counted({ refundIds: ["re_1"], unsentSlices: [{ paymentTransactionId: "txn-2", amountCents: 1_000, exact: true }] }) });
      const tx = fakeTx({ rows: [r, n], refunds, close });
      expect(await keep(tx)).toMatchObject({ debt: { outcome: "raised", amountCents: 4_000 } });
      expect(inserted(tx)).toMatchObject({ attempts: 0, amountCents: 4_000 });
    });

    it("MUTATION: a close that kept no record - raised dead for an officer to check, never settled", async () => {
      const tx = fakeTx({ rows: [r, n], refunds, close: legacyClose(paidTheOtherSlice) });
      expect(await keep(tx)).toMatchObject({ debt: { outcome: "raised-check-uncertain", paidAnotherWay: { checkCents: 4_000 } } });
      expect(inserted(tx)).toMatchObject({ attempts: MAX_PAYMENT_RECOVERY_ATTEMPTS, amountCents: 4_000, allocationPlan: [{ paidAnotherWayCheck: { closedOperationId: "op-cancel", reason: "uncertain" } }] });
    });
  });

  describe("concurrency F1: sent by an open row R, filling the closed row's slice by amount", () => {
    // R's slice does not fit X, so X fills the closed cancel row's - but R sent it.
    const r = row({ id: "op-r", status: "FAILED", attempts: 1, nextRetryAt: CLOSED_AT, idempotencyKey: "payment_recovery_modification_refund_mod-1", allocationPlan: [{ paymentTransactionId: "txn-1", amountCents: 3_999 }], succeededAt: null });
    const RS = { ...X, metadata: { bookingId: "booking-1", reason: "booking_modification_refund_recovery" } };

    it("MUTATION: decided on R alone - a row of its own owes it, made by R", async () => {
      const tx = fakeTx({ rows: [row(), r] });
      expect(await keep(tx, RS)).toMatchObject({ debt: { outcome: "raised" } });
      expect(inserted(tx)).toMatchObject({ attempts: 0, allocationPlan: [{ paymentTransactionId: "txn-1", amountCents: 4_000, madeByOperationId: "op-r" }] });
    });

    it("MUTATION: R's own replay reads it as refused, and R moves its slice itself", async () => {
      const tx = fakeTx({ rows: [row(), r] });
      expect(await keep(tx, RS, "replayed")).toEqual({ readAsRefused: true });
      expect(tx.paymentRecoveryOperation.createMany).not.toHaveBeenCalled();
    });
  });
});

describe("a close recorded before round 3, which kept nothing of what it counted", () => {
  it("MUTATION: recorded after it and on the paid-twice list - it cannot have counted it: settled", async () => {
    const tx = fakeTx({ close: legacyClose() });
    expect(await keep(tx)).toMatchObject({ debt: { outcome: "settled-paid-another-way", paidAnotherWay: { onPaidTwiceList: true } } });
    expect(tx.paymentRecoveryOperation.createMany).not.toHaveBeenCalled();
  });

  it("MUTATION: recorded before it, fitting a slice the row planned - it may have counted it: raised dead to check, never settled or re-sent", async () => {
    const tx = fakeTx({ recordedAt: MADE_AT, close: legacyClose() });
    expect(await keep(tx)).toMatchObject({ debt: { outcome: "raised-check-uncertain", paidAnotherWay: { checkCents: 4_000 } } });
    expect(inserted(tx)).toMatchObject({ amountCents: 4_000, attempts: MAX_PAYMENT_RECOVERY_ATTEMPTS });
  });
});

describe("what a close may not have covered is raised dead, for an officer to check", () => {
  it("MUTATION (F3): a part close - the part it gave up, at most this refund, never sent", async () => {
    const tx = fakeTx({ close: closeRecord({ amountCents: 2_500, raisedAmountCents: 4_000 }) });
    expect(await keep(tx)).toMatchObject({
      debt: { outcome: "raised-check-part-close", operationId: "op-new", amountCents: 4_000, paidAnotherWay: { paidBackCents: 2_500, owedCents: 4_000, checkCents: 1_500 } },
    });
    expect(inserted(tx)).toMatchObject({
      idempotencyKey: "card_refund_failed_later_re_1",
      amountCents: 1_500,
      attempts: MAX_PAYMENT_RECOVERY_ATTEMPTS,
      allocationPlan: [{ paymentTransactionId: "txn-1", amountCents: 1_500, madeByOperationId: "op-cancel", paidAnotherWayCheck: { closedOperationId: "op-cancel", reason: "part-close" } }],
    });
    // Stripe sent nothing: no "Stripe may have refunded" warning on the row.
    expect(lastErrorSuggestsStripeMayHaveRefunded(String(inserted(tx)?.lastError))).toBe(false);
    expect(audited(tx)?.data).toMatchObject({ action: "booking-payment.card-refund.failed-later-paid-another-way" });
  });

  it("MUTATION (F4): its paid-twice row marked Resolved - the member may have returned the extra: the whole refund, never sent", async () => {
    const reviewContext = { ...counted(), paidTwiceResolved: { resolvedAt: "2026-06-21T00:00:00.000Z", resolvedByMemberId: "officer", note: "Member returned it by bank", refundedByCardCents: 4_000 } };
    const tx = fakeTx({ close: closeRecord({ reviewContext }) });
    expect(await keep(tx)).toMatchObject({ debt: { outcome: "raised-check-resolved", paidAnotherWay: { checkCents: 4_000, resolutionNote: "Member returned it by bank" } } });
    expect(inserted(tx)).toMatchObject({ amountCents: 4_000, attempts: MAX_PAYMENT_RECOVERY_ATTEMPTS, allocationPlan: [{ paidAnotherWayCheck: { reason: "resolved" } }] });
    expect(audited(tx)?.data).toMatchObject({ details: "Member returned it by bank" });
  });

  it("MUTATION: a refund larger than the close owed - raised dead to check, never settled", async () => {
    const tx = fakeTx({ close: closeRecord({ amountCents: 3_000, raisedAmountCents: 3_000 }) });
    expect(await keep(tx)).toMatchObject({ debt: { outcome: "raised-check-uncertain", paidAnotherWay: { checkCents: 4_000 } } });
  });

  // Round 3, money F3: two slices of one part close ($40 + $10), which paid
  // $20 and gave up $30. Both fail: the checks together list $30, never more.
  describe("money F3: several failed refunds of one part close list at most what it gave up", () => {
    const r = row({ allocationPlan: [{ paymentTransactionId: "txn-1", amountCents: 4_000 }, { paymentTransactionId: "txn-2", amountCents: 1_000 }], amountCents: 5_000 });
    const close = closeRecord({ amountCents: 2_000, raisedAmountCents: 5_000, reviewContext: counted({ unsentSlices: [{ paymentTransactionId: "txn-1", amountCents: 4_000, exact: true }, { paymentTransactionId: "txn-2", amountCents: 1_000, exact: true }] }) });
    const X2: FailedLaterRefundInput = { ...X, id: "re_2", amount: 1_000 };
    const refunds = (failed: string[]) =>
      [
        { stripeRefundId: "re_1", paymentTransactionId: "txn-1", amountCents: 4_000 },
        { stripeRefundId: "re_2", paymentTransactionId: "txn-2", amountCents: 1_000 },
      ].map((each) => ({ ...each, status: failed.includes(each.stripeRefundId) ? "failed" : "pending", createdAt: RECORDED_LATE, stripeCreatedAt: MADE_AT }));
    /** The check row the first failure raised, as the second failure reads it. */
    const checkRow = (refundId: string, txn: string, cents: number) =>
      row({ id: `op-check-${refundId}`, status: "PENDING", succeededAt: null, createdAt: new Date("2026-06-21T00:00:00.000Z"), idempotencyKey: `card_refund_failed_later_${refundId}`, stripeKeyPrefix: `card_refund_failed_later_${refundId}`, amountCents: cents,
        allocationPlan: [{ paymentTransactionId: txn, amountCents: cents, madeByOperationId: "op-cancel", paidAnotherWayCheck: { closedOperationId: "op-cancel", reason: "part-close" } }] });
    const checked = async (tx: ReturnType<typeof fakeTx>, refund: FailedLaterRefundInput) => ((await keep(tx, refund)).debt?.paidAnotherWay?.checkCents ?? -1);

    it("MUTATION: the $40.00 first, then the $10.00 - $30.00 listed in all", async () => {
      const first = await checked(fakeTx({ rows: [r], close, refunds: refunds(["re_1"]) }), X);
      const second = await checked(fakeTx({ rows: [r, checkRow("re_1", "txn-1", first)], close, refunds: refunds(["re_1", "re_2"]) }), X2);
      expect([first, second]).toEqual([3_000, 0]);
    });

    it("MUTATION: the $10.00 first, then the $40.00 - $30.00 listed in all", async () => {
      const first = await checked(fakeTx({ rows: [r], close, refunds: refunds(["re_2"]) }), X2);
      const second = await checked(fakeTx({ rows: [r, checkRow("re_2", "txn-2", first)], close, refunds: refunds(["re_1", "re_2"]) }), X);
      expect([first, second]).toEqual([1_000, 2_000]);
    });
  });
});

// A check row is never sent, but a failed-later row's runner sends the same
// metadata, so a refund of its amount can read as its own; if that one fails,
// the check is re-planned like any open row - and stays a check.
describe("a check row re-planned", () => {
  it("MUTATION: keeps its check mark", async () => {
    const CHECK = { closedOperationId: "op-cancel", reason: "part-close" };
    const checkRow = row({ id: "op-check", status: "PENDING", succeededAt: null, createdAt: new Date("2026-06-21T00:00:00.000Z"), idempotencyKey: "card_refund_failed_later_re_0", stripeKeyPrefix: "card_refund_failed_later_re_0", amountCents: 1_500,
      allocationPlan: [{ paymentTransactionId: "txn-1", amountCents: 1_500, madeByOperationId: "op-cancel", paidAnotherWayCheck: CHECK }] });
    const madeAt = new Date("2026-06-22T00:00:00.000Z");
    const Y: FailedLaterRefundInput = { id: "re_y", amount: 1_500, status: "failed", created: Math.floor(madeAt.getTime() / 1000), metadata: { bookingId: "booking-1", reason: bookingModificationRefundReasonForKeyPrefix("card_refund_failed_later_re_0") } };
    const tx = fakeTx({ rows: [row(), checkRow], refunds: [{ stripeRefundId: "re_y", paymentTransactionId: "txn-1", amountCents: 1_500, status: "failed", createdAt: madeAt, stripeCreatedAt: madeAt }] });
    expect(await keep(tx, Y)).toMatchObject({ debt: { outcome: "re-planned-dead", operationId: "op-check" } });
    const replanned = (tx.paymentRecoveryOperation.updateMany.mock.calls[0]?.[0] as { data: { allocationPlan: Array<Record<string, unknown>> } }).data.allocationPlan;
    expect(replanned[0]).toMatchObject({ failedRefundIds: ["re_y"], paidAnotherWayCheck: CHECK });
  });
});

describe("the officers' alert: its own unmuteable mail", () => {
  const debt = (over: Partial<FailedLaterCardRefundDebt> = {}): FailedLaterCardRefundDebt => ({
    outcome: "settled-paid-another-way",
    operationId: "op-cancel",
    bookingId: "booking-1",
    paymentIntentId: "pi_1",
    amountCents: 4_000,
    stripeRefundId: "re_1",
    paidAnotherWay: { recordId: "task-close", operationId: "op-cancel", paidBackCents: 4_000, owedCents: 4_000, checkCents: 0, onPaidTwiceList: true, recordedAfterClose: true, resolutionNote: null },
    ...over,
  });
  const noteOf = (call = 0) => (sendAdminCardRefundFailedAfterPaidAnotherWayAlert.mock.calls[call] as unknown as [{ note: string }])[0].note;

  it("MUTATION (UX1, UX6): settled - sent through its own sender, never the payment-failure alert, and says not to pay again", async () => {
    await alertFailedLaterCardRefunds([debt()]);
    expect(alertPaymentRecoveryOfficers).not.toHaveBeenCalled();
    expect(sendAdminCardRefundFailedAfterPaidAnotherWayAlert).toHaveBeenCalledTimes(1);
    expect(noteOf()).toMatch(/card refund re_1 of \$40\.00 failed .*closed as paid another way.*paid the member back \$40\.00\. The app had not yet counted this refund when the close was recorded.* It showed under "Card refunds paid back twice", and leaves that list now\./);
    expect(noteOf()).toMatch(/Do not pay the member again unless they have already returned the extra; if you only asked, tell them not to send it\./);
  });

  it("MUTATION (UX4): claims nothing about the paid-twice list when the refund was never on it", async () => {
    await alertFailedLaterCardRefunds([debt({ paidAnotherWay: { ...debt().paidAnotherWay!, onPaidTwiceList: false } })]);
    expect(noteOf()).not.toMatch(/paid back twice/);
  });

  // Round 3, money F5: counted toward another row before the close, nobody was paid twice.
  it("MUTATION (F5): a refund counted toward another row before the close says so, and never that the member was paid twice", async () => {
    await alertFailedLaterCardRefunds([debt({ paidAnotherWay: { ...debt().paidAnotherWay!, onPaidTwiceList: false, recordedAfterClose: false } })]);
    expect(noteOf()).toMatch(/The app had counted this refund toward another card refund on the booking, not this one, so the close paid its share back\./);
    expect(noteOf()).not.toMatch(/had not yet counted|returned the extra/);
    expect(noteOf()).toMatch(/Do not pay the member again\./);
  });

  it("says what a part close, a resolved row or an uncertain close leaves to check, how much, and how to close it either way", async () => {
    await alertFailedLaterCardRefunds([
      debt({ outcome: "raised-check-part-close", paidAnotherWay: { ...debt().paidAnotherWay!, paidBackCents: 2_500, checkCents: 1_500 } }),
      debt({ outcome: "raised-check-resolved", paidAnotherWay: { ...debt().paidAnotherWay!, checkCents: 4_000, resolutionNote: "Returned by bank" } }),
      debt({ outcome: "raised-check-uncertain", paidAnotherWay: { ...debt().paidAnotherWay!, checkCents: 4_000, onPaidTwiceList: false, recordedAfterClose: false } }),
    ]);
    expect(noteOf(0)).toMatch(/paid the member back \$25\.00 of the \$40\.00 it owed and gave the rest up.*Up to \$15\.00 of this refund may be part of what the close gave up/);
    expect(noteOf(1)).toMatch(/marked resolved under "Card refunds paid back twice", with the note: "Returned by bank"\. If the member returned the extra, they are owed \$40\.00 again/);
    expect(noteOf(2)).toMatch(/The app cannot tell whether that close paid this refund's share back.*\$40\.00 is listed under/);
    expect(noteOf(2)).not.toMatch(/counted this refund/);
    for (const call of [0, 1, 2]) {
      expect(noteOf(call)).toMatch(/close it there as checked - not owed/);
      expect(noteOf(call)).not.toMatch(/developer/);
    }
  });
});
