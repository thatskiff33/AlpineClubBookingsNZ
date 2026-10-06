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
  settlementUpdateMany: vi.fn(),
  txExecuteRaw: vi.fn(),
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
  settlementAtFenceFindUnique: vi.fn(),
  bookingFindUnique: vi.fn(),
  enqueueGroupSettlementRefundRecovery: vi.fn(),
  markGroupSettlementRefundRecoverySucceeded: vi.fn(),
  enqueueXeroGroupSettlementVoid: vi.fn(),
  reconcileHostingReviewForSystemCancellation: vi.fn(),
  settleHostingCoverageAfterCommit: vi.fn(),
  planOrganiserCancelChildRefunds: vi.fn(),
  runPaymentRecoveryOperationNow: vi.fn(),
  recoveryOperationFindUnique: vi.fn(),
}));

const txClient = {
  $executeRaw: mocks.txExecuteRaw,
  groupBooking: { update: mocks.groupBookingUpdate },
  booking: { update: mocks.bookingUpdate, updateMany: mocks.bookingUpdate },
  payment: { update: mocks.paymentUpdate, updateMany: mocks.paymentUpdateMany },
  groupBookingSettlement: {
    updateMany: mocks.settlementUpdateMany,
    findUnique: mocks.settlementAtFenceFindUnique,
  },
};

// #3611/#3854: a child's cancellation lines, its plan's refund and the kept figure are proved in
// booking-ledger-cancellation.test.ts, booking-ledger-group-settlement-posting.test.ts and against PostgreSQL
// (booking-ledger-group-settlement.realdb.test.ts); here only the calls are observed.
const groupLedger = vi.hoisted(() => ({
  postGroupSettlementRefundLedgerLine: vi.fn<(input: unknown) => Promise<number>>(async () => 1),
  postGroupCancelChildLedgerLines: vi.fn<(tx: unknown, input: unknown) => Promise<void>>(async () => {}),
}));
vi.mock("@/lib/booking-ledger-group-settlement-sync", () => groupLedger);

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
    paymentRecoveryOperation: { findUnique: mocks.recoveryOperationFindUnique },
    // #3827 (composed by #3829): no open by-hand refund task on any child.
    manualRefundTask: { aggregate: vi.fn(async () => ({ _sum: { amountCents: null } })) },
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
  reconcileBedAllocationsForBookingWithGlobalLockHeld:
    mocks.reconcileBedAllocations,
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
  runPaymentRecoveryOperationNow: mocks.runPaymentRecoveryOperationNow,
}));
// #3653: the per-child planner is proved against PostgreSQL in
// organiser-child-refund.realdb.test.ts; here only its use is observed.
vi.mock("@/lib/organiser-child-refund", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/organiser-child-refund")),
  planOrganiserCancelChildRefunds: mocks.planOrganiserCancelChildRefunds,
}));
vi.mock("@/lib/xero-group-settlement-void-outbox", () => ({
  enqueueXeroGroupSettlementInvoiceVoidOperation:
    mocks.enqueueXeroGroupSettlementVoid,
}));
vi.mock("@/lib/adult-member-hosting-system-cancellation", () => ({
  reconcileHostingReviewForSystemCancellation:
    mocks.reconcileHostingReviewForSystemCancellation,
}));
vi.mock("@/lib/adult-member-hosting-coverage-drain", () => ({
  settleHostingCoverageAfterCommit: mocks.settleHostingCoverageAfterCommit,
}));
vi.mock("@/lib/audit", () => ({ logAudit: mocks.logAudit }));
vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

import {
  executeGroupSettlementRefundPlan,
  settleGroupBookingOnOrganiserCancel,
} from "@/lib/group-cancel";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";

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
  mocks.bookingUpdate.mockResolvedValue({ count: 1 });
  mocks.paymentUpdate.mockResolvedValue(undefined);
  mocks.paymentUpdateMany.mockResolvedValue({ count: 1 });
  mocks.groupBookingUpdate.mockResolvedValue(undefined);
  mocks.settlementUpdate.mockResolvedValue(undefined);
  mocks.settlementUpdateMany.mockResolvedValue({ count: 1 });
  mocks.settlementAtFenceFindUnique.mockImplementation(async () => {
    const initial = await mocks.groupBookingFindUnique.mock.results.at(-1)?.value;
    return initial?.settlement ?? null;
  });
  mocks.txExecuteRaw.mockResolvedValue(undefined);
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
  mocks.enqueueXeroGroupSettlementVoid.mockResolvedValue({
    queueOperationId: "void-op-1",
  });
  mocks.reconcileHostingReviewForSystemCancellation.mockResolvedValue(undefined);
  mocks.settleHostingCoverageAfterCommit.mockResolvedValue(undefined);
  mocks.planOrganiserCancelChildRefunds.mockResolvedValue(new Map());
  mocks.runPaymentRecoveryOperationNow.mockResolvedValue("succeeded");
  // A debt reads PENDING until the inline run has run it, then SUCCEEDED.
  mocks.recoveryOperationFindUnique.mockImplementation(async ({ where }: { where: { idempotencyKey: string } }) => {
    const id = `op-${where.idempotencyKey}`;
    const ran = mocks.runPaymentRecoveryOperationNow.mock.calls.some(([opId]) => opId === id);
    return { id, status: ran ? "SUCCEEDED" : "PENDING" };
  });
});

describe("settleGroupBookingOnOrganiserCancel", () => {
  it("is a no-op when the cancelled booking does not host a group", async () => {
    mocks.groupBookingFindUnique.mockResolvedValue(null);
    await settleGroupBookingOnOrganiserCancel(ORG_BOOKING, ORGANISER, "1.2.3.4", CLUB_FORMAT_TEST);
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
    await settleGroupBookingOnOrganiserCancel(ORG_BOOKING, ORGANISER, "1.2.3.4", CLUB_FORMAT_TEST);
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

    await settleGroupBookingOnOrganiserCancel(ORG_BOOKING, ORGANISER, "1.2.3.4", CLUB_FORMAT_TEST);

    expect(mocks.processRefund).not.toHaveBeenCalled();
    expect(mocks.cancelPaymentIntentIfCancellable).not.toHaveBeenCalled();
    expect(mocks.bookingUpdate).toHaveBeenCalledTimes(2);
    expect(mocks.bookingUpdate).toHaveBeenCalledWith({
      where: { id: "child-1", status: { in: [BookingStatus.PAYMENT_PENDING, BookingStatus.CONFIRMED, BookingStatus.PAID] } },
      data: {
        status: BookingStatus.CANCELLED,
        adminCapacityHoldAt: null,
        adminCapacityHoldByMemberId: null,
        wholeLodgeHold: false,
        wholeLodgeHoldAt: null,
        wholeLodgeHoldByMemberId: null,
      },
    });
    expect(mocks.reconcileBedAllocations).toHaveBeenCalledTimes(2);
    expect(mocks.sendBookingCancelledEmail).toHaveBeenCalledWith(
      { bookingId: "child-1", recipientMemberId: "joiner-member-1" },
      "joiner@example.com",
      "Jo",
      CHECK_IN,
      CHECK_OUT,
      0,
      CLUB_FORMAT_TEST,
      "card",
      0,
      undefined
    );
    expect(mocks.groupBookingUpdate).toHaveBeenCalledWith({
      where: { id: GROUP_ID },
      data: { status: GroupBookingStatus.CANCELLED },
    });
  });

  it("#3653 card settlement: one refund per paid child through its own debt; the child loop writes no mirror and no note", async () => {
    mocks.groupBookingFindUnique.mockResolvedValue({
      id: GROUP_ID,
      paymentMode: GroupBookingPaymentMode.ORGANISER_PAYS,
      settlement: {
        id: "settle-1",
        status: PaymentStatus.PARTIALLY_REFUNDED,
        amountCents: 9000,
        stripePaymentIntentId: "pi_settle_1",
        refundPlan: null,
      },
    });
    mocks.bookingFindMany.mockResolvedValue([
      child({
        id: "child-1",
        status: BookingStatus.PAID,
        finalPriceCents: 3000,
        payment: { id: "pay-1", amountCents: 4500, refundedAmountCents: 1500, status: PaymentStatus.PARTIALLY_REFUNDED },
      }),
      child({
        id: "child-2",
        status: BookingStatus.PAID,
        finalPriceCents: 4500,
        payment: { id: "pay-2", amountCents: 4500, refundedAmountCents: 0, status: PaymentStatus.SUCCEEDED },
      }),
    ]);
    mocks.planOrganiserCancelChildRefunds.mockResolvedValue(new Map([["child-1", 3000], ["child-2", 4500]]));

    await settleGroupBookingOnOrganiserCancel(ORG_BOOKING, ORGANISER, "1.2.3.4", CLUB_FORMAT_TEST);

    // A PARTIALLY_REFUNDED settlement (an edit already refunded child-1) is planned.
    expect(mocks.planOrganiserCancelChildRefunds).toHaveBeenCalledWith(
      expect.objectContaining({ settlementId: "settle-1", organiserBookingId: ORG_BOOKING, daysUntilCheckIn: 30 })
    );
    expect(mocks.runPaymentRecoveryOperationNow).toHaveBeenCalledWith(
      "op-organiser_child_refund_cancel_settle-1_child-1",
      CLUB_FORMAT_TEST
    );
    expect(mocks.runPaymentRecoveryOperationNow).toHaveBeenCalledWith(
      "op-organiser_child_refund_cancel_settle-1_child-2",
      CLUB_FORMAT_TEST
    );
    // No combined refund, no legacy recovery, no mirror or note from this loop.
    expect(mocks.processRefund).not.toHaveBeenCalled();
    expect(mocks.enqueueGroupSettlementRefundRecovery).not.toHaveBeenCalled();
    expect(mocks.paymentUpdate).not.toHaveBeenCalled();
    expect(mocks.enqueueXeroRefund).not.toHaveBeenCalled();
    expect(mocks.settlementUpdate).not.toHaveBeenCalled();
    // #3854: no mirror plan, so the per-child debts' refunds post from their
    // own refund rows and the kept figure reads every refund made or owed.
    expect(groupLedger.postGroupCancelChildLedgerLines).toHaveBeenCalledWith(
      txClient,
      expect.objectContaining({ mirrorPlan: false, settlement: expect.objectContaining({ stripePaymentIntentId: "pi_settle_1" }) }),
    );
    expect(mocks.bookingUpdate).toHaveBeenCalledTimes(2);
    // Joiners are told what their refund actually returned.
    expect(mocks.sendBookingCancelledEmail).toHaveBeenCalledWith(
      { bookingId: "child-1", recipientMemberId: "joiner-member-1" },
      "joiner@example.com",
      "Jo",
      CHECK_IN,
      CHECK_OUT,
      3000,
      CLUB_FORMAT_TEST,
      "card",
      0,
      undefined
    );
    // The executor recorded the REFUNDED event; the cancel records CANCELLED.
    expect(mocks.recordBookingEvent).toHaveBeenCalledWith(
      expect.objectContaining({ bookingId: "child-1", type: "CANCELLED" })
    );
  });

  it("#3653: a debt still owed after the inline run reads as nothing refunded yet, and stays owed", async () => {
    mocks.groupBookingFindUnique.mockResolvedValue({
      id: GROUP_ID,
      paymentMode: GroupBookingPaymentMode.ORGANISER_PAYS,
      settlement: { id: "settle-1", status: PaymentStatus.SUCCEEDED, amountCents: 4500, stripePaymentIntentId: "pi_settle_1", refundPlan: null },
    });
    mocks.bookingFindMany.mockResolvedValue([
      child({ id: "child-1", status: BookingStatus.PAID, payment: { id: "pay-1", amountCents: 4500, refundedAmountCents: 0, status: PaymentStatus.SUCCEEDED } }),
    ]);
    mocks.planOrganiserCancelChildRefunds.mockResolvedValue(new Map([["child-1", 4500]]));
    mocks.runPaymentRecoveryOperationNow.mockResolvedValue("failed");
    mocks.recoveryOperationFindUnique.mockResolvedValue({ id: "op-1", status: "FAILED" });

    await settleGroupBookingOnOrganiserCancel(ORG_BOOKING, ORGANISER, "1.2.3.4", CLUB_FORMAT_TEST);

    expect(mocks.runPaymentRecoveryOperationNow).toHaveBeenCalledWith("op-1", CLUB_FORMAT_TEST);
    expect(mocks.bookingUpdate).toHaveBeenCalledTimes(1);
    expect(mocks.paymentUpdate).not.toHaveBeenCalled();
    expect(mocks.sendBookingCancelledEmail).toHaveBeenCalledWith(
      expect.anything(), expect.anything(), expect.anything(), CHECK_IN, CHECK_OUT, 0,
      CLUB_FORMAT_TEST, "card", 0, undefined
    );
    // #3653 fix round: the refund is OWED, not "no payment taken". The
    // recovery that later makes it writes `booking.payment.refund_recovered`
    // (the executor's own suite).
    const childAudit = mocks.logAudit.mock.calls
      .map(([entry]) => entry as { targetId: string; details: string; metadata: Record<string, unknown> })
      .find((entry) => entry.targetId === "child-1");
    expect(childAudit?.details).toBe(
      "Group organiser cancelled; a refund of $45.00 to the organiser's card is owed and will be retried",
    );
    expect(childAudit?.metadata).toMatchObject({ refundForChild: 0, owedRefundForChild: 4500 });
  });

  it("#3653: a re-drive replays the frozen per-child plan and never re-plans or re-runs a closed debt", async () => {
    mocks.groupBookingFindUnique.mockResolvedValue({
      id: GROUP_ID,
      paymentMode: GroupBookingPaymentMode.ORGANISER_PAYS,
      settlement: {
        id: "settle-1",
        status: PaymentStatus.PARTIALLY_REFUNDED,
        amountCents: 9000,
        stripePaymentIntentId: "pi_settle_1",
        refundPlan: { perChildRefunds: { "child-1": 4500 } },
      },
    });
    mocks.bookingFindMany.mockResolvedValue([]);
    mocks.planOrganiserCancelChildRefunds.mockResolvedValue(new Map([["child-1", 4500]]));
    mocks.recoveryOperationFindUnique.mockResolvedValue({ id: "op-1", status: "SUCCEEDED" });

    await settleGroupBookingOnOrganiserCancel(ORG_BOOKING, ORGANISER, "1.2.3.4", CLUB_FORMAT_TEST);

    // The planner returns the frozen plan itself (proved against PostgreSQL);
    // a closed debt is not run again, and no legacy combined refund fires.
    expect(mocks.runPaymentRecoveryOperationNow).not.toHaveBeenCalled();
    expect(mocks.processRefund).not.toHaveBeenCalled();
  });

  it("Fix #3: a pre-#3653 plan keys its refund by the stable settlement id, not the tier-dependent amount", async () => {
    mocks.groupBookingFindUnique.mockResolvedValue({
      id: GROUP_ID,
      paymentMode: GroupBookingPaymentMode.ORGANISER_PAYS,
      settlement: {
        id: "settle-1",
        status: PaymentStatus.SUCCEEDED,
        amountCents: 9000,
        stripePaymentIntentId: "pi_settle_1",
        refundPlan: { "child-1": 4500 },
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

    await settleGroupBookingOnOrganiserCancel(ORG_BOOKING, ORGANISER, "1.2.3.4", CLUB_FORMAT_TEST);

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

    await settleGroupBookingOnOrganiserCancel(ORG_BOOKING, ORGANISER, "1.2.3.4", CLUB_FORMAT_TEST);

    expect(mocks.cancelPaymentIntentIfCancellable).toHaveBeenCalledWith("pi_settle_1");
    // #1881 — the FAILED claim is now a status-guarded updateMany under lock(1),
    // mirroring markGroupSettlementIntentFailed (never clobbers a terminal state).
    expect(mocks.settlementUpdateMany).toHaveBeenCalledWith({
      where: {
        id: "settle-1",
        stripePaymentIntentId: "pi_settle_1",
        status: PaymentStatus.PENDING,
      },
      data: { status: PaymentStatus.FAILED },
    });
    expect(mocks.processRefund).not.toHaveBeenCalled();
    expect(mocks.bookingUpdate).toHaveBeenCalledWith({
      where: { id: "child-1", status: { in: [BookingStatus.PAYMENT_PENDING, BookingStatus.CONFIRMED, BookingStatus.PAID] } },
      data: {
        status: BookingStatus.CANCELLED,
        adminCapacityHoldAt: null,
        adminCapacityHoldByMemberId: null,
        wholeLodgeHold: false,
        wholeLodgeHoldAt: null,
        wholeLodgeHoldByMemberId: null,
      },
    });
    expect(mocks.sendBookingCancelledEmail).toHaveBeenCalledWith(
      { bookingId: "child-1", recipientMemberId: "joiner-member-1" },
      "joiner@example.com",
      "Jo",
      CHECK_IN,
      CHECK_OUT,
      0,
      CLUB_FORMAT_TEST,
      "card",
      0,
      undefined
    );
  });

  it("persists the CANCELLED fence before releasing lock(1) for the provider void (#1881)", async () => {
    mocks.groupBookingFindUnique.mockResolvedValue({
      id: GROUP_ID,
      paymentMode: GroupBookingPaymentMode.ORGANISER_PAYS,
      settlement: {
        id: "settle-1",
        status: PaymentStatus.PENDING,
        amountCents: 9000,
        stripePaymentIntentId: "pi_settle_1",
        refundPlan: null,
      },
    });
    mocks.settlementFindUnique.mockResolvedValue({
      id: "settle-1",
      status: PaymentStatus.FAILED,
      amountCents: 9000,
      stripePaymentIntentId: "pi_settle_1",
      refundPlan: null,
    });
    mocks.bookingFindMany.mockResolvedValue([]);

    await settleGroupBookingOnOrganiserCancel(ORG_BOOKING, ORGANISER, "1.2.3.4", CLUB_FORMAT_TEST);

    expect(mocks.groupBookingUpdate).toHaveBeenCalledWith({
      where: { id: GROUP_ID },
      data: { status: GroupBookingStatus.CANCELLED },
    });
    expect(mocks.groupBookingUpdate.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.cancelPaymentIntentIfCancellable.mock.invocationCallOrder[0]
    );
  });

  it("#1881 settle-wins-mid-cancel: a concurrent settle captures under lock(1) between load and re-read — the owed refund FIRES, no phantom mirror", async () => {
    // The exact race the #1881 re-read was added for. The organiser cancel loads
    // the settlement while it is still PENDING; a concurrent settle then captures
    // the organiser's money under lock(1), flipping the settlement SUCCEEDED and
    // the children CONFIRMED -> PAID. The FAILED claim below is a no-op (the
    // settle already moved it to a terminal state, excluded by the notIn guard),
    // and the fresh re-read must see SUCCEEDED.
    //
    // Before the fix (stale in-memory status on the refund guard) this produced
    // the strictly-worse outcome: a refund plan computed + persisted, but the
    // refund block SKIPPED (no Stripe refund, no REFUNDED flip, no recovery),
    // while the child loop still wrote phantom refundedAmountCents mirrors for
    // money that never moved. Assert the corrected control flow: the refund
    // fires, the settlement flips REFUNDED, recovery is armed, and the per-child
    // mirror is only written AFTER the real refund.
    mocks.groupBookingFindUnique.mockResolvedValue({
      id: GROUP_ID,
      paymentMode: GroupBookingPaymentMode.ORGANISER_PAYS,
      // Initial load: still PENDING (the settle has not committed yet).
      settlement: {
        id: "settle-1",
        status: PaymentStatus.PENDING,
        amountCents: 9000,
        stripePaymentIntentId: "pi_settle_1",
        refundPlan: null,
      },
    });
    // The fresh re-read AFTER the guarded FAILED claim: the concurrent settle
    // won the race and captured the money.
    mocks.settlementFindUnique.mockResolvedValue({
      id: "settle-1",
      status: PaymentStatus.SUCCEEDED,
      amountCents: 9000,
      stripePaymentIntentId: "pi_settle_1",
      refundPlan: null,
    });
    // The settle already flipped the children CONFIRMED -> PAID and recorded
    // their per-child payments SUCCEEDED.
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

    await settleGroupBookingOnOrganiserCancel(ORG_BOOKING, ORGANISER, "1.2.3.4", CLUB_FORMAT_TEST);

    // The FAILED claim ran but was a no-op against the now-SUCCEEDED settlement
    // (the notIn guard excludes SUCCEEDED), so it never clobbered the capture.
    expect(mocks.settlementUpdateMany).toHaveBeenCalledWith({
      where: {
        id: "settle-1",
        stripePaymentIntentId: "pi_settle_1",
        status: PaymentStatus.PENDING,
      },
      data: { status: PaymentStatus.FAILED },
    });

    // The owed refunds FIRE (the core fix): the FRESH SUCCEEDED status drove
    // the per-child plan (#3653), and the loop wrote no mirror of its own.
    expect(mocks.planOrganiserCancelChildRefunds).toHaveBeenCalledWith(
      expect.objectContaining({ settlementId: "settle-1" })
    );
    expect(mocks.paymentUpdate).not.toHaveBeenCalled();
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
        // A pre-#3653 plan: its mirrors and notes are still this loop's.
        refundPlan: { "child-1": 4500 },
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

    await settleGroupBookingOnOrganiserCancel(ORG_BOOKING, ORGANISER, "1.2.3.4", CLUB_FORMAT_TEST);

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
        // An Internet Banking settlement: no card intent, so the club pays the
        // refund by hand and this loop writes the mirror and the note (#3653).
        stripePaymentIntentId: null,
        source: PaymentSource.INTERNET_BANKING,
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
          changeFeeCents: 0,
          source: PaymentSource.INTERNET_BANKING,
        },
      }),
    ]);

    await settleGroupBookingOnOrganiserCancel(ORG_BOOKING, ORGANISER, "1.2.3.4", CLUB_FORMAT_TEST);

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

  it("does not act on a settlement created after cancellation observed null under the fence", async () => {
    mocks.groupBookingFindUnique.mockResolvedValue({
      id: GROUP_ID,
      paymentMode: GroupBookingPaymentMode.ORGANISER_PAYS,
      settlement: null,
    });
    mocks.settlementAtFenceFindUnique.mockResolvedValue(null);
    mocks.settlementFindUnique.mockResolvedValue({
      id: "settle-late",
      status: PaymentStatus.PENDING,
      stripePaymentIntentId: "pi_late",
      amountCents: 4500,
    });
    mocks.bookingFindMany.mockResolvedValue([]);

    await settleGroupBookingOnOrganiserCancel(ORG_BOOKING, ORGANISER, "1.2.3.4", CLUB_FORMAT_TEST);

    expect(mocks.cancelPaymentIntentIfCancellable).not.toHaveBeenCalled();
    expect(mocks.settlementUpdateMany).not.toHaveBeenCalled();
    expect(mocks.settlementFindUnique).not.toHaveBeenCalled();
  });
  it("voids and fails the intent re-pointed before cancellation acquired lock(1)", async () => {
    mocks.groupBookingFindUnique.mockResolvedValue({
      id: GROUP_ID,
      paymentMode: GroupBookingPaymentMode.ORGANISER_PAYS,
      settlement: {
        id: "settle-1",
        status: PaymentStatus.PENDING,
        stripePaymentIntentId: "pi_stale",
        amountCents: 4500,
      },
    });
    mocks.settlementAtFenceFindUnique.mockResolvedValue({
      id: "settle-1",
      status: PaymentStatus.PENDING,
      stripePaymentIntentId: "pi_current",
      amountCents: 4500,
      refundPlan: null,
    });
    mocks.settlementFindUnique.mockResolvedValue({
      id: "settle-1",
      status: PaymentStatus.FAILED,
      stripePaymentIntentId: "pi_current",
      amountCents: 4500,
      refundPlan: null,
    });
    mocks.bookingFindMany.mockResolvedValue([]);

    await settleGroupBookingOnOrganiserCancel(ORG_BOOKING, ORGANISER, "1.2.3.4", CLUB_FORMAT_TEST);

    expect(mocks.cancelPaymentIntentIfCancellable).toHaveBeenCalledWith("pi_current");
    expect(mocks.cancelPaymentIntentIfCancellable).not.toHaveBeenCalledWith("pi_stale");
    expect(mocks.settlementUpdateMany).toHaveBeenCalledWith({
      where: {
        id: "settle-1",
        stripePaymentIntentId: "pi_current",
        status: PaymentStatus.PENDING,
      },
      data: { status: PaymentStatus.FAILED },
    });
  });

  it("atomically queues a durable Xero VOID when an ordinary later cancellation sees a persisted invoice", async () => {
    mocks.groupBookingFindUnique.mockResolvedValue({
      id: GROUP_ID,
      paymentMode: GroupBookingPaymentMode.ORGANISER_PAYS,
      settlement: null,
    });
    mocks.settlementAtFenceFindUnique.mockResolvedValue({
      id: "settle-ib",
      status: PaymentStatus.PENDING,
      stripePaymentIntentId: null,
      xeroInvoiceId: "inv-existing",
      xeroInvoiceNumber: "INV-EXISTING",
      amountCents: 4500,
      refundPlan: null,
    });
    mocks.bookingFindMany.mockResolvedValue([]);

    await settleGroupBookingOnOrganiserCancel(ORG_BOOKING, ORGANISER, "1.2.3.4", CLUB_FORMAT_TEST);

    expect(mocks.enqueueXeroGroupSettlementVoid).toHaveBeenCalledWith(
      "settle-ib",
      { createdByMemberId: ORGANISER, store: txClient }
    );
    expect(mocks.kickXero).toHaveBeenCalledWith({ limit: 1 });
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

    await settleGroupBookingOnOrganiserCancel(ORG_BOOKING, ORGANISER, "1.2.3.4", CLUB_FORMAT_TEST);

    expect(mocks.enqueueXeroRefund).not.toHaveBeenCalled();
    // The child is still cancelled and its bed released.
    expect(mocks.bookingUpdate).toHaveBeenCalledWith({
      where: { id: "child-1", status: { in: [BookingStatus.PAYMENT_PENDING, BookingStatus.CONFIRMED, BookingStatus.PAID] } },
      data: {
        status: BookingStatus.CANCELLED,
        adminCapacityHoldAt: null,
        adminCapacityHoldByMemberId: null,
        wholeLodgeHold: false,
        wholeLodgeHoldAt: null,
        wholeLodgeHoldByMemberId: null,
      },
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

  it("an Internet Banking settlement persists its plan before any mirror is written, and refunds nothing through Stripe (#3653)", async () => {
    mocks.groupBookingFindUnique.mockResolvedValue({
      id: GROUP_ID,
      paymentMode: GroupBookingPaymentMode.ORGANISER_PAYS,
      settlement: {
        id: "settle-1",
        status: PaymentStatus.SUCCEEDED,
        amountCents: 4500,
        stripePaymentIntentId: null,
        source: PaymentSource.INTERNET_BANKING,
        refundPlan: null,
      },
    });
    // An earlier edit's refund is already off this child: the plan sizes from
    // what remains (4500 - 1000), less the 500 change fee (`INV-PAY-018`).
    mocks.bookingFindMany.mockResolvedValue([
      child({
        id: "child-1",
        status: BookingStatus.PAID,
        finalPriceCents: 4000,
        payment: { id: "pay-1", amountCents: 4500, refundedAmountCents: 1000, changeFeeCents: 500, status: PaymentStatus.PARTIALLY_REFUNDED },
      }),
    ]);

    await settleGroupBookingOnOrganiserCancel(ORG_BOOKING, ORGANISER, "1.2.3.4", CLUB_FORMAT_TEST);

    expect(mocks.settlementUpdate).toHaveBeenCalledWith({
      where: { id: "settle-1" },
      data: { refundPlan: { "child-1": 3000 } },
    });
    const persistOrder = mocks.settlementUpdate.mock.invocationCallOrder[0];
    expect(persistOrder).toBeLessThan(mocks.paymentUpdate.mock.invocationCallOrder[0]);
    expect(mocks.paymentUpdate).toHaveBeenCalledWith({
      where: { id: "pay-1" },
      data: { refundedAmountCents: 4000, status: PaymentStatus.PARTIALLY_REFUNDED },
    });
    expect(mocks.processRefund).not.toHaveBeenCalled();
    expect(mocks.planOrganiserCancelChildRefunds).not.toHaveBeenCalled();
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

    await settleGroupBookingOnOrganiserCancel(ORG_BOOKING, ORGANISER, "1.2.3.4", CLUB_FORMAT_TEST);

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
      where: { id: "child-1", status: { in: [BookingStatus.PAYMENT_PENDING, BookingStatus.CONFIRMED, BookingStatus.PAID] } },
      data: {
        status: BookingStatus.CANCELLED,
        adminCapacityHoldAt: null,
        adminCapacityHoldByMemberId: null,
        wholeLodgeHold: false,
        wholeLodgeHoldAt: null,
        wholeLodgeHoldByMemberId: null,
      },
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

    await settleGroupBookingOnOrganiserCancel(ORG_BOOKING, ORGANISER, "1.2.3.4", CLUB_FORMAT_TEST);

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

  it("#3611/#3854: a paid child keeps its share less the plan's refund, which posts beside its mirror; an unpaid child keeps nothing", async () => {
    mocks.groupBookingFindUnique.mockResolvedValue({
      id: GROUP_ID,
      paymentMode: GroupBookingPaymentMode.ORGANISER_PAYS,
      settlement: {
        id: "settle-1",
        status: PaymentStatus.SUCCEEDED,
        amountCents: 4500,
        stripePaymentIntentId: "pi_settle_1",
        refundPlan: { "child-1": 2000 },
      },
    });
    mocks.bookingFindMany.mockResolvedValue([
      paidChild("child-1", "pay-1"),
      child({ id: "late-child", status: BookingStatus.PAYMENT_PENDING, finalPriceCents: 4500, payment: null }),
    ]);

    await settleGroupBookingOnOrganiserCancel(ORG_BOOKING, ORGANISER, "1.2.3.4", CLUB_FORMAT_TEST);

    expect(groupLedger.postGroupCancelChildLedgerLines).toHaveBeenCalledWith(txClient, {
      child: expect.objectContaining({ id: "child-1" }),
      settlement: expect.objectContaining({ id: "settle-1" }),
      mirrorPlan: true,
      refundForChild: 2000,
      plannedRefundCents: 2000,
    });
    expect(groupLedger.postGroupCancelChildLedgerLines).toHaveBeenCalledWith(txClient, {
      child: expect.objectContaining({ id: "late-child" }),
      settlement: expect.objectContaining({ id: "settle-1" }),
      mirrorPlan: true,
      refundForChild: 0,
      plannedRefundCents: 0,
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

    await settleGroupBookingOnOrganiserCancel(ORG_BOOKING, ORGANISER, "1.2.3.4", CLUB_FORMAT_TEST);

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
      where: { id: "child-1", status: { in: [BookingStatus.PAYMENT_PENDING, BookingStatus.CONFIRMED, BookingStatus.PAID] } },
      data: {
        status: BookingStatus.CANCELLED,
        adminCapacityHoldAt: null,
        adminCapacityHoldByMemberId: null,
        wholeLodgeHold: false,
        wholeLodgeHoldAt: null,
        wholeLodgeHoldByMemberId: null,
      },
    });
    expect(mocks.paymentUpdate).not.toHaveBeenCalled();
    expect(mocks.enqueueXeroRefund).not.toHaveBeenCalled();
    // #3854: no refund line until the replay makes the refund, but the kept
    // figure already counts the frozen plan's refund as owed.
    expect(groupLedger.postGroupCancelChildLedgerLines).toHaveBeenCalledWith(
      txClient,
      expect.objectContaining({ refundForChild: 0, plannedRefundCents: 4500 }),
    );
    expect(mocks.sendBookingCancelledEmail).toHaveBeenCalledWith(
      { bookingId: "child-1", recipientMemberId: "joiner-member-1" },
      "joiner@example.com",
      "Jo",
      CHECK_IN,
      CHECK_OUT,
      0,
      CLUB_FORMAT_TEST,
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
        refundPlan: { "child-1": 4500 }, // a pre-#3653 plan, re-driven
      },
    });
    mocks.bookingFindMany.mockResolvedValue([paidChild("child-1", "pay-1")]);

    await settleGroupBookingOnOrganiserCancel(ORG_BOOKING, ORGANISER, "1.2.3.4", CLUB_FORMAT_TEST);

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

    await settleGroupBookingOnOrganiserCancel(ORG_BOOKING, ORGANISER, "1.2.3.4", CLUB_FORMAT_TEST);

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

    await settleGroupBookingOnOrganiserCancel(ORG_BOOKING, ORGANISER, "1.2.3.4", CLUB_FORMAT_TEST);

    expect(mocks.processRefund).not.toHaveBeenCalled();
    expect(mocks.paymentUpdate).not.toHaveBeenCalled();
    expect(mocks.bookingUpdate).toHaveBeenCalledWith({
      where: { id: "child-1", status: { in: [BookingStatus.PAYMENT_PENDING, BookingStatus.CONFIRMED, BookingStatus.PAID] } },
      data: {
        status: BookingStatus.CANCELLED,
        adminCapacityHoldAt: null,
        adminCapacityHoldByMemberId: null,
        wholeLodgeHold: false,
        wholeLodgeHoldAt: null,
        wholeLodgeHoldByMemberId: null,
      },
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

    const result = await executeGroupSettlementRefundPlan("settle-1", CLUB_FORMAT_TEST);

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
    expect(mocks.enqueueXeroRefund).toHaveBeenCalledWith("pay-1", 4500, {
      store: txClient,
    });
    expect(mocks.enqueueXeroRefund).toHaveBeenCalledWith("pay-2", 4500, {
      store: txClient,
    });
    // #3854: the refund line the inline loop would have posted, beside each mirror.
    for (const bookingId of ["child-1", "child-2"]) {
      expect(groupLedger.postGroupSettlementRefundLedgerLine).toHaveBeenCalledWith(
        expect.objectContaining({ store: txClient, bookingId, refundCents: 4500, settlement: expect.objectContaining({ id: "settle-1" }) }),
      );
    }
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

    const result = await executeGroupSettlementRefundPlan("settle-1", CLUB_FORMAT_TEST);

    expect(result).toEqual({ outcome: "already_refunded", mirroredChildren: 1 });
    expect(mocks.processRefund).not.toHaveBeenCalled();
    // child-2 was already mirrored (refunded > 0): no second mirror or note,
    // but its ledger line still posts by the plan (#3854; keyed, so a no-op
    // where the inline loop already posted it).
    expect(groupLedger.postGroupSettlementRefundLedgerLine).toHaveBeenCalledWith(
      expect.objectContaining({ bookingId: "child-2", refundCents: 4500 }),
    );
    expect(mocks.paymentUpdateMany).toHaveBeenCalledTimes(1);
    expect(mocks.paymentUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "pay-1", refundedAmountCents: 0 } })
    );
    expect(mocks.enqueueXeroRefund).toHaveBeenCalledTimes(1);
    expect(mocks.enqueueXeroRefund).toHaveBeenCalledWith("pay-1", 4500, {
      store: txClient,
    });
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

    const result = await executeGroupSettlementRefundPlan("settle-1", CLUB_FORMAT_TEST);

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

    const result = await executeGroupSettlementRefundPlan("settle-1", CLUB_FORMAT_TEST);

    expect(result).toEqual({ outcome: "not_refundable", mirroredChildren: 0 });
    expect(mocks.processRefund).not.toHaveBeenCalled();
    expect(mocks.paymentUpdateMany).not.toHaveBeenCalled();
  });

  it("throws on a Stripe failure so the recovery machinery applies backoff and exhaustion alerting", async () => {
    mocks.settlementFindUnique.mockResolvedValue(settlement());
    mocks.processRefund.mockRejectedValueOnce(new Error("stripe still down"));

    await expect(executeGroupSettlementRefundPlan("settle-1", CLUB_FORMAT_TEST)).rejects.toThrow(
      "stripe still down"
    );
    expect(mocks.settlementUpdate).not.toHaveBeenCalled();
    expect(mocks.paymentUpdateMany).not.toHaveBeenCalled();
  });

  it("rolls back the refund mirror when durable Xero enqueue fails", async () => {
    mocks.settlementFindUnique.mockResolvedValue(
      settlement({ status: PaymentStatus.REFUNDED, refundPlan: { "child-1": 4500 } })
    );
    mocks.bookingFindUnique.mockResolvedValueOnce(
      cancelledChild("child-1", "pay-1")
    );
    mocks.enqueueXeroRefund.mockRejectedValueOnce(new Error("outbox unavailable"));

    await expect(executeGroupSettlementRefundPlan("settle-1", CLUB_FORMAT_TEST)).rejects.toThrow(
      "outbox unavailable"
    );
    expect(mocks.paymentUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "pay-1", refundedAmountCents: 0 } })
    );
    expect(mocks.enqueueXeroRefund).toHaveBeenCalledWith("pay-1", 4500, {
      store: txClient,
    });
  });

  it("is a no-op for a missing settlement or an empty plan", async () => {
    mocks.settlementFindUnique.mockResolvedValueOnce(null);
    await expect(executeGroupSettlementRefundPlan("gone", CLUB_FORMAT_TEST)).resolves.toEqual({
      outcome: "nothing_to_do",
      mirroredChildren: 0,
    });

    mocks.settlementFindUnique.mockResolvedValueOnce(
      settlement({ refundPlan: null })
    );
    await expect(executeGroupSettlementRefundPlan("settle-1", CLUB_FORMAT_TEST)).resolves.toEqual({
      outcome: "nothing_to_do",
      mirroredChildren: 0,
    });
    expect(mocks.processRefund).not.toHaveBeenCalled();
  });
});

describe("adult-member hosting on an organiser cancel (#3209)", () => {
  function organiserPaysGroup() {
    mocks.groupBookingFindUnique.mockResolvedValue({
      id: GROUP_ID,
      paymentMode: GroupBookingPaymentMode.ORGANISER_PAYS,
      settlement: null,
    });
  }

  it("reconciles hosting for every cancelled child, inside that child's own transaction", async () => {
    // The defect this closes: the beds were freed correctly and adult supervision
    // was never re-checked, so cancelling a CONFIRMED or PAID child could take the
    // qualifying adult off another booking of the SAME joiner with no incident, no
    // email and nothing in the officer queue.
    organiserPaysGroup();
    mocks.bookingFindMany.mockResolvedValue([
      child({ id: "child-1", status: BookingStatus.CONFIRMED }),
      child({ id: "child-2", status: BookingStatus.PAID }),
    ]);

    await settleGroupBookingOnOrganiserCancel(ORG_BOOKING, ORGANISER, "1.2.3.4", CLUB_FORMAT_TEST);

    expect(
      mocks.reconcileHostingReviewForSystemCancellation.mock.calls.map(
        (call: unknown[]) => call[0],
      ),
    ).toEqual(["child-1", "child-2"]);
    // The caller's own transaction client, so the obligation commits with the
    // cancellation rather than in a second connection that can be lost.
    for (const call of mocks.reconcileHostingReviewForSystemCancellation.mock
      .calls) {
      expect(call[1]).toBe(txClient);
    }
  });

  it("drains the coverage queue after each child commits, scoped to that child", async () => {
    // Scoped per child because the drain claims by owner and lodge, and every
    // joiner is a different owner: `booking-cancel.ts` drains the ORGANISER's
    // booking and can never reach them.
    organiserPaysGroup();
    mocks.bookingFindMany.mockResolvedValue([
      child({ id: "child-1", status: BookingStatus.CONFIRMED }),
      child({ id: "child-2", status: BookingStatus.CONFIRMED }),
    ]);

    await settleGroupBookingOnOrganiserCancel(ORG_BOOKING, ORGANISER, "1.2.3.4", CLUB_FORMAT_TEST);

    expect(mocks.settleHostingCoverageAfterCommit.mock.calls).toEqual([
      [{ bookingId: "child-1" }],
      [{ bookingId: "child-2" }],
    ]);
  });

  it("never reconciles or drains for a child whose status claim was lost", async () => {
    // A concurrent cancel already claimed it, so this run cancelled nothing and
    // owes no re-evaluation. Fan-out stays proportional to the children this run
    // really cancelled.
    organiserPaysGroup();
    mocks.bookingFindMany.mockResolvedValue([
      child({ id: "child-1", status: BookingStatus.CONFIRMED }),
    ]);
    mocks.bookingUpdate.mockResolvedValue({ count: 0 });

    await settleGroupBookingOnOrganiserCancel(ORG_BOOKING, ORGANISER, "1.2.3.4", CLUB_FORMAT_TEST);

    expect(
      mocks.reconcileHostingReviewForSystemCancellation,
    ).not.toHaveBeenCalled();
    expect(mocks.settleHostingCoverageAfterCommit).not.toHaveBeenCalled();
  });

  it("keeps one child's hosting failure from stopping the rest of the cleanup", async () => {
    // The seam asks for `REVIEW_ONLY`, so the hosting rule cannot refuse this at
    // all; what is left to reach here is a database failure or a participant
    // retry. It rolls that
    // child's transaction back exactly as any other in-transaction failure does —
    // the pre-existing best-effort `continue` — and the remaining children are
    // still cancelled, which is what "an organiser cancel always completes" means
    // for a loop.
    organiserPaysGroup();
    mocks.bookingFindMany.mockResolvedValue([
      child({ id: "child-1", status: BookingStatus.CONFIRMED }),
      child({ id: "child-2", status: BookingStatus.CONFIRMED }),
    ]);
    mocks.reconcileHostingReviewForSystemCancellation.mockRejectedValueOnce(
      new Error("participants contended"),
    );

    await expect(
      settleGroupBookingOnOrganiserCancel(ORG_BOOKING, ORGANISER, "1.2.3.4", CLUB_FORMAT_TEST),
    ).resolves.toBeUndefined();

    expect(mocks.reconcileHostingReviewForSystemCancellation).toHaveBeenCalledTimes(
      2,
    );
    expect(mocks.settleHostingCoverageAfterCommit.mock.calls).toEqual([
      [{ bookingId: "child-2" }],
    ]);
  });
});
