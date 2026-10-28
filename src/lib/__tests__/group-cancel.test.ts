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
  paymentFindUniqueOrThrowLocked: vi.fn(),
  settlementUpdate: vi.fn(),
  settlementUpdateMany: vi.fn(),
  txExecuteRaw: vi.fn(),
  transaction: vi.fn(),
  processRefund: vi.fn(),
  // #4103 review C3: the refusals Stripe holds on the intent, read before the replay asks.
  listRefundsForPaymentIntent: vi.fn(async (): Promise<unknown[]> => []),
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
  payment: { update: mocks.paymentUpdate, updateMany: mocks.paymentUpdateMany, findUniqueOrThrow: mocks.paymentFindUniqueOrThrowLocked },
  // #3949: the replay reads the child's paid-back hand-backs under its Payment row; none by default.
  manualRefundTask: { findMany: vi.fn(async () => [] as unknown[]) },
  // Review round 3: the latest CANCELLED event, whose snapshot marks a member's own cancel (none by default).
  bookingEvent: { findFirst: vi.fn(async (): Promise<unknown> => null) },
  // #4299: no extra-invoice cash rows on a child payment, and no invoice debts reserved by the plan, by default.
  paymentTransaction: { count: vi.fn(async () => 0) },
  xeroSyncOperation: { findFirst: vi.fn(async (): Promise<unknown> => null) },
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

// #4042: the hand-back's own rules (created, grown, supplemented; the row's
// shape, the alert's wording) are proved in group-organiser-hand-back.test.ts and
// against PostgreSQL (booking-ledger-group-settlement.realdb.test.ts); here only
// WHERE the organiser cancel books each share and WHEN it alerts.
const handBack = vi.hoisted(() => ({
  recordGroupOrganiserHandBackShare: vi.fn<(tx: unknown, input: unknown) => Promise<{ id: string; amountCents: number; created: boolean } | null>>(async () => null),
  alertUnsentGroupOrganiserHandBacks: vi.fn<(input: unknown) => Promise<void>>(async () => {}),
}));
vi.mock("@/lib/group-organiser-hand-back", () => handBack);

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
    bookingModification: { findMany: vi.fn(async () => []) },
    paymentRecoveryOperation: { findUnique: mocks.recoveryOperationFindUnique },
    // #3827 (composed by #3829): no open by-hand refund task on any child.
    manualRefundTask: { aggregate: vi.fn(async () => ({ _sum: { amountCents: null } })) },
    $transaction: mocks.transaction,
  },
}));
vi.mock("@/lib/stripe", () => ({
  processRefund: mocks.processRefund,
  listRefundsForPaymentIntent: mocks.listRefundsForPaymentIntent,
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
  // #3854 sync lens F2: the child's payment re-read under the claim's lock(1);
  // by default nothing moved it since the load.
  mocks.paymentFindUniqueOrThrowLocked.mockImplementation(async ({ where }: { where: { id: string } }) => {
    const loaded = (await mocks.bookingFindMany.mock.results.at(-1)?.value) as Array<{ payment: { id: string } | null }> | undefined;
    // #3949: the replay re-reads a child it loaded one at a time (`prisma.booking.findUnique`) under its Payment row.
    const replayed = await Promise.all(mocks.bookingFindUnique.mock.results.map((result) => result.value as Promise<{ payment: { id: string } | null } | null>));
    const payment = loaded?.find((row) => row.payment?.id === where.id)?.payment ?? replayed.find((row) => row?.payment?.id === where.id)?.payment;
    if (!payment) throw new Error(`no payment ${where.id}`);
    return payment;
  });
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
  // Found by its key, then (#3973) re-read by its id after the run.
  mocks.recoveryOperationFindUnique.mockImplementation(async ({ where }: { where: { idempotencyKey?: string; id?: string } }) => {
    const id = where.id ?? `op-${where.idempotencyKey}`;
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
      undefined,
      "cancellation-policy",
      0
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
    // Joiners are told what their refund actually returned, and (#3973) that it
    // went to the group organiser's card, not their own payment method.
    expect(mocks.sendBookingCancelledEmail).toHaveBeenCalledWith(
      { bookingId: "child-1", recipientMemberId: "joiner-member-1" },
      "joiner@example.com",
      "Jo",
      CHECK_IN,
      CHECK_OUT,
      3000,
      CLUB_FORMAT_TEST,
      "organiser_card",
      0,
      undefined,
      "cancellation-policy",
      3000
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
    // #3973: the email says the organiser's refund is on its way, never "No refund
    // was applicable"; `{{refundAmount}}` stays the 0 refunded, as before.
    expect(mocks.sendBookingCancelledEmail).toHaveBeenCalledWith(
      expect.anything(), expect.anything(), expect.anything(), CHECK_IN, CHECK_OUT, 0,
      CLUB_FORMAT_TEST, "organiser_card_pending", 0, undefined, "cancellation-policy", 4500
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
      undefined,
      "cancellation-policy",
      0
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
    // #3973: no card to refund; the club repays the organiser by hand, and the
    // joiner's email says so rather than "your original payment method".
    expect(mocks.sendBookingCancelledEmail).toHaveBeenCalledWith(
      { bookingId: "child-1", recipientMemberId: "joiner-member-1" },
      "joiner@example.com",
      "Jo",
      CHECK_IN,
      CHECK_OUT,
      3000,
      CLUB_FORMAT_TEST,
      "organiser_by_hand",
      0,
      undefined,
      "cancellation-policy",
      3000
    );
  });

  it("#3854 sync lens F2: an edit refund completed between the load and the claim is in the mirror and the kept figure, never overwritten", async () => {
    mocks.groupBookingFindUnique.mockResolvedValue({
      id: GROUP_ID,
      paymentMode: GroupBookingPaymentMode.ORGANISER_PAYS,
      settlement: {
        id: "settle-1",
        status: PaymentStatus.SUCCEEDED,
        amountCents: 4500,
        stripePaymentIntentId: null,
        source: PaymentSource.INTERNET_BANKING,
        refundPlan: { "child-1": 1750 },
      },
    });
    // Loaded before any lock with nothing refunded; by the claim's lock(1) the
    // treasurer has paid a $10 edit refund back (the plan was sized net of it).
    mocks.bookingFindMany.mockResolvedValue([paidChild("child-1", "pay-1")]);
    const fresh = { id: "pay-1", amountCents: 4500, refundedAmountCents: 1000, status: PaymentStatus.PARTIALLY_REFUNDED };
    mocks.paymentFindUniqueOrThrowLocked.mockResolvedValue(fresh);

    await settleGroupBookingOnOrganiserCancel(ORG_BOOKING, ORGANISER, "1.2.3.4", CLUB_FORMAT_TEST);

    // Read inside the claim: after its lock(1) and its status-guarded CANCELLED write.
    expect(mocks.paymentFindUniqueOrThrowLocked).toHaveBeenCalledWith({
      where: { id: "pay-1" },
      select: { id: true, status: true, amountCents: true, refundedAmountCents: true },
    });
    const claimAt = mocks.bookingUpdate.mock.calls.findIndex(([args]) => (args as { where: { id: string } }).where.id === "child-1");
    const readAt = mocks.paymentFindUniqueOrThrowLocked.mock.invocationCallOrder[0]!;
    expect(mocks.bookingUpdate.mock.invocationCallOrder[claimAt]).toBeLessThan(readAt);
    expect(mocks.txExecuteRaw.mock.invocationCallOrder.filter((at) => at < readAt).length).toBeGreaterThan(0);
    // The mirror adds the plan's $17.50 to the $10 already back, not to the stale $0.
    expect(mocks.paymentUpdate).toHaveBeenCalledWith({
      where: { id: "pay-1" },
      data: { refundedAmountCents: 2750, status: PaymentStatus.PARTIALLY_REFUNDED },
    });
    // The kept figure reads the same fresh payment.
    expect(groupLedger.postGroupCancelChildLedgerLines).toHaveBeenCalledWith(txClient, {
      child: expect.objectContaining({ id: "child-1", payment: fresh }),
      settlement: expect.objectContaining({ id: "settle-1" }),
      mirrorPlan: true,
      refundForChild: 1750,
      plannedRefundCents: 1750,
    });
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
    // #3973: a pre-#3653 plan's combined refund also went to the organiser's card.
    expect(mocks.sendBookingCancelledEmail).toHaveBeenCalledWith(
      expect.anything(), expect.anything(), expect.anything(), CHECK_IN, CHECK_OUT, 4500,
      CLUB_FORMAT_TEST, "organiser_card", 0, undefined, "cancellation-policy", 4500
    );
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

  // #4103 (`INV-PAY-130`): Stripe answers the legacy group refund `failed` or
  // `canceled` without throwing. Nothing went back, so it fails as a throw does:
  // no flip, no mirrors, the recovery row re-armed with the refusal.
  it.each([["failed"], ["canceled"]])("a refund Stripe answers %s is a failure: no flip, no mirror, the retry re-armed (#4103)", async (status) => {
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
    mocks.processRefund.mockResolvedValueOnce({ id: "re_refused", amount: 4500, status });

    await settleGroupBookingOnOrganiserCancel(ORG_BOOKING, ORGANISER, "1.2.3.4", CLUB_FORMAT_TEST);

    expect(mocks.settlementUpdate).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: expect.stringMatching(/REFUNDED/) }) }),
    );
    expect(mocks.enqueueGroupSettlementRefundRecovery).toHaveBeenLastCalledWith(
      expect.objectContaining({ settlementId: "settle-1", retryDelayMs: 0, lastError: expect.stringMatching(/Stripe refused \$45\.00 .*still owed/) }),
    );
    expect(mocks.markGroupSettlementRefundRecoverySucceeded).not.toHaveBeenCalled();
    expect(mocks.paymentUpdate).not.toHaveBeenCalled();
    expect(mocks.enqueueXeroRefund).not.toHaveBeenCalled();
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
    // #3973: the frozen plan's share is on its way to the organiser's card, not
    // "no refund"; `{{refundAmount}}` stays the 0 refunded, as before.
    expect(mocks.sendBookingCancelledEmail).toHaveBeenCalledWith(
      { bookingId: "child-1", recipientMemberId: "joiner-member-1" },
      "joiner@example.com",
      "Jo",
      CHECK_IN,
      CHECK_OUT,
      0,
      CLUB_FORMAT_TEST,
      "organiser_card_pending",
      0,
      undefined,
      "cancellation-policy",
      4500
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

  // #3949 (`INV-PAY-137`): an Internet Banking child's paid-back edit or appeal
  // hand-back moves its refunded total too, so "above zero" is no longer
  // "mirrored": the replay asks it net of those hand-backs, under the Payment row.
  it("mirrors a child whose total only a paid-back hand-back moved, and skips one whose plan share is written beside it (#3949)", async () => {
    mocks.settlementFindUnique.mockResolvedValue(settlement({ status: PaymentStatus.REFUNDED }));
    const paidBack = (paymentId: string) => [
      { kind: "CANCELLED_BOOKING_HAND_BACK", status: "COMPLETED", occurrenceKey: "edit-refund-hand-back:mod-1", paymentId, amountCents: 1000 },
    ];
    txClient.manualRefundTask.findMany.mockImplementation(async (args?: unknown) => paidBack((args as { where: { paymentId: string } }).where.paymentId));
    const child = (id: string, paymentId: string, refunded: number) => ({
      ...cancelledChild(id, paymentId, refunded),
      payment: { id: paymentId, amountCents: 9000, refundedAmountCents: refunded, status: PaymentStatus.PARTIALLY_REFUNDED },
    });
    mocks.bookingFindUnique
      .mockResolvedValueOnce(child("child-1", "pay-1", 1000))
      .mockResolvedValueOnce(child("child-2", "pay-2", 5500));

    const result = await executeGroupSettlementRefundPlan("settle-1", CLUB_FORMAT_TEST);

    expect(result).toEqual({ outcome: "already_refunded", mirroredChildren: 1 });
    // The hand-back's $10 stays; the plan's $45 goes on top, guarded on the figure read under the row lock.
    expect(mocks.paymentUpdateMany).toHaveBeenCalledTimes(1);
    expect(mocks.paymentUpdateMany).toHaveBeenCalledWith({
      where: { id: "pay-1", refundedAmountCents: 1000 },
      data: { refundedAmountCents: 5500, status: PaymentStatus.PARTIALLY_REFUNDED },
    });
    // The note and the event are this plan's share, never the hand-back's again.
    expect(mocks.enqueueXeroRefund).toHaveBeenCalledTimes(1);
    expect(mocks.enqueueXeroRefund).toHaveBeenCalledWith("pay-1", 4500, { store: txClient });
    expect(mocks.recordBookingEvent).toHaveBeenCalledWith(expect.objectContaining({ bookingId: "child-1", amountCents: 4500 }));
    // The Payment row first, then the read (a hand-back's completion holds that row before its claim).
    expect(mocks.txExecuteRaw).toHaveBeenCalled();
    expect(mocks.txExecuteRaw.mock.invocationCallOrder[0]).toBeLessThan(mocks.paymentFindUniqueOrThrowLocked.mock.invocationCallOrder[0]!);
    txClient.manualRefundTask.findMany.mockImplementation(async () => []);
  });

  it("review round 3: a plan child its member cancelled themselves is never mirrored by the replay; a review's or joiner cancel's refund is not the plan's", async () => {
    mocks.settlementFindUnique.mockResolvedValue(settlement({ status: PaymentStatus.REFUNDED }));
    mocks.bookingFindUnique
      .mockResolvedValueOnce(cancelledChild("child-1", "pay-1"))
      .mockResolvedValueOnce({ ...cancelledChild("child-2", "pay-2", 1000), payment: { id: "pay-2", amountCents: 9000, refundedAmountCents: 1000, status: PaymentStatus.PARTIALLY_REFUNDED } });
    // child-1 was cancelled by its member (a paid cancel's snapshot); child-2's $10 came from a completed review.
    txClient.bookingEvent.findFirst.mockImplementation(async (args?: unknown) =>
      (args as { where: { bookingId: string } }).where.bookingId === "child-1" ? { snapshot: { refundMethod: "card" } } : null,
    );
    txClient.manualRefundTask.findMany.mockImplementation(async (args?: unknown) =>
      (args as { where: { paymentId: string } }).where.paymentId === "pay-2"
        ? [{ kind: "EDIT_FINANCIAL_REVIEW", status: "COMPLETED", occurrenceKey: null, paymentId: "pay-2", amountCents: 1000, settlementDirection: "REFUND_TO_MEMBER" }]
        : [],
    );

    const result = await executeGroupSettlementRefundPlan("settle-1", CLUB_FORMAT_TEST);

    expect(result).toEqual({ outcome: "already_refunded", mirroredChildren: 1 });
    expect(mocks.paymentUpdateMany).toHaveBeenCalledTimes(1);
    expect(mocks.paymentUpdateMany).toHaveBeenCalledWith({
      where: { id: "pay-2", refundedAmountCents: 1000 },
      data: { refundedAmountCents: 5500, status: PaymentStatus.PARTIALLY_REFUNDED },
    });
    expect(groupLedger.postGroupSettlementRefundLedgerLine).not.toHaveBeenCalledWith(expect.objectContaining({ bookingId: "child-1" }));
    txClient.bookingEvent.findFirst.mockImplementation(async () => null);
    txClient.manualRefundTask.findMany.mockImplementation(async () => []);
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

  // #4103 (`INV-PAY-130`): a refusal fails the attempt, so the runner never
  // closes the row on it, and its backoff asks again.
  it.each([["failed"], ["canceled"]])("throws on a refund Stripe answers %s: no flip, no mirror (#4103)", async (status) => {
    mocks.settlementFindUnique.mockResolvedValue(settlement());
    mocks.processRefund.mockResolvedValueOnce({ id: "re_refused", amount: 9000, status });

    await expect(executeGroupSettlementRefundPlan("settle-1", CLUB_FORMAT_TEST)).rejects.toThrow(/Stripe refused \$90\.00 .*still owed/);
    expect(mocks.settlementUpdate).not.toHaveBeenCalled();
    expect(mocks.paymentUpdateMany).not.toHaveBeenCalled();
  });

  // #4103 review C3: Stripe answers a repeated key with its cached refusal for
  // 24 hours, so the replay's key moves on once for each refusal Stripe holds on
  // the intent for this refund (same amount, same reason).
  it("asks past the refusals Stripe holds for this refund, on a key it has never seen (#4103)", async () => {
    mocks.settlementFindUnique.mockResolvedValue(settlement());
    mocks.listRefundsForPaymentIntent.mockResolvedValueOnce([
      { id: "re_1", status: "failed", amount: 9000, metadata: { groupBookingId: GROUP_ID, reason: "organiser_cancellation" } },
      { id: "re_2", status: "canceled", amount: 9000, metadata: { groupBookingId: GROUP_ID, reason: "organiser_cancellation" } },
      { id: "re_3", status: "failed", amount: 4000, metadata: { groupBookingId: GROUP_ID, reason: "organiser_cancellation" } },
      { id: "re_4", status: "failed", amount: 9000, metadata: { groupBookingId: GROUP_ID, reason: "something_else" } },
    ]);

    await executeGroupSettlementRefundPlan("settle-1", CLUB_FORMAT_TEST);

    expect(mocks.processRefund).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: "group_cancel_refund_settle-1_refused2" }));
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

describe("#4042: an organiser's Internet Banking group cancel books each share on the organiser's hand-back", () => {
  const CREATED = { id: "task-1", amountCents: 4500, created: true };
  const GROWN = { id: "task-1", amountCents: 7500, created: false };

  function ibGroup(overrides: Record<string, unknown> = {}) {
    mocks.groupBookingFindUnique.mockResolvedValue({
      id: GROUP_ID,
      paymentMode: GroupBookingPaymentMode.ORGANISER_PAYS,
      settlement: {
        id: "settle-ib",
        status: PaymentStatus.SUCCEEDED,
        amountCents: 9000,
        stripePaymentIntentId: null,
        source: PaymentSource.INTERNET_BANKING,
        refundPlan: null,
        ...overrides,
      },
    });
  }
  function paid(id: string, paymentId: string) {
    return child({
      id,
      status: BookingStatus.PAID,
      finalPriceCents: 4500,
      payment: { id: paymentId, amountCents: 4500, refundedAmountCents: 0, changeFeeCents: 0, status: PaymentStatus.SUCCEEDED },
    });
  }

  it("books each refunded child's share inside its own claim, after its mirror; the run that created the task alerts ONCE, after the children", async () => {
    ibGroup();
    mocks.bookingFindMany.mockResolvedValue([paid("child-1", "pay-1"), paid("child-2", "pay-2")]);
    mocks.calculateRefundAmount.mockReturnValueOnce({ refundAmountCents: 4500, refundPercentage: 100 }).mockReturnValueOnce({ refundAmountCents: 3000, refundPercentage: 66 });
    handBack.recordGroupOrganiserHandBackShare.mockResolvedValueOnce(CREATED).mockResolvedValueOnce(GROWN);

    await settleGroupBookingOnOrganiserCancel(ORG_BOOKING, ORGANISER, "1.2.3.4", CLUB_FORMAT_TEST);

    const plan = new Map([["child-1", 4500], ["child-2", 3000]]);
    expect(handBack.recordGroupOrganiserHandBackShare.mock.calls).toEqual([
      [txClient, { settlementId: "settle-ib", organiserBookingId: ORG_BOOKING, plan, claimedChildId: "child-1", format: CLUB_FORMAT_TEST }],
      [txClient, { settlementId: "settle-ib", organiserBookingId: ORG_BOOKING, plan, claimedChildId: "child-2", format: CLUB_FORMAT_TEST }],
    ]);
    // In the claim, after the mirror and its note: one commit or none.
    const [firstShare, secondShare] = handBack.recordGroupOrganiserHandBackShare.mock.invocationCallOrder;
    expect(mocks.paymentUpdate.mock.invocationCallOrder[0]).toBeLessThan(firstShare!);
    expect(mocks.enqueueXeroRefund.mock.invocationCallOrder[0]).toBeLessThan(firstShare!);
    // The alert sweep runs once, after every child - it sends any unsent alert, re-reading the final total.
    expect(handBack.alertUnsentGroupOrganiserHandBacks).toHaveBeenCalledTimes(1);
    expect(handBack.alertUnsentGroupOrganiserHandBacks).toHaveBeenCalledWith({ settlementId: "settle-ib", organiserBookingId: ORG_BOOKING, format: CLUB_FORMAT_TEST });
    const [alerted] = handBack.alertUnsentGroupOrganiserHandBacks.mock.invocationCallOrder;
    expect(alerted!).toBeGreaterThan(secondShare!);
    expect(alerted!).toBeGreaterThan(mocks.settleHostingCoverageAfterCommit.mock.invocationCallOrder.at(-1)!);
    const childAudits = mocks.logAudit.mock.calls.map(([entry]) => entry as { targetId: string; metadata: { organiserHandBackTaskId: string | null } });
    expect(childAudits.map((entry) => [entry.targetId, entry.metadata.organiserHandBackTaskId])).toEqual([
      ["child-1", "task-1"],
      ["child-2", "task-1"],
    ]);
  });

  it("a joiner cancelled another way between the two claims adds no share: the task holds only what this cancel booked", async () => {
    ibGroup();
    mocks.bookingFindMany.mockResolvedValue([paid("child-1", "pay-1"), paid("child-2", "pay-2")]);
    handBack.recordGroupOrganiserHandBackShare.mockResolvedValueOnce(CREATED);
    // child-2's status claim finds it already cancelled by someone else.
    mocks.bookingUpdate.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });

    await settleGroupBookingOnOrganiserCancel(ORG_BOOKING, ORGANISER, "1.2.3.4", CLUB_FORMAT_TEST);

    expect(handBack.recordGroupOrganiserHandBackShare).toHaveBeenCalledTimes(1);
    expect(handBack.recordGroupOrganiserHandBackShare.mock.calls[0]![1]).toMatchObject({ claimedChildId: "child-1" });
    expect(handBack.alertUnsentGroupOrganiserHandBacks).toHaveBeenCalledTimes(1);
  });

  it("a run whose claim only grows the task still runs the sweep once; whether to send is the task's own record", async () => {
    ibGroup({ refundPlan: { "child-2": 3000 } });
    mocks.bookingFindMany.mockResolvedValue([paid("child-2", "pay-2")]);
    handBack.recordGroupOrganiserHandBackShare.mockResolvedValueOnce(GROWN);

    await settleGroupBookingOnOrganiserCancel(ORG_BOOKING, ORGANISER, "1.2.3.4", CLUB_FORMAT_TEST);

    expect(handBack.recordGroupOrganiserHandBackShare).toHaveBeenCalledTimes(1);
    expect(handBack.alertUnsentGroupOrganiserHandBacks).toHaveBeenCalledTimes(1);
    expect(handBack.alertUnsentGroupOrganiserHandBacks).toHaveBeenCalledWith({ settlementId: "settle-ib", organiserBookingId: ORG_BOOKING, format: CLUB_FORMAT_TEST });
  });

  it("a claim that rolls back still leaves the sweep to run once, after the loop and outside its transaction", async () => {
    ibGroup();
    mocks.bookingFindMany.mockResolvedValue([paid("child-1", "pay-1")]);
    handBack.recordGroupOrganiserHandBackShare.mockResolvedValueOnce(CREATED);
    mocks.reconcileHostingReviewForSystemCancellation.mockRejectedValueOnce(new Error("hosting failed"));

    await settleGroupBookingOnOrganiserCancel(ORG_BOOKING, ORGANISER, "1.2.3.4", CLUB_FORMAT_TEST);

    expect(handBack.recordGroupOrganiserHandBackShare).toHaveBeenCalledTimes(1);
    // The rolled-back claim's task does not exist, so the sweep finds nothing to send.
    expect(handBack.alertUnsentGroupOrganiserHandBacks).toHaveBeenCalledTimes(1);
    expect(handBack.alertUnsentGroupOrganiserHandBacks.mock.invocationCallOrder[0]!).toBeGreaterThan(mocks.reconcileHostingReviewForSystemCancellation.mock.invocationCallOrder[0]!);
  });

  it("an exception that escapes the loop after the task was created still sends its alert", async () => {
    ibGroup();
    mocks.bookingFindMany.mockResolvedValue([paid("child-1", "pay-1"), paid("child-2", "pay-2")]);
    handBack.recordGroupOrganiserHandBackShare.mockResolvedValueOnce(CREATED).mockResolvedValueOnce(GROWN);
    mocks.settleHostingCoverageAfterCommit.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("coverage drain crashed"));

    await expect(settleGroupBookingOnOrganiserCancel(ORG_BOOKING, ORGANISER, "1.2.3.4", CLUB_FORMAT_TEST)).rejects.toThrow("coverage drain crashed");

    expect(handBack.alertUnsentGroupOrganiserHandBacks).toHaveBeenCalledTimes(1);
    expect(handBack.alertUnsentGroupOrganiserHandBacks).toHaveBeenCalledWith({ settlementId: "settle-ib", organiserBookingId: ORG_BOOKING, format: CLUB_FORMAT_TEST });
  });

  it("books nothing for a card settlement, an unsettled group, or a child the policy refunds nothing", async () => {
    // A card settlement (#3653): per-child Stripe refunds, no mirror in this loop.
    ibGroup({ stripePaymentIntentId: "pi_settle", source: PaymentSource.STRIPE });
    mocks.bookingFindMany.mockResolvedValue([paid("child-1", "pay-1")]);
    mocks.planOrganiserCancelChildRefunds.mockResolvedValue(new Map([["child-1", 4500]]));
    await settleGroupBookingOnOrganiserCancel(ORG_BOOKING, ORGANISER, "1.2.3.4", CLUB_FORMAT_TEST);

    // A pre-#3653 card plan finished the old way: a Stripe refund, not a hand-back.
    ibGroup({ stripePaymentIntentId: "pi_legacy", source: PaymentSource.STRIPE, refundPlan: { "child-1": 4500 } });
    mocks.bookingFindMany.mockResolvedValue([paid("child-1", "pay-1")]);
    await settleGroupBookingOnOrganiserCancel(ORG_BOOKING, ORGANISER, "1.2.3.4", CLUB_FORMAT_TEST);
    expect(mocks.processRefund).toHaveBeenCalledTimes(1);

    // An Internet Banking settlement nobody has paid yet.
    ibGroup({ status: PaymentStatus.PENDING });
    mocks.bookingFindMany.mockResolvedValue([child({ id: "child-1", status: BookingStatus.CONFIRMED })]);
    await settleGroupBookingOnOrganiserCancel(ORG_BOOKING, ORGANISER, "1.2.3.4", CLUB_FORMAT_TEST);

    // Paid, but inside the no-refund tier.
    ibGroup();
    mocks.bookingFindMany.mockResolvedValue([paid("child-1", "pay-1")]);
    mocks.calculateRefundAmount.mockReturnValueOnce({ refundAmountCents: 0, refundPercentage: 0 });
    await settleGroupBookingOnOrganiserCancel(ORG_BOOKING, ORGANISER, "1.2.3.4", CLUB_FORMAT_TEST);

    expect(handBack.recordGroupOrganiserHandBackShare).not.toHaveBeenCalled();
    // Only the Internet Banking groups run the sweep; a card group never does.
    expect(handBack.alertUnsentGroupOrganiserHandBacks.mock.calls.map(([input]) => input)).toEqual([
      { settlementId: "settle-ib", organiserBookingId: ORG_BOOKING, format: CLUB_FORMAT_TEST },
      { settlementId: "settle-ib", organiserBookingId: ORG_BOOKING, format: CLUB_FORMAT_TEST },
    ]);
  });
});
