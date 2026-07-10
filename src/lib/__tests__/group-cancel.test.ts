import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  BookingStatus,
  GroupBookingPaymentMode,
  GroupBookingStatus,
  PaymentSource,
  PaymentStatus,
  Prisma,
} from "@prisma/client";

const mocks = vi.hoisted(() => ({
  groupBookingFindUnique: vi.fn(),
  groupBookingUpdate: vi.fn(),
  bookingFindMany: vi.fn(),
  bookingUpdate: vi.fn(),
  paymentUpdate: vi.fn(),
  settlementUpdate: vi.fn(),
  transaction: vi.fn(),
  processRefund: vi.fn(),
  cancelPaymentIntentIfCancellable: vi.fn(),
  calculateRefundAmount: vi.fn(),
  daysUntilDate: vi.fn(),
  loadCancellationPolicy: vi.fn(),
  reconcileBedAllocations: vi.fn(),
  revokePaymentLinks: vi.fn(),
  recordBookingEvent: vi.fn(),
  sendBookingCancelledEmail: vi.fn(),
  processWaitlistForDates: vi.fn(),
  enqueueXeroRefund: vi.fn(),
  kickXero: vi.fn(),
  isXeroConnected: vi.fn(),
  logAudit: vi.fn(),
  paymentFindUnique: vi.fn(),
  paymentUpdateMany: vi.fn(),
  settlementFindUnique: vi.fn(),
  bookingFindUnique: vi.fn(),
  enqueueGroupSettlementRefundRecovery: vi.fn(),
  markGroupSettlementRefundRecoverySucceeded: vi.fn(),
}));

const txClient = {
  booking: { update: mocks.bookingUpdate },
  payment: { update: mocks.paymentUpdate },
};

vi.mock("@/lib/prisma", () => ({
  prisma: {
    groupBooking: {
      findUnique: mocks.groupBookingFindUnique,
      update: mocks.groupBookingUpdate,
    },
    booking: {
      findMany: mocks.bookingFindMany,
      findUnique: mocks.bookingFindUnique,
    },
    payment: {
      findUnique: mocks.paymentFindUnique,
      updateMany: mocks.paymentUpdateMany,
    },
    groupBookingSettlement: {
      update: mocks.settlementUpdate,
      findUnique: mocks.settlementFindUnique,
    },
    $transaction: mocks.transaction,
  },
}));
vi.mock("@/lib/stripe", () => ({
  processRefund: mocks.processRefund,
  cancelPaymentIntentIfCancellable: mocks.cancelPaymentIntentIfCancellable,
}));
vi.mock("@/lib/cancellation", () => ({
  calculateRefundAmount: mocks.calculateRefundAmount,
  daysUntilDate: mocks.daysUntilDate,
  loadCancellationPolicy: mocks.loadCancellationPolicy,
}));
vi.mock("@/lib/bed-allocation-lifecycle", () => ({
  reconcileBedAllocationsForBooking: mocks.reconcileBedAllocations,
}));
vi.mock("@/lib/payment-link", () => ({
  revokePaymentLinksForBooking: mocks.revokePaymentLinks,
}));
vi.mock("@/lib/booking-events", () => ({
  recordBookingEvent: mocks.recordBookingEvent,
}));
vi.mock("@/lib/email", () => ({
  sendBookingCancelledEmail: mocks.sendBookingCancelledEmail,
}));
vi.mock("@/lib/waitlist", () => ({
  processWaitlistForDates: mocks.processWaitlistForDates,
}));
vi.mock("@/lib/xero-operation-outbox", () => ({
  enqueueXeroRefundCreditNoteOperation: mocks.enqueueXeroRefund,
  kickQueuedXeroOutboxOperationsIfConnected: mocks.kickXero,
}));
vi.mock("@/lib/xero", () => ({ isXeroConnected: mocks.isXeroConnected }));
vi.mock("@/lib/payment-recovery", () => ({
  enqueueGroupSettlementRefundRecovery:
    mocks.enqueueGroupSettlementRefundRecovery,
  markGroupSettlementRefundRecoverySucceeded:
    mocks.markGroupSettlementRefundRecoverySucceeded,
}));
vi.mock("@/lib/audit", () => ({ logAudit: mocks.logAudit }));
vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

import {
  executeGroupSettlementRefundPlan,
  settleGroupBookingOnOrganiserCancel,
} from "@/lib/group-cancel";

const ORG_BOOKING = "org-booking-1";
const GROUP_ID = "group-1";
const ORGANISER = "organiser-1";
const CHECK_IN = new Date("2026-07-01");
const CHECK_OUT = new Date("2026-07-03");

function child(overrides: Record<string, unknown> = {}) {
  return {
    id: "child-1",
    memberId: "joiner-member-1",
    parentBookingId: ORG_BOOKING,
    status: BookingStatus.PAYMENT_PENDING,
    finalPriceCents: 4500,
    checkIn: CHECK_IN,
    checkOut: CHECK_OUT,
    organiserSettled: true,
    member: { email: "joiner@example.com", firstName: "Jo" },
    payment: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.transaction.mockImplementation(async (cb: (tx: typeof txClient) => unknown) =>
    cb(txClient)
  );
  mocks.bookingUpdate.mockResolvedValue(undefined);
  mocks.paymentUpdate.mockResolvedValue(undefined);
  mocks.groupBookingUpdate.mockResolvedValue(undefined);
  mocks.settlementUpdate.mockResolvedValue(undefined);
  mocks.reconcileBedAllocations.mockResolvedValue(undefined);
  mocks.revokePaymentLinks.mockResolvedValue(undefined);
  mocks.recordBookingEvent.mockResolvedValue(undefined);
  mocks.sendBookingCancelledEmail.mockResolvedValue(undefined);
  mocks.processWaitlistForDates.mockResolvedValue(undefined);
  mocks.enqueueXeroRefund.mockResolvedValue({ queueOperationId: null });
  mocks.kickXero.mockResolvedValue(undefined);
  mocks.isXeroConnected.mockResolvedValue(false);
  mocks.processRefund.mockResolvedValue({ id: "re_1", amount: 9000 });
  mocks.cancelPaymentIntentIfCancellable.mockResolvedValue(undefined);
  mocks.daysUntilDate.mockReturnValue(30);
  mocks.loadCancellationPolicy.mockResolvedValue([]);
  // Default: full policy refund (refund == amount paid).
  mocks.calculateRefundAmount.mockImplementation((amountCents: number) => ({
    refundAmountCents: amountCents,
    refundPercentage: 100,
  }));
  // F3 (#1351): durable retry plumbing defaults.
  mocks.paymentFindUnique.mockResolvedValue({ id: "org-payment-1" });
  mocks.paymentUpdateMany.mockResolvedValue({ count: 1 });
  mocks.settlementFindUnique.mockResolvedValue(null);
  mocks.bookingFindUnique.mockResolvedValue(null);
  mocks.enqueueGroupSettlementRefundRecovery.mockResolvedValue({
    id: "settlement-recovery-op-1",
  });
  mocks.markGroupSettlementRefundRecoverySucceeded.mockResolvedValue({
    count: 1,
  });
});

describe("settleGroupBookingOnOrganiserCancel", () => {
  it("is a no-op when the cancelled booking does not host a group", async () => {
    mocks.groupBookingFindUnique.mockResolvedValue(null);
    await settleGroupBookingOnOrganiserCancel(ORG_BOOKING, ORGANISER, "1.2.3.4");
    expect(mocks.bookingFindMany).not.toHaveBeenCalled();
    expect(mocks.groupBookingUpdate).not.toHaveBeenCalled();
    expect(mocks.processRefund).not.toHaveBeenCalled();
  });

  it("EACH_PAYS_OWN: closes the group and leaves joiner bookings intact", async () => {
    mocks.groupBookingFindUnique.mockResolvedValue({
      id: GROUP_ID,
      paymentMode: GroupBookingPaymentMode.EACH_PAYS_OWN,
      settlement: null,
    });
    await settleGroupBookingOnOrganiserCancel(ORG_BOOKING, ORGANISER, "1.2.3.4");
    expect(mocks.bookingFindMany).not.toHaveBeenCalled();
    expect(mocks.bookingUpdate).not.toHaveBeenCalled();
    expect(mocks.groupBookingUpdate).toHaveBeenCalledWith({
      where: { id: GROUP_ID },
      data: { status: GroupBookingStatus.CANCELLED },
    });
  });

  it("ORGANISER_PAYS unpaid: cancels children, releases beds, no refund", async () => {
    mocks.groupBookingFindUnique.mockResolvedValue({
      id: GROUP_ID,
      paymentMode: GroupBookingPaymentMode.ORGANISER_PAYS,
      settlement: null,
    });
    mocks.bookingFindMany.mockResolvedValue([
      child({ id: "child-1", status: BookingStatus.PAYMENT_PENDING }),
      child({ id: "child-2", status: BookingStatus.PAYMENT_PENDING }),
    ]);

    await settleGroupBookingOnOrganiserCancel(ORG_BOOKING, ORGANISER, "1.2.3.4");

    expect(mocks.processRefund).not.toHaveBeenCalled();
    expect(mocks.cancelPaymentIntentIfCancellable).not.toHaveBeenCalled();
    expect(mocks.bookingUpdate).toHaveBeenCalledTimes(2);
    expect(mocks.bookingUpdate).toHaveBeenCalledWith({
      where: { id: "child-1" },
      data: { status: BookingStatus.CANCELLED },
    });
    expect(mocks.reconcileBedAllocations).toHaveBeenCalledTimes(2);
    expect(mocks.sendBookingCancelledEmail).toHaveBeenCalledWith(
      "joiner@example.com",
      "Jo",
      CHECK_IN,
      CHECK_OUT,
      0,
      "card",
      0,
      undefined
    );
    expect(mocks.groupBookingUpdate).toHaveBeenCalledWith({
      where: { id: GROUP_ID },
      data: { status: GroupBookingStatus.CANCELLED },
    });
  });

  it("suppresses joiner cancellation emails when notifyMember is false, but still cancels and closes (#1705)", async () => {
    mocks.groupBookingFindUnique.mockResolvedValue({
      id: GROUP_ID,
      paymentMode: GroupBookingPaymentMode.ORGANISER_PAYS,
      settlement: null,
    });
    mocks.bookingFindMany.mockResolvedValue([
      child({ id: "child-1", status: BookingStatus.PAYMENT_PENDING }),
      child({ id: "child-2", status: BookingStatus.PAYMENT_PENDING }),
    ]);

    await settleGroupBookingOnOrganiserCancel(
      ORG_BOOKING,
      ORGANISER,
      "1.2.3.4",
      false
    );

    // The joiner cancellation emails are suppressed …
    expect(mocks.sendBookingCancelledEmail).not.toHaveBeenCalled();
    // … but the children are still cancelled, beds released, and the group closed.
    expect(mocks.bookingUpdate).toHaveBeenCalledTimes(2);
    expect(mocks.reconcileBedAllocations).toHaveBeenCalledTimes(2);
    expect(mocks.groupBookingUpdate).toHaveBeenCalledWith({
      where: { id: GROUP_ID },
      data: { status: GroupBookingStatus.CANCELLED },
    });
  });

  it("ORGANISER_PAYS settled: one refund, per-child Xero credit notes, children cancelled", async () => {
    mocks.groupBookingFindUnique.mockResolvedValue({
      id: GROUP_ID,
      paymentMode: GroupBookingPaymentMode.ORGANISER_PAYS,
      settlement: {
        id: "settle-1",
        status: PaymentStatus.SUCCEEDED,
        amountCents: 9000,
        stripePaymentIntentId: "pi_settle_1",
      },
    });
    mocks.bookingFindMany.mockResolvedValue([
      child({
        id: "child-1",
        status: BookingStatus.PAID,
        finalPriceCents: 4500,
        payment: { id: "pay-1", amountCents: 4500, refundedAmountCents: 0, status: PaymentStatus.SUCCEEDED },
      }),
      child({
        id: "child-2",
        status: BookingStatus.PAID,
        finalPriceCents: 4500,
        payment: { id: "pay-2", amountCents: 4500, refundedAmountCents: 0, status: PaymentStatus.SUCCEEDED },
      }),
    ]);

    await settleGroupBookingOnOrganiserCancel(ORG_BOOKING, ORGANISER, "1.2.3.4");

    // Exactly one Stripe refund for the combined total.
    expect(mocks.processRefund).toHaveBeenCalledTimes(1);
    expect(mocks.processRefund).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentIntentId: "pi_settle_1",
        amountCents: 9000,
      })
    );
    // Settlement marked fully refunded.
    expect(mocks.settlementUpdate).toHaveBeenCalledWith({
      where: { id: "settle-1" },
      data: { status: PaymentStatus.REFUNDED },
    });
    // Per-child Xero refund credit notes.
    expect(mocks.enqueueXeroRefund).toHaveBeenCalledTimes(2);
    expect(mocks.enqueueXeroRefund).toHaveBeenCalledWith("pay-1", 4500, {
      createdByMemberId: ORGANISER,
      store: txClient,
    });
    // Each child's payment marked refunded and booking cancelled.
    expect(mocks.paymentUpdate).toHaveBeenCalledWith({
      where: { id: "pay-1" },
      data: { refundedAmountCents: 4500, status: PaymentStatus.REFUNDED },
    });
    expect(mocks.bookingUpdate).toHaveBeenCalledWith({
      where: { id: "child-1" },
      data: { status: BookingStatus.CANCELLED },
    });
    // Joiners emailed with their refund amount.
    expect(mocks.sendBookingCancelledEmail).toHaveBeenCalledWith(
      "joiner@example.com",
      "Jo",
      CHECK_IN,
      CHECK_OUT,
      4500,
      "card",
      0,
      undefined
    );
    expect(mocks.groupBookingUpdate).toHaveBeenCalledWith({
      where: { id: GROUP_ID },
      data: { status: GroupBookingStatus.CANCELLED },
    });
  });

  it("Fix #3: keys the refund by the stable settlement id, not the tier-dependent amount", async () => {
    mocks.groupBookingFindUnique.mockResolvedValue({
      id: GROUP_ID,
      paymentMode: GroupBookingPaymentMode.ORGANISER_PAYS,
      settlement: {
        id: "settle-1",
        status: PaymentStatus.SUCCEEDED,
        amountCents: 9000,
        stripePaymentIntentId: "pi_settle_1",
      },
    });
    mocks.bookingFindMany.mockResolvedValue([
      child({
        id: "child-1",
        status: BookingStatus.PAID,
        finalPriceCents: 4500,
        payment: { id: "pay-1", amountCents: 4500, refundedAmountCents: 0, status: PaymentStatus.SUCCEEDED },
      }),
    ]);

    await settleGroupBookingOnOrganiserCancel(ORG_BOOKING, ORGANISER, "1.2.3.4");

    expect(mocks.processRefund).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: "group_cancel_refund_settle-1",
      })
    );
  });

  it("ORGANISER_PAYS mid-settlement: voids the open intent, fails the settlement, no refund", async () => {
    mocks.groupBookingFindUnique.mockResolvedValue({
      id: GROUP_ID,
      paymentMode: GroupBookingPaymentMode.ORGANISER_PAYS,
      settlement: {
        id: "settle-1",
        status: PaymentStatus.PENDING,
        amountCents: 9000,
        stripePaymentIntentId: "pi_settle_1",
      },
    });
    mocks.bookingFindMany.mockResolvedValue([
      child({ id: "child-1", status: BookingStatus.CONFIRMED }),
    ]);

    await settleGroupBookingOnOrganiserCancel(ORG_BOOKING, ORGANISER, "1.2.3.4");

    expect(mocks.cancelPaymentIntentIfCancellable).toHaveBeenCalledWith("pi_settle_1");
    expect(mocks.settlementUpdate).toHaveBeenCalledWith({
      where: { id: "settle-1" },
      data: { status: PaymentStatus.FAILED },
    });
    expect(mocks.processRefund).not.toHaveBeenCalled();
    expect(mocks.bookingUpdate).toHaveBeenCalledWith({
      where: { id: "child-1" },
      data: { status: BookingStatus.CANCELLED },
    });
    expect(mocks.sendBookingCancelledEmail).toHaveBeenCalledWith(
      "joiner@example.com",
      "Jo",
      CHECK_IN,
      CHECK_OUT,
      0,
      "card",
      0,
      undefined
    );
  });

  it("ORGANISER_PAYS settled with a late unpaid joiner: refunds only the paid child", async () => {
    mocks.groupBookingFindUnique.mockResolvedValue({
      id: GROUP_ID,
      paymentMode: GroupBookingPaymentMode.ORGANISER_PAYS,
      settlement: {
        id: "settle-1",
        status: PaymentStatus.SUCCEEDED,
        amountCents: 4500,
        stripePaymentIntentId: "pi_settle_1",
      },
    });
    mocks.bookingFindMany.mockResolvedValue([
      child({
        id: "paid-child",
        status: BookingStatus.PAID,
        finalPriceCents: 4500,
        payment: { id: "pay-1", amountCents: 4500, refundedAmountCents: 0, status: PaymentStatus.SUCCEEDED },
      }),
      // Joined after settlement; never charged.
      child({ id: "late-child", status: BookingStatus.PAYMENT_PENDING, finalPriceCents: 4500, payment: null }),
    ]);

    await settleGroupBookingOnOrganiserCancel(ORG_BOOKING, ORGANISER, "1.2.3.4");

    expect(mocks.processRefund).toHaveBeenCalledTimes(1);
    expect(mocks.processRefund).toHaveBeenCalledWith(
      expect.objectContaining({ amountCents: 4500 })
    );
    expect(mocks.settlementUpdate).toHaveBeenCalledWith({
      where: { id: "settle-1" },
      data: { status: PaymentStatus.REFUNDED },
    });
    // Only the paid child generated a Xero credit note.
    expect(mocks.enqueueXeroRefund).toHaveBeenCalledTimes(1);
    expect(mocks.enqueueXeroRefund).toHaveBeenCalledWith("pay-1", 4500, {
      createdByMemberId: ORGANISER,
      store: txClient,
    });
    // Both children cancelled and beds released.
    expect(mocks.bookingUpdate).toHaveBeenCalledTimes(2);
  });

  it("#1257/#1377: enqueues the per-child credit note INSIDE the child-cancel tx (store: tx), not post-commit", async () => {
    mocks.groupBookingFindUnique.mockResolvedValue({
      id: GROUP_ID,
      paymentMode: GroupBookingPaymentMode.ORGANISER_PAYS,
      settlement: {
        id: "settle-1",
        status: PaymentStatus.SUCCEEDED,
        amountCents: 4500,
        stripePaymentIntentId: "pi_settle_1",
      },
    });
    mocks.bookingFindMany.mockResolvedValue([
      child({
        id: "child-1",
        status: BookingStatus.PAID,
        finalPriceCents: 4500,
        payment: {
          id: "pay-1",
          amountCents: 4500,
          refundedAmountCents: 0,
          status: PaymentStatus.SUCCEEDED,
          source: PaymentSource.STRIPE,
        },
      }),
    ]);

    await settleGroupBookingOnOrganiserCancel(ORG_BOOKING, ORGANISER, "1.2.3.4");

    // The enqueue joined the SAME transaction client the booking cancel + refund
    // mirror ran on, so the outbox row commits atomically with the child cancel:
    // no crash window between the commit and a post-commit enqueue.
    expect(mocks.enqueueXeroRefund).toHaveBeenCalledTimes(1);
    expect(mocks.enqueueXeroRefund).toHaveBeenCalledWith("pay-1", 4500, {
      createdByMemberId: ORGANISER,
      store: txClient,
    });
    const [, , opts] = mocks.enqueueXeroRefund.mock.calls[0];
    expect(opts.store).toBe(txClient);
  });

  it("#1257/#1377: enqueues atomically for an Internet-Banking child (no per-child Xero invoice) — the residual this closes", async () => {
    mocks.groupBookingFindUnique.mockResolvedValue({
      id: GROUP_ID,
      paymentMode: GroupBookingPaymentMode.ORGANISER_PAYS,
      settlement: {
        id: "settle-1",
        status: PaymentStatus.SUCCEEDED,
        amountCents: 4500,
        stripePaymentIntentId: "pi_settle_1",
      },
    });
    mocks.bookingFindMany.mockResolvedValue([
      child({
        id: "ib-child",
        status: BookingStatus.PAID,
        finalPriceCents: 4500,
        payment: {
          id: "pay-ib",
          amountCents: 4500,
          refundedAmountCents: 0,
          status: PaymentStatus.SUCCEEDED,
          source: PaymentSource.INTERNET_BANKING,
        },
      }),
    ]);

    await settleGroupBookingOnOrganiserCancel(ORG_BOOKING, ORGANISER, "1.2.3.4");

    // Internet-Banking children carry no per-child xeroInvoiceId, so the #1354
    // daily reconcile self-heal cannot recover a dropped credit note for them.
    // The atomic enqueue removes the crash window for them too.
    expect(mocks.enqueueXeroRefund).toHaveBeenCalledWith("pay-ib", 4500, {
      createdByMemberId: ORGANISER,
      store: txClient,
    });
    const [, , opts] = mocks.enqueueXeroRefund.mock.calls[0];
    expect(opts.store).toBe(txClient);
  });

  it("enqueues no credit note for a child owed nothing (refundForChild > 0 gating preserved)", async () => {
    mocks.groupBookingFindUnique.mockResolvedValue({
      id: GROUP_ID,
      paymentMode: GroupBookingPaymentMode.ORGANISER_PAYS,
      settlement: null,
    });
    mocks.bookingFindMany.mockResolvedValue([
      child({ id: "child-1", status: BookingStatus.PAYMENT_PENDING }),
    ]);

    await settleGroupBookingOnOrganiserCancel(ORG_BOOKING, ORGANISER, "1.2.3.4");

    expect(mocks.enqueueXeroRefund).not.toHaveBeenCalled();
    // The child is still cancelled and its bed released.
    expect(mocks.bookingUpdate).toHaveBeenCalledWith({
      where: { id: "child-1" },
      data: { status: BookingStatus.CANCELLED },
    });
  });
});

describe("settleGroupBookingOnOrganiserCancel re-drivability (#1236)", () => {
  function paidChild(id: string, paymentId: string) {
    return child({
      id,
      status: BookingStatus.PAID,
      finalPriceCents: 4500,
      payment: {
        id: paymentId,
        amountCents: 4500,
        refundedAmountCents: 0,
        status: PaymentStatus.SUCCEEDED,
      },
    });
  }

  it("first run persists the refund plan before issuing the Stripe refund", async () => {
    mocks.groupBookingFindUnique.mockResolvedValue({
      id: GROUP_ID,
      paymentMode: GroupBookingPaymentMode.ORGANISER_PAYS,
      settlement: {
        id: "settle-1",
        status: PaymentStatus.SUCCEEDED,
        amountCents: 4500,
        stripePaymentIntentId: "pi_settle_1",
        refundPlan: null,
      },
    });
    mocks.bookingFindMany.mockResolvedValue([paidChild("child-1", "pay-1")]);

    await settleGroupBookingOnOrganiserCancel(ORG_BOOKING, ORGANISER, "1.2.3.4");

    // The plan (record of record) is persisted before any money moves.
    expect(mocks.settlementUpdate).toHaveBeenCalledWith({
      where: { id: "settle-1" },
      data: { refundPlan: { "child-1": 4500 } },
    });
    const persistCallIdx = mocks.settlementUpdate.mock.calls.findIndex(
      ([arg]) => arg?.data?.refundPlan !== undefined
    );
    const persistOrder =
      mocks.settlementUpdate.mock.invocationCallOrder[persistCallIdx];
    const refundOrder = mocks.processRefund.mock.invocationCallOrder[0];
    expect(persistOrder).toBeLessThan(refundOrder);
    expect(mocks.processRefund).toHaveBeenCalledTimes(1);
  });

  it("re-drive after the flip applies the plan mirror without a new refund", async () => {
    // Crash-after-flip: settlement already REFUNDED, plan persisted, the paid
    // child is still active (the child-loop had not reached it). This is the
    // core fix — the mirror must be reconstructed from the plan, not skipped.
    mocks.groupBookingFindUnique.mockResolvedValue({
      id: GROUP_ID,
      paymentMode: GroupBookingPaymentMode.ORGANISER_PAYS,
      settlement: {
        id: "settle-1",
        status: PaymentStatus.REFUNDED,
        amountCents: 4500,
        stripePaymentIntentId: "pi_settle_1",
        refundPlan: { "child-1": 4500 },
      },
    });
    mocks.bookingFindMany.mockResolvedValue([paidChild("child-1", "pay-1")]);

    await settleGroupBookingOnOrganiserCancel(ORG_BOOKING, ORGANISER, "1.2.3.4");

    // No new money move — the refund already ran on the interrupted first run.
    expect(mocks.processRefund).not.toHaveBeenCalled();
    // The plan is reused verbatim, never recomputed (policy never consulted).
    expect(mocks.calculateRefundAmount).not.toHaveBeenCalled();
    // The per-child mirror is still applied from the plan.
    expect(mocks.paymentUpdate).toHaveBeenCalledWith({
      where: { id: "pay-1" },
      data: { refundedAmountCents: 4500, status: PaymentStatus.REFUNDED },
    });
    expect(mocks.bookingUpdate).toHaveBeenCalledWith({
      where: { id: "child-1" },
      data: { status: BookingStatus.CANCELLED },
    });
    expect(mocks.enqueueXeroRefund).toHaveBeenCalledWith("pay-1", 4500, {
      createdByMemberId: ORGANISER,
      store: txClient,
    });
    expect(mocks.groupBookingUpdate).toHaveBeenCalledWith({
      where: { id: GROUP_ID },
      data: { status: GroupBookingStatus.CANCELLED },
    });
  });

  it("re-drive before the refund issues the refund once, then applies the plan", async () => {
    // Crash-after-persist-before-refund: plan set but settlement still SUCCEEDED.
    mocks.groupBookingFindUnique.mockResolvedValue({
      id: GROUP_ID,
      paymentMode: GroupBookingPaymentMode.ORGANISER_PAYS,
      settlement: {
        id: "settle-1",
        status: PaymentStatus.SUCCEEDED,
        amountCents: 4500,
        stripePaymentIntentId: "pi_settle_1",
        refundPlan: { "child-1": 4500 },
      },
    });
    mocks.bookingFindMany.mockResolvedValue([paidChild("child-1", "pay-1")]);

    await settleGroupBookingOnOrganiserCancel(ORG_BOOKING, ORGANISER, "1.2.3.4");

    // Reused, not recomputed.
    expect(mocks.calculateRefundAmount).not.toHaveBeenCalled();
    // The refund runs exactly once (Stripe dedups the retried key upstream).
    expect(mocks.processRefund).toHaveBeenCalledTimes(1);
    expect(mocks.processRefund).toHaveBeenCalledWith(
      expect.objectContaining({
        amountCents: 4500,
        idempotencyKey: "group_cancel_refund_settle-1",
      })
    );
    // Settlement flips, mirror applied.
    expect(mocks.settlementUpdate).toHaveBeenCalledWith({
      where: { id: "settle-1" },
      data: { status: PaymentStatus.REFUNDED },
    });
    expect(mocks.paymentUpdate).toHaveBeenCalledWith({
      where: { id: "pay-1" },
      data: { refundedAmountCents: 4500, status: PaymentStatus.REFUNDED },
    });
  });

  it("keeps the frozen plan and arms the durable retry when the refund fails (#1351)", async () => {
    mocks.groupBookingFindUnique.mockResolvedValue({
      id: GROUP_ID,
      paymentMode: GroupBookingPaymentMode.ORGANISER_PAYS,
      settlement: {
        id: "settle-1",
        status: PaymentStatus.SUCCEEDED,
        amountCents: 4500,
        stripePaymentIntentId: "pi_settle_1",
        refundPlan: { "child-1": 4500 },
      },
    });
    mocks.bookingFindMany.mockResolvedValue([paidChild("child-1", "pay-1")]);
    mocks.processRefund.mockRejectedValueOnce(new Error("stripe down"));

    await settleGroupBookingOnOrganiserCancel(ORG_BOOKING, ORGANISER, "1.2.3.4");

    // The frozen plan MUST survive: the retry executes the recorded tier.
    // (Pre-#1351 this branch nulled it, permanently abandoning the refund.)
    expect(mocks.settlementUpdate).not.toHaveBeenCalledWith({
      where: { id: "settle-1" },
      data: { refundPlan: Prisma.DbNull },
    });
    // The settlement stays SUCCEEDED until the replay refunds it.
    expect(mocks.settlementUpdate).not.toHaveBeenCalledWith({
      where: { id: "settle-1" },
      data: { status: PaymentStatus.REFUNDED },
    });
    // The durable retry: enqueued BEFORE the refund attempt (delayed), then
    // re-armed for immediate retry with the failure recorded.
    expect(mocks.enqueueGroupSettlementRefundRecovery).toHaveBeenCalledTimes(2);
    expect(mocks.enqueueGroupSettlementRefundRecovery).toHaveBeenNthCalledWith(1, {
      organiserBookingId: ORG_BOOKING,
      paymentId: "org-payment-1",
      settlementId: "settle-1",
      paymentIntentId: "pi_settle_1",
      amountCents: 4500,
      retryDelayMs: 10 * 60 * 1000,
    });
    expect(mocks.enqueueGroupSettlementRefundRecovery).toHaveBeenNthCalledWith(2, {
      organiserBookingId: ORG_BOOKING,
      paymentId: "org-payment-1",
      settlementId: "settle-1",
      paymentIntentId: "pi_settle_1",
      amountCents: 4500,
      retryDelayMs: 0,
      lastError: "stripe down",
    });
    expect(
      mocks.markGroupSettlementRefundRecoverySucceeded
    ).not.toHaveBeenCalled();
    // The child is still cancelled and its bed released, but with no refund
    // mirror yet — the replay writes it after the money actually moves.
    expect(mocks.bookingUpdate).toHaveBeenCalledWith({
      where: { id: "child-1" },
      data: { status: BookingStatus.CANCELLED },
    });
    expect(mocks.paymentUpdate).not.toHaveBeenCalled();
    expect(mocks.enqueueXeroRefund).not.toHaveBeenCalled();
    expect(mocks.sendBookingCancelledEmail).toHaveBeenCalledWith(
      "joiner@example.com",
      "Jo",
      CHECK_IN,
      CHECK_OUT,
      0,
      "card",
      0,
      undefined
    );
  });

  it("enqueues the durable retry before the inline refund and closes it after the flip (#1351)", async () => {
    mocks.groupBookingFindUnique.mockResolvedValue({
      id: GROUP_ID,
      paymentMode: GroupBookingPaymentMode.ORGANISER_PAYS,
      settlement: {
        id: "settle-1",
        status: PaymentStatus.SUCCEEDED,
        amountCents: 4500,
        stripePaymentIntentId: "pi_settle_1",
        refundPlan: null,
      },
    });
    mocks.bookingFindMany.mockResolvedValue([paidChild("child-1", "pay-1")]);

    await settleGroupBookingOnOrganiserCancel(ORG_BOOKING, ORGANISER, "1.2.3.4");

    expect(mocks.enqueueGroupSettlementRefundRecovery).toHaveBeenCalledTimes(1);
    expect(
      mocks.enqueueGroupSettlementRefundRecovery.mock.invocationCallOrder[0]
    ).toBeLessThan(mocks.processRefund.mock.invocationCallOrder[0]);
    expect(
      mocks.markGroupSettlementRefundRecoverySucceeded
    ).toHaveBeenCalledWith({ settlementId: "settle-1" });
    expect(
      mocks.markGroupSettlementRefundRecoverySucceeded.mock
        .invocationCallOrder[0]
    ).toBeGreaterThan(mocks.processRefund.mock.invocationCallOrder[0]);
  });

  it("skips malformed persisted refund-plan entries without throwing", async () => {
    mocks.groupBookingFindUnique.mockResolvedValue({
      id: GROUP_ID,
      paymentMode: GroupBookingPaymentMode.ORGANISER_PAYS,
      settlement: {
        id: "settle-1",
        status: PaymentStatus.REFUNDED,
        amountCents: 4500,
        stripePaymentIntentId: "pi_settle_1",
        // Only the valid integer entry survives; negative, non-integer and
        // non-numeric values are skipped.
        refundPlan: {
          "child-1": 4500,
          "child-neg": -1,
          "child-float": 1.5,
          "child-str": "9000",
        },
      },
    });
    mocks.bookingFindMany.mockResolvedValue([
      paidChild("child-1", "pay-1"),
      paidChild("child-neg", "pay-neg"),
    ]);

    await settleGroupBookingOnOrganiserCancel(ORG_BOOKING, ORGANISER, "1.2.3.4");

    expect(mocks.processRefund).not.toHaveBeenCalled();
    // Only the valid entry applies a mirror.
    expect(mocks.paymentUpdate).toHaveBeenCalledWith({
      where: { id: "pay-1" },
      data: { refundedAmountCents: 4500, status: PaymentStatus.REFUNDED },
    });
    expect(mocks.paymentUpdate).toHaveBeenCalledTimes(1);
    // Both children are still cancelled.
    expect(mocks.bookingUpdate).toHaveBeenCalledTimes(2);
  });

  it("treats an empty persisted refund plan as no refunds", async () => {
    mocks.groupBookingFindUnique.mockResolvedValue({
      id: GROUP_ID,
      paymentMode: GroupBookingPaymentMode.ORGANISER_PAYS,
      settlement: {
        id: "settle-1",
        status: PaymentStatus.REFUNDED,
        amountCents: 4500,
        stripePaymentIntentId: "pi_settle_1",
        refundPlan: {},
      },
    });
    mocks.bookingFindMany.mockResolvedValue([paidChild("child-1", "pay-1")]);

    await settleGroupBookingOnOrganiserCancel(ORG_BOOKING, ORGANISER, "1.2.3.4");

    expect(mocks.processRefund).not.toHaveBeenCalled();
    expect(mocks.paymentUpdate).not.toHaveBeenCalled();
    expect(mocks.bookingUpdate).toHaveBeenCalledWith({
      where: { id: "child-1" },
      data: { status: BookingStatus.CANCELLED },
    });
  });
});

// -----------------------------------------------------------------------------
// F3 (#1351): the recovery cron replays the settlement refund from the
// PERSISTED plan — frozen tier, same Stripe key, idempotent per-child mirrors.
// -----------------------------------------------------------------------------
describe("executeGroupSettlementRefundPlan (#1351)", () => {
  function settlement(overrides: Record<string, unknown> = {}) {
    return {
      id: "settle-1",
      groupBookingId: GROUP_ID,
      status: PaymentStatus.SUCCEEDED,
      amountCents: 9000,
      stripePaymentIntentId: "pi_settle_1",
      refundPlan: { "child-1": 4500, "child-2": 4500 },
      groupBooking: { id: GROUP_ID, status: GroupBookingStatus.CANCELLED },
      ...overrides,
    };
  }

  function cancelledChild(id: string, paymentId: string, refunded = 0) {
    return {
      id,
      memberId: `member-${id}`,
      status: BookingStatus.CANCELLED,
      payment: {
        id: paymentId,
        amountCents: 4500,
        refundedAmountCents: refunded,
        status: PaymentStatus.SUCCEEDED,
      },
    };
  }

  it("replays the refund under the inline Stripe key, flips the settlement, and applies the mirrors verbatim", async () => {
    mocks.settlementFindUnique.mockResolvedValue(settlement());
    mocks.bookingFindUnique
      .mockResolvedValueOnce(cancelledChild("child-1", "pay-1"))
      .mockResolvedValueOnce(cancelledChild("child-2", "pay-2"));
    // Simulate a >24h delay landing in a different tier: the executor must
    // never consult the policy machinery at all.
    mocks.daysUntilDate.mockReturnValue(0);

    const result = await executeGroupSettlementRefundPlan("settle-1");

    expect(result).toEqual({ outcome: "refunded", mirroredChildren: 2 });
    expect(mocks.processRefund).toHaveBeenCalledWith({
      paymentIntentId: "pi_settle_1",
      amountCents: 9000,
      metadata: { groupBookingId: GROUP_ID, reason: "organiser_cancellation" },
      // Identical to the inline key, so an ambiguous inline failure (Stripe
      // refunded, response lost) is replayed, never repeated.
      idempotencyKey: "group_cancel_refund_settle-1",
    });
    expect(mocks.settlementUpdate).toHaveBeenCalledWith({
      where: { id: "settle-1" },
      data: { status: PaymentStatus.REFUNDED },
    });
    // Frozen tier: the plan amounts are applied verbatim.
    expect(mocks.calculateRefundAmount).not.toHaveBeenCalled();
    // Conditional mirror writes: only where refundedAmountCents is still 0.
    expect(mocks.paymentUpdateMany).toHaveBeenCalledWith({
      where: { id: "pay-1", refundedAmountCents: 0 },
      data: {
        refundedAmountCents: 4500,
        status: PaymentStatus.REFUNDED,
      },
    });
    expect(mocks.paymentUpdateMany).toHaveBeenCalledWith({
      where: { id: "pay-2", refundedAmountCents: 0 },
      data: {
        refundedAmountCents: 4500,
        status: PaymentStatus.REFUNDED,
      },
    });
    expect(mocks.enqueueXeroRefund).toHaveBeenCalledWith("pay-1", 4500);
    expect(mocks.enqueueXeroRefund).toHaveBeenCalledWith("pay-2", 4500);
    expect(mocks.recordBookingEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        bookingId: "child-1",
        type: "REFUNDED",
        amountCents: 4500,
        actorMemberId: null,
      })
    );
  });

  it("completes the mirrors without a new refund when the settlement already flipped (crash-after-flip)", async () => {
    mocks.settlementFindUnique.mockResolvedValue(
      settlement({ status: PaymentStatus.REFUNDED })
    );
    mocks.bookingFindUnique
      .mockResolvedValueOnce(cancelledChild("child-1", "pay-1"))
      .mockResolvedValueOnce(cancelledChild("child-2", "pay-2", 4500));

    const result = await executeGroupSettlementRefundPlan("settle-1");

    expect(result).toEqual({ outcome: "already_refunded", mirroredChildren: 1 });
    expect(mocks.processRefund).not.toHaveBeenCalled();
    // child-2 was already mirrored (refunded > 0): skipped entirely.
    expect(mocks.paymentUpdateMany).toHaveBeenCalledTimes(1);
    expect(mocks.paymentUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "pay-1", refundedAmountCents: 0 } })
    );
    expect(mocks.enqueueXeroRefund).toHaveBeenCalledTimes(1);
  });

  it("leaves ACTIVE children to the inline loop / reaper resume path", async () => {
    mocks.settlementFindUnique.mockResolvedValue(
      settlement({ refundPlan: { "child-1": 4500 } })
    );
    mocks.bookingFindUnique.mockResolvedValueOnce({
      id: "child-1",
      memberId: "member-child-1",
      status: BookingStatus.CONFIRMED,
      payment: {
        id: "pay-1",
        amountCents: 4500,
        refundedAmountCents: 0,
        status: PaymentStatus.SUCCEEDED,
      },
    });

    const result = await executeGroupSettlementRefundPlan("settle-1");

    // The refund itself still executes (settlement was SUCCEEDED)...
    expect(result.outcome).toBe("refunded");
    // ...but the ACTIVE child's mirror is NOT touched here: the reaper's
    // re-drive cancels + mirrors it atomically, and a second write here
    // would double-apply.
    expect(result.mirroredChildren).toBe(0);
    expect(mocks.paymentUpdateMany).not.toHaveBeenCalled();
  });

  it("moves no money for a voided or failed settlement", async () => {
    mocks.settlementFindUnique.mockResolvedValue(
      settlement({ status: PaymentStatus.FAILED })
    );

    const result = await executeGroupSettlementRefundPlan("settle-1");

    expect(result).toEqual({ outcome: "not_refundable", mirroredChildren: 0 });
    expect(mocks.processRefund).not.toHaveBeenCalled();
    expect(mocks.paymentUpdateMany).not.toHaveBeenCalled();
  });

  it("throws on a Stripe failure so the recovery machinery applies backoff and exhaustion alerting", async () => {
    mocks.settlementFindUnique.mockResolvedValue(settlement());
    mocks.processRefund.mockRejectedValueOnce(new Error("stripe still down"));

    await expect(executeGroupSettlementRefundPlan("settle-1")).rejects.toThrow(
      "stripe still down"
    );
    expect(mocks.settlementUpdate).not.toHaveBeenCalled();
    expect(mocks.paymentUpdateMany).not.toHaveBeenCalled();
  });

  it("is a no-op for a missing settlement or an empty plan", async () => {
    mocks.settlementFindUnique.mockResolvedValueOnce(null);
    await expect(executeGroupSettlementRefundPlan("gone")).resolves.toEqual({
      outcome: "nothing_to_do",
      mirroredChildren: 0,
    });

    mocks.settlementFindUnique.mockResolvedValueOnce(
      settlement({ refundPlan: null })
    );
    await expect(executeGroupSettlementRefundPlan("settle-1")).resolves.toEqual({
      outcome: "nothing_to_do",
      mirroredChildren: 0,
    });
    expect(mocks.processRefund).not.toHaveBeenCalled();
  });
});
