import { describe, expect, it, vi } from "vitest";

/**
 * #3949 (`INV-PAY-137`): an edit's or an approved appeal's bank-transfer refund
 * on a joiner's booking the group organiser paid for by internet banking. The
 * one predicate (`paidByOrganiserInternetBanking`), the route it opens
 * (`group-settlement-mirror`), and the words that name the organiser as the
 * payee. The completion door's use of the route is pinned in
 * `manual-refund-task.test.ts`, and the whole of it against PostgreSQL in
 * `ib-group-child-hand-back.realdb.test.ts`.
 */

const mocks = vi.hoisted(() => ({
  bookingFindUnique: vi.fn(async (): Promise<unknown> => null),
  groupBookingFindUnique: vi.fn(async (): Promise<unknown> => null),
  sendAdminXeroSyncErrorAlert: vi.fn<(input: unknown) => Promise<object>>(async () => ({})),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    booking: { findUnique: (...a: unknown[]) => mocks.bookingFindUnique(...(a as [])) },
    groupBooking: { findUnique: (...a: unknown[]) => mocks.groupBookingFindUnique(...(a as [])) },
  },
}));
vi.mock("@/lib/email", () => ({ sendAdminXeroSyncErrorAlert: (input: unknown) => mocks.sendAdminXeroSyncErrorAlert(input) }));

import { bankTransferRefundPayee, paidByOrganiserCard, paidByOrganiserInternetBanking } from "@/lib/group-organiser-paid";
import { paymentShowsCaptureEvidence } from "@/lib/booking-payment-state";
import { netCollectedPaymentTookMoney } from "@/lib/payment-net-collected";
import { paymentHasCaptureEvidence as flattenedCaptureEvidence } from "@/lib/cancel-flattened-payment-backfill";
import {
  alertGroupMirrorRefundXeroByHand,
  applyGroupSettlementMirrorRefund,
  chooseGroupSettlementMirrorRoute,
  chooseReviewGroupSettlementMirrorRoute,
  isBankTransferHandBackRoute,
  GROUP_CANCEL_IN_PROGRESS_MESSAGE,
  isGroupSettlementMirrorHandBack,
  type GroupSettlementMirrorRoute,
} from "@/lib/group-settlement-mirror-hand-back";
import { refundMethodForEditReviewRoute, refundRequestCreditNoteAsk } from "@/lib/edit-financial-review-xero-leg";
import { GROUP_MIRROR_HAND_BACK_EXCEEDS_CASH_MESSAGE } from "@/lib/edit-financial-review-refund-refusals";
import { editRefundBankTransferPayee } from "@/lib/edit-refund-hand-back";
import { editRefundHandBackReason, refundRequestHandBackReason } from "@/lib/manual-refund-task-copy";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";
import { bookingModifiedRefundSentence, organiserByHandRefundSentence, refundRequestApprovedRefundSentence } from "@/lib/booking-modified-email-copy";

const GROUP_CHILD = { status: "PAID", organiserSettled: true, parentBookingId: "organiser-booking", payment: { id: "pay-1", source: "INTERNET_BANKING" } };

describe("the payee: who a bank transfer on a booking goes back to", () => {
  it("is the group organiser exactly when the organiser paid for a joiner's booking by internet banking", () => {
    expect(paidByOrganiserInternetBanking(GROUP_CHILD)).toBe(true);
    expect(bankTransferRefundPayee(GROUP_CHILD)).toBe("organiser");
    for (const booking of [
      { ...GROUP_CHILD, organiserSettled: false },
      { ...GROUP_CHILD, parentBookingId: null },
      { ...GROUP_CHILD, payment: { id: "pay-1", source: "STRIPE" } },
      { ...GROUP_CHILD, payment: null },
    ]) {
      expect(paidByOrganiserInternetBanking(booking)).toBe(false);
      expect(bankTransferRefundPayee(booking)).toBe("member");
    }
    // Disjoint from the card predicate (#3653): one booking is never both.
    expect(paidByOrganiserCard(GROUP_CHILD)).toBe(false);
  });

  it("names the payee of an edit's refund only when it goes back by hand", () => {
    expect(editRefundBankTransferPayee({ refundAmountCents: 1500, hasSucceededPayment: false }, GROUP_CHILD)).toBe("organiser");
    expect(editRefundBankTransferPayee({ refundAmountCents: 1500, hasSucceededPayment: false }, { ...GROUP_CHILD, organiserSettled: false })).toBe("member");
    expect(editRefundBankTransferPayee({ refundAmountCents: 0, hasSucceededPayment: false }, GROUP_CHILD)).toBeNull();
    expect(editRefundBankTransferPayee({ refundAmountCents: 1500, hasSucceededPayment: true }, GROUP_CHILD)).toBeNull();
  });
});

describe("which hand-backs complete onto a group child's mirror", () => {
  const task = (occurrenceKey: string | null, overrides: Record<string, unknown> = {}) => ({
    id: "task-1",
    kind: "CANCELLED_BOOKING_HAND_BACK",
    occurrenceKey,
    paymentId: "pay-1",
    booking: GROUP_CHILD,
    ...overrides,
  });

  it("an edit's, an approved appeal's and (owner decision, 22 Oct 2026) the joiner's own cancellation's, on the child's own payment", () => {
    expect(isGroupSettlementMirrorHandBack(task("edit-refund-hand-back:mod-1"))).toBe(true);
    expect(isGroupSettlementMirrorHandBack(task("refund-request-hand-back:req-1"))).toBe(true);
    expect(isGroupSettlementMirrorHandBack(task(null))).toBe(true);
  });

  it("never another keyed hand-back, another kind, another payment, or a booking the organiser did not pay by internet banking", () => {
    expect(isGroupSettlementMirrorHandBack(task("group-organiser-hand-back:s1"))).toBe(false);
    expect(isGroupSettlementMirrorHandBack(task("bank-refund-void:x"))).toBe(false);
    expect(isGroupSettlementMirrorHandBack(task("edit-refund-hand-back:mod-1", { kind: "EDIT_FINANCIAL_REVIEW" }))).toBe(false);
    expect(isGroupSettlementMirrorHandBack(task("edit-refund-hand-back:mod-1", { paymentId: "pay-other" }))).toBe(false);
    expect(isGroupSettlementMirrorHandBack(task("edit-refund-hand-back:mod-1", { paymentId: null }))).toBe(false);
    expect(isGroupSettlementMirrorHandBack(task("edit-refund-hand-back:mod-1", { booking: { ...GROUP_CHILD, payment: { id: "pay-1", source: "STRIPE" } } }))).toBe(false);
    expect(isGroupSettlementMirrorHandBack(task("edit-refund-hand-back:mod-1", { booking: { ...GROUP_CHILD, organiserSettled: false } }))).toBe(false);
  });

  function store({ transactions = 0, refundedAmountCents = 0, otherOpenCents = 0, groupStatus = "ACTIVE" } = {}) {
    const calls: string[] = [];
    return {
      calls,
      $executeRaw: vi.fn(async () => {
        calls.push("lock-payment-row");
        return 1;
      }),
      paymentTransaction: { count: vi.fn(async () => transactions) },
      payment: {
        findUnique: vi.fn(async () => ({ status: "SUCCEEDED", amountCents: 10_000, refundedAmountCents })),
        findUniqueOrThrow: vi.fn(async () => ({ amountCents: 10_000, refundedAmountCents })),
        update: vi.fn(async () => ({})),
      },
      manualRefundTask: { aggregate: vi.fn(async () => ({ _sum: { amountCents: otherOpenCents || null } })) },
      groupBooking: { findUnique: vi.fn(async () => ({ status: groupStatus })) },
    };
  }

  it("takes the Payment row before the cap, and caps at the payment less the OTHER open hand-backs", async () => {
    const db = store({ refundedAmountCents: 4_000, otherOpenCents: 2_000 });
    await expect(chooseGroupSettlementMirrorRoute({ task: task("edit-refund-hand-back:mod-1"), amountCents: 4_000, store: db as never })).resolves.toEqual({
      kind: "group-settlement-mirror",
      paymentId: "pay-1",
      bookingModificationId: null,
      refundCents: 4_000,
      creditBackCents: 0,
    });
    expect(db.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(db.payment.findUnique.mock.invocationCallOrder[0]!);
    expect(db.manualRefundTask.aggregate).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ paymentId: "pay-1", status: "OPEN", NOT: { id: "task-1" } }) }),
    );
    await expect(
      chooseGroupSettlementMirrorRoute({ task: task("edit-refund-hand-back:mod-1"), amountCents: 4_001, store: store({ refundedAmountCents: 4_000, otherOpenCents: 2_000 }) as never }),
    ).rejects.toMatchObject({ message: GROUP_MIRROR_HAND_BACK_EXCEEDS_CASH_MESSAGE, status: 400 });
  });

  it("leaves a payment some transaction backs, and every other task, to its ordinary route", async () => {
    const backed = store({ transactions: 1 });
    expect(await chooseGroupSettlementMirrorRoute({ task: task("edit-refund-hand-back:mod-1"), amountCents: 100, store: backed as never })).toBeNull();
    // Review C1: the count is read under the Payment row, taken first.
    expect(backed.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(backed.paymentTransaction.count.mock.invocationCallOrder[0]!);
    expect(backed.payment.findUnique).not.toHaveBeenCalled();
    const other = store();
    expect(await chooseGroupSettlementMirrorRoute({ task: task("group-organiser-hand-back:s1"), amountCents: 100, store: other as never })).toBeNull();
    expect(other.paymentTransaction.count).not.toHaveBeenCalled();
  });

  it("review round 3: refused while the organiser's group cancel has fenced the group and not yet claimed this child; allowed once it has", async () => {
    const midCancel = store({ groupStatus: "CANCELLED" });
    await expect(chooseGroupSettlementMirrorRoute({ task: task("edit-refund-hand-back:mod-1"), amountCents: 100, store: midCancel as never })).rejects.toMatchObject({
      status: 409,
      message: GROUP_CANCEL_IN_PROGRESS_MESSAGE,
    });
    expect(midCancel.payment.update).not.toHaveBeenCalled();
    const claimed = store({ groupStatus: "CANCELLED" });
    await expect(
      chooseGroupSettlementMirrorRoute({ task: task("edit-refund-hand-back:mod-1", { booking: { ...GROUP_CHILD, status: "CANCELLED" } }), amountCents: 100, store: claimed as never }),
    ).resolves.toMatchObject({ kind: "group-settlement-mirror" });
  });

  it("writes the mirror PARTIALLY_REFUNDED or REFUNDED, and refuses (never clamps) past what the payment holds", async () => {
    const route: GroupSettlementMirrorRoute = { kind: "group-settlement-mirror", paymentId: "pay-1", bookingModificationId: null, refundCents: 1_500, creditBackCents: 0 };
    const partial = store({ refundedAmountCents: 1_000 });
    await applyGroupSettlementMirrorRefund({ route, store: partial as never });
    expect(partial.payment.update).toHaveBeenCalledWith({ where: { id: "pay-1" }, data: { refundedAmountCents: 2_500, status: "PARTIALLY_REFUNDED" } });
    const whole = store({ refundedAmountCents: 8_500 });
    await applyGroupSettlementMirrorRefund({ route, store: whole as never });
    expect(whole.payment.update).toHaveBeenCalledWith({ where: { id: "pay-1" }, data: { refundedAmountCents: 10_000, status: "REFUNDED" } });
    const over = store({ refundedAmountCents: 9_000 });
    await expect(applyGroupSettlementMirrorRefund({ route, store: over as never })).rejects.toMatchObject({ message: GROUP_MIRROR_HAND_BACK_EXCEEDS_CASH_MESSAGE });
    expect(over.payment.update).not.toHaveBeenCalled();
  });
});

describe("review: an edit financial review's refund on such a child (#3949 review)", () => {
  const review = { id: "review-1", booking: GROUP_CHILD };
  const db = () => ({
    $executeRaw: vi.fn(async () => 1),
    paymentTransaction: { count: vi.fn(async () => 0) },
    payment: { findUnique: vi.fn(async () => ({ status: "SUCCEEDED", amountCents: 10_000, refundedAmountCents: 0 })) },
    manualRefundTask: { aggregate: vi.fn(async () => ({ _sum: { amountCents: null } })) },
    groupBooking: { findUnique: vi.fn(async () => ({ status: "ACTIVE" })) },
  });

  it("goes to the organiser onto the mirror, out of the child's own payment only", async () => {
    await expect(chooseReviewGroupSettlementMirrorRoute({ task: review, paymentId: "pay-1", amountCents: 2_000, store: db() as never })).resolves.toMatchObject({
      kind: "group-settlement-mirror",
      paymentId: "pay-1",
      refundCents: 2_000,
    });
    expect(await chooseReviewGroupSettlementMirrorRoute({ task: review, paymentId: "pay-other", amountCents: 2_000, store: db() as never })).toBeNull();
    expect(await chooseReviewGroupSettlementMirrorRoute({ task: { ...review, booking: { ...GROUP_CHILD, organiserSettled: false } }, paymentId: "pay-1", amountCents: 2_000, store: db() as never })).toBeNull();
  });
});

describe("review M1: the officers are told to credit the group's invoice by hand", () => {
  it("names the amount, the organiser, the joiner and the combined invoice, after the commit; never throws", async () => {
    mocks.bookingFindUnique.mockResolvedValueOnce({ parentBookingId: "org-b", member: { firstName: "Sam", lastName: "Joiner" } });
    mocks.groupBookingFindUnique.mockResolvedValueOnce({ organiserMember: { firstName: "Olive", lastName: "Organiser" }, settlement: { xeroInvoiceNumber: "INV-0042" } });
    await alertGroupMirrorRefundXeroByHand({ bookingId: "b1", taskId: "t1", refundCents: 1_500, format: CLUB_FORMAT_TEST });
    const sent = mocks.sendAdminXeroSyncErrorAlert.mock.calls.at(-1)![0] as { errorType: string; errorMessage: string };
    expect(sent.errorType).toBe("GROUP_ORGANISER_REFUND_NOTE_BY_HAND");
    expect(sent.errorMessage).toContain("$15.00 was paid back by bank transfer to the group organiser (Olive Organiser) for Sam Joiner's place");
    expect(sent.errorMessage).toContain("invoice INV-0042");
    expect(sent.errorMessage).toContain("Until automatic Xero notes are added, the app does not raise this refund's Xero credit note");
    expect(sent.errorMessage).not.toMatch(/#\d/);
    mocks.sendAdminXeroSyncErrorAlert.mockRejectedValueOnce(new Error("mail down"));
    await expect(alertGroupMirrorRefundXeroByHand({ bookingId: "b1", taskId: "t1", refundCents: 1_500, format: CLUB_FORMAT_TEST })).resolves.toBeUndefined();
  });
});

describe("the route reads as a bank transfer everywhere a hand-back does", () => {
  const route: GroupSettlementMirrorRoute = { kind: "group-settlement-mirror", paymentId: "pay-1", bookingModificationId: null, refundCents: 1_500, creditBackCents: 0 };

  it("is the internet-banking method and a bank-transfer hand-back, and queues no appeal note (review M1: no invoice of its own)", () => {
    expect(refundMethodForEditReviewRoute(route)).toBe("internet-banking");
    expect(isBankTransferHandBackRoute(route)).toBe(true);
    expect(isBankTransferHandBackRoute({ ...route, kind: "local-allocation" } as never)).toBe(true);
    expect(isBankTransferHandBackRoute({ kind: "account-credit" } as never)).toBe(false);
    expect(isBankTransferHandBackRoute(null)).toBe(false);
    expect(refundRequestCreditNoteAsk({ route, cancellationHandBackInvoiceId: "inv-1", amountCents: 1_500, refundRequestId: "req-1" })).toBeNull();
    expect(refundRequestCreditNoteAsk({ route: { ...route, kind: "local-allocation" } as never, cancellationHandBackInvoiceId: "inv-1", amountCents: 1_500, refundRequestId: "req-1" })).toEqual({
      paymentId: "pay-1",
      refundRequestId: "req-1",
      amountCents: 1_500,
    });
  });
});

describe("the words name the group organiser as the payee (owner decision, 21 Oct 2026)", () => {
  it("the task reasons", () => {
    expect(editRefundHandBackReason({ bookingId: "b1", editLabel: "date change", payee: "organiser" })).toBe(
      "Booking b1 lowered by a date change; the group organiser paid for it by internet banking, so the club refunds the difference to the group organiser by bank transfer.",
    );
    expect(refundRequestHandBackReason({ bookingId: "b1", payee: "organiser" })).toContain("refunds this to the group organiser by bank transfer");
    // The member wording is exactly what it was.
    expect(editRefundHandBackReason({ bookingId: "b1", editLabel: "date change", payee: "member" })).toBe(
      "Booking b1 lowered by a date change; paid by internet banking or by hand, so the club refunds the difference by bank transfer (#3827).",
    );
    expect(refundRequestHandBackReason({ bookingId: "b1", payee: "member" })).toBe(
      "Refund appeal approved on booking b1; not paid by card, so the club refunds this by bank transfer (#3827).",
    );
  });

  it("the Booking Modified and Refund Appeal Approved refund sentences", () => {
    const fmt = (cents: number) => `$${(cents / 100).toFixed(2)}`;
    expect(bookingModifiedRefundSentence("$15.00", "organiser", "own")).toBe(organiserByHandRefundSentence("$15.00"));
    expect(organiserByHandRefundSentence("$15.00")).toBe("The club will refund $15.00 to the group organiser directly, because the group organiser paid for this booking.");
    expect(bookingModifiedRefundSentence("$15.00", "member", "own")).toBe("The club will refund $15.00 to you by bank transfer.");
    expect(refundRequestApprovedRefundSentence(1_500, 1_500, fmt, null, "organiser")).toBe(organiserByHandRefundSentence("$15.00"));
    expect(refundRequestApprovedRefundSentence(1_500, 1_500, fmt)).toBe("The club will refund $15.00 to you by bank transfer.");
  });
});

describe("review round 3: an IB organiser child's settle mirror is capture evidence everywhere (INV-SSOT)", () => {
  const organiser = { organiserSettled: true, parentBookingId: "organiser-booking" };
  const member = { organiserSettled: false, parentBookingId: null };
  const partlyRefunded = { source: "INTERNET_BANKING", status: "PARTIALLY_REFUNDED", refundedAmountCents: 1_500 };

  it("the one helper: the organiser's mirror counts, an ordinary folded IB mirror does not", () => {
    expect(paymentShowsCaptureEvidence(partlyRefunded, false, organiser)).toBe(true);
    expect(paymentShowsCaptureEvidence({ ...partlyRefunded, status: "REFUNDED" }, false, organiser)).toBe(true);
    expect(paymentShowsCaptureEvidence({ ...partlyRefunded, status: "PENDING" }, false, organiser)).toBe(false);
    expect(paymentShowsCaptureEvidence(partlyRefunded, false, member)).toBe(false);
  });

  it("Net Collected counts a paid-back IB organiser child as money taken; the flattened backfill restores one", () => {
    const row = { ...partlyRefunded, amountCents: 4_500, _count: { transactions: 0 }, recoveryOperations: [], refunds: [] };
    expect(netCollectedPaymentTookMoney({ ...row, booking: organiser })).toBe(true);
    expect(netCollectedPaymentTookMoney({ ...row, booking: member })).toBe(false);
    const flattened = { id: "p", bookingId: "b", source: "INTERNET_BANKING" as const, status: "FAILED" as const, amountCents: 4_500, refundedAmountCents: 1_500, transactions: [] };
    expect(flattenedCaptureEvidence({ ...flattened, status: "PARTIALLY_REFUNDED", booking: organiser })).toBe(true);
    expect(flattenedCaptureEvidence({ ...flattened, status: "PARTIALLY_REFUNDED", booking: member })).toBe(false);
  });
});
