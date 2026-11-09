/**
 * #3956 (`INV-PAY-123`): approving a refund appeal on a joiner's booking the
 * group organiser paid for by card refunds it out of the organiser's combined
 * card payment (#3653, `INV-PAY-114`) - never the $0 "refund" plus a full Xero
 * note and a "your refund is on its way" email it used to send.
 *
 * Owner decision (13 Oct 2026, recorded on #3956): refund to the organiser's
 * card through the #3653 path; email the joiner AND the organiser; refuse an
 * approval the combined payment cannot cover, naming what it still can.
 *
 * The real-PostgreSQL half (the debt, the refund row, the executor's Xero note,
 * the headroom race) is `organiser-child-refund.realdb.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  refundRequestFindUnique: vi.fn(),
  refundRequestUpdateMany: vi.fn(),
  lockedRefundRequestFindUnique: vi.fn(),
  bookingFindUnique: vi.fn(),
  paymentFindUnique: vi.fn(),
  executeRaw: vi.fn(),
  // #4124 review F2: the Payment row, taken after lock(1) and before the cap's reads.
  lockPaymentForRefundedTotal: vi.fn(),
  manualRefundTaskAggregate: vi.fn(),
  memberCreditAggregate: vi.fn(),
  transaction: vi.fn(),
  refundPaymentTransactions: vi.fn(),
  planStripeRefundAllocation: vi.fn(),
  enqueueRefundRequestRefundRecovery: vi.fn(),
  isXeroConnected: vi.fn(),
  enqueueXeroRefundCreditNoteOperation: vi.fn(),
  kickQueuedXeroOutboxOperationsIfConnected: vi.fn(),
  sendEmail: vi.fn(),
  sendGroupOrganiserJoinerRefundEmail: vi.fn(),
  createAuditLog: vi.fn(),
  loggerError: vi.fn(),
  organiserCardAppealCap: vi.fn(),
  reserveOrganiserChildAppealRefund: vi.fn(),
  runOrganiserChildRefundDebtNow: vi.fn(),
}));

// #4516 (M4c): R05 posts on PostgreSQL (`member-money-refunds.realdb.test.ts`), not on this fake store.
vi.mock("@/lib/member-money/doors", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/member-money/doors")),
  postRefundObligation: vi.fn(async () => null),
  withdrawRefundObligation: vi.fn(async () => false),
}));

vi.mock("@/lib/auth", () => ({ auth: mocks.auth }));
vi.mock("@/lib/session-guards", async () => ({
  requireAdmin: (await import("./helpers/require-admin-mock")).evaluateRequireAdminMock,
  requireActiveSessionUser: vi.fn().mockResolvedValue(null),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    refundRequest: { findUnique: mocks.refundRequestFindUnique, updateMany: mocks.refundRequestUpdateMany },
    booking: { findUnique: mocks.bookingFindUnique },
    $transaction: mocks.transaction,
  },
}));
vi.mock("@/lib/audit", () => ({ createAuditLog: mocks.createAuditLog }));
vi.mock("@/lib/xero", () => ({ isXeroConnected: mocks.isXeroConnected }));
vi.mock("@/lib/xero-operation-outbox", () => ({
  enqueueXeroRefundCreditNoteOperation: mocks.enqueueXeroRefundCreditNoteOperation,
  kickQueuedXeroOutboxOperationsIfConnected: mocks.kickQueuedXeroOutboxOperationsIfConnected,
}));
vi.mock("@/lib/email", () => ({
  sendEmail: mocks.sendEmail,
  sendGroupOrganiserJoinerRefundEmail: mocks.sendGroupOrganiserJoinerRefundEmail,
}));
vi.mock("@/lib/logger", () => ({
  default: { error: mocks.loggerError, warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/payment-recovery", () => ({
  enqueueRefundRequestRefundRecovery: mocks.enqueueRefundRequestRefundRecovery,
}));
vi.mock("@/lib/payment-transactions", () => ({
  lockPaymentForRefundedTotal: mocks.lockPaymentForRefundedTotal,
  refundPaymentTransactions: mocks.refundPaymentTransactions,
  planStripeRefundAllocation: mocks.planStripeRefundAllocation,
  PartialRefundError: class PartialRefundError extends Error {},
}));
vi.mock("@/lib/organiser-child-refund", async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  organiserCardAppealCap: mocks.organiserCardAppealCap,
  reserveOrganiserChildAppealRefund: mocks.reserveOrganiserChildAppealRefund,
}));
vi.mock("@/lib/organiser-child-refund-executor", () => ({
  runOrganiserChildRefundDebtNow: mocks.runOrganiserChildRefundDebtNow,
}));

import { PUT } from "@/app/api/admin/refund-requests/[id]/route";
import { OrganiserChildRefundRefusedError } from "@/lib/organiser-child-refund";
import { buildOrganiserChildModificationRefundKey } from "@/lib/payment-recovery-keys";

const SETTLEMENT = { id: "settlement_1", stripePaymentIntentId: "pi_group", amountCents: 20_000 };
const LOCKED_PAYMENT = { id: "payment_child", source: "STRIPE", status: "PARTIALLY_REFUNDED", amountCents: 10_000, refundedAmountCents: 5_000, recoveryOperations: [], refunds: [] };

/** A joiner's booking the organiser paid for by card, cancelled by the organiser at 50%. */
function joinerAppeal() {
  return {
    id: "refund_1",
    status: "PENDING",
    booking: {
      id: "booking_child",
      memberId: "member_joiner",
      parentBookingId: "booking_organiser",
      organiserSettled: true,
      checkIn: new Date("2026-08-01"),
      checkOut: new Date("2026-08-03"),
      payment: { ...LOCKED_PAYMENT, stripePaymentIntentId: null, manuallyMarkedPaidAt: null },
      member: { id: "member_joiner", firstName: "Jo", lastName: "Joiner", email: "jo@example.com" },
      organisation: null,
    },
    member: { id: "member_joiner", firstName: "Jo", lastName: "Joiner", email: "jo@example.com" },
  };
}

function approve(amountCents: number, extra: Record<string, unknown> = {}) {
  return PUT(
    new NextRequest("http://localhost/api/admin/refund-requests/refund_1", {
      method: "PUT",
      headers: { "Content-Type": "application/json", "x-forwarded-for": "127.0.0.1" },
      body: JSON.stringify({ status: "APPROVED", approvedAmountCents: amountCents, ...extra }),
    }),
    { params: Promise.resolve({ id: "refund_1" }) },
  );
}

/** The joiner's outcome email's template data. */
function joinerEmail() {
  const call = mocks.sendEmail.mock.calls.find(([input]) => input.templateName === "refund-request-approved");
  return call?.[0] as { to: string; templateData: { refundSentence: string } } | undefined;
}

describe("approving a refund appeal on a booking the group organiser paid for by card (#3956)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.mockResolvedValue({ user: { id: "admin_1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }] } });
    mocks.refundRequestFindUnique.mockResolvedValue(joinerAppeal());
    mocks.refundRequestUpdateMany.mockResolvedValue({ count: 1 });
    mocks.paymentFindUnique.mockResolvedValue(LOCKED_PAYMENT);
    mocks.executeRaw.mockResolvedValue(1);
    mocks.manualRefundTaskAggregate.mockResolvedValue({ _sum: { amountCents: null } });
    mocks.memberCreditAggregate.mockResolvedValue({ _sum: { amountCents: null } });
    mocks.lockedRefundRequestFindUnique.mockResolvedValue({ status: "PENDING" });
    mocks.organiserCardAppealCap.mockResolvedValue({ settlement: SETTLEMENT, maxRefundableCents: 5_000, combinedRefundPending: false });
    mocks.reserveOrganiserChildAppealRefund.mockResolvedValue({ id: "debt_1", amountCents: 5_000 });
    mocks.runOrganiserChildRefundDebtNow.mockResolvedValue(true);
    mocks.sendEmail.mockResolvedValue(undefined);
    mocks.sendGroupOrganiserJoinerRefundEmail.mockResolvedValue(undefined);
    mocks.isXeroConnected.mockResolvedValue(true);
    mocks.bookingFindUnique.mockResolvedValue({
      id: "booking_organiser",
      memberId: "member_organiser",
      member: { id: "member_organiser", firstName: "Olive", lastName: "Organiser", email: "olive@example.com" },
      organisation: null,
    });
    mocks.transaction.mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) =>
      callback({
        $executeRaw: mocks.executeRaw,
        manualRefundTask: { aggregate: mocks.manualRefundTaskAggregate },
        memberCredit: { aggregate: mocks.memberCreditAggregate },
        refundRequest: { findUnique: mocks.lockedRefundRequestFindUnique, updateMany: mocks.refundRequestUpdateMany },
        payment: { findUnique: mocks.paymentFindUnique },
      }),
    );
  });

  it("reserves the refund against the organiser's combined payment, runs it, and queues no Xero note of its own", async () => {
    const response = await approve(5_000);

    expect(response.status).toBe(200);
    // Claimed, then reserved in the same transaction, sized from the locked payment.
    expect(mocks.refundRequestUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "refund_1", status: "PENDING" } }),
    );
    expect(mocks.reserveOrganiserChildAppealRefund).toHaveBeenCalledWith(expect.anything(), {
      settlement: SETTLEMENT,
      refundRequestId: "refund_1",
      childBookingId: "booking_child",
      childPayment: LOCKED_PAYMENT,
      amountCents: 5_000,
    });
    expect(mocks.refundRequestUpdateMany.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.reserveOrganiserChildAppealRefund.mock.invocationCallOrder[0]!,
    );
    // Run after the commit, through the #3653 executor.
    expect(mocks.runOrganiserChildRefundDebtNow).toHaveBeenCalledWith("debt_1", CLUB_FORMAT_TEST);
    expect(mocks.transaction.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.runOrganiserChildRefundDebtNow.mock.invocationCallOrder[0]!,
    );
    // None of the payment-transaction refund path, which would refund $0 here.
    expect(mocks.planStripeRefundAllocation).not.toHaveBeenCalled();
    expect(mocks.refundPaymentTransactions).not.toHaveBeenCalled();
    expect(mocks.enqueueRefundRequestRefundRecovery).not.toHaveBeenCalled();
    // The executor queues the note once Stripe answered; the route queues none.
    expect(mocks.enqueueXeroRefundCreditNoteOperation).not.toHaveBeenCalled();
    expect(mocks.createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "refund-request.approve",
        metadata: expect.objectContaining({
          approvedAmountCents: 5_000,
          bankTransferCents: 0,
          organiserCardRefundOperationId: "debt_1",
          organiserCardRefundMade: true,
        }),
      }),
    );
  });

  it("tells the joiner the refund went to the organiser's card, and the organiser that it is being refunded to theirs", async () => {
    await approve(5_000);

    expect(joinerEmail()).toMatchObject({
      to: "jo@example.com",
      templateData: {
        refundSentence:
          "A refund of $50.00 has been processed to the group organiser's card, because the group organiser paid for this booking.",
      },
    });
    expect(mocks.bookingFindUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "booking_organiser" } }));
    expect(mocks.sendGroupOrganiserJoinerRefundEmail).toHaveBeenCalledWith(
      {
        bookingContext: { bookingId: "booking_organiser", recipientMemberId: "member_organiser" },
        email: "olive@example.com",
        firstName: "Olive",
        joinerName: "Jo Joiner",
        amountCents: 5_000,
        checkIn: new Date("2026-08-01"),
        checkOut: new Date("2026-08-03"),
      },
      CLUB_FORMAT_TEST,
    );
  });

  it("tells the joiner the refund is on its way while Stripe has not answered, the debt left for the recovery runner", async () => {
    mocks.runOrganiserChildRefundDebtNow.mockResolvedValue(false);

    const response = await approve(5_000);

    expect(response.status).toBe(200);
    expect(joinerEmail()?.templateData.refundSentence).toBe(
      "A refund of $50.00 is on its way to the group organiser's card, because the group organiser paid for this booking.",
    );
    expect(mocks.sendGroupOrganiserJoinerRefundEmail).toHaveBeenCalledTimes(1);
    expect(mocks.refundPaymentTransactions).not.toHaveBeenCalled();
  });

  it("refuses an amount the combined payment cannot cover, naming what it can, before claiming anything", async () => {
    // Paid 10000 for the joiner, 5000 refunded by the group cancel: 5000 left on
    // the child, but the combined payment holds only 3000 more.
    mocks.organiserCardAppealCap.mockResolvedValue({ settlement: SETTLEMENT, maxRefundableCents: 3_000, combinedRefundPending: false });

    const response = await approve(5_000);

    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.maxRefundableCents).toBe(3_000);
    expect(body.error).toContain("at most $30.00");
    expect(body.error).toContain("$50.00 cannot be approved");
    expect(mocks.refundRequestUpdateMany).not.toHaveBeenCalled();
    expect(mocks.reserveOrganiserChildAppealRefund).not.toHaveBeenCalled();
    expect(mocks.runOrganiserChildRefundDebtNow).not.toHaveBeenCalled();
    expect(mocks.sendEmail).not.toHaveBeenCalled();
    expect(mocks.sendGroupOrganiserJoinerRefundEmail).not.toHaveBeenCalled();
    expect(mocks.enqueueXeroRefundCreditNoteOperation).not.toHaveBeenCalled();
  });

  it("refuses when the organiser's payment has nothing left for it, saying the appeal can only be declined", async () => {
    mocks.organiserCardAppealCap.mockResolvedValue({ settlement: null, maxRefundableCents: 0, combinedRefundPending: false });

    const response = await approve(1_000);

    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.error).toBe(
      "This booking was paid for by the group organiser's card, and that payment has nothing left to refund for it, so this appeal cannot be approved. Decline it.",
    );
    expect(body.maxRefundableCents).toBe(0);
    expect(mocks.refundRequestUpdateMany).not.toHaveBeenCalled();
    expect(mocks.refundPaymentTransactions).not.toHaveBeenCalled();
  });

  it("says the same when the payment is found but its room is spent (cap 0 with a settlement)", async () => {
    mocks.organiserCardAppealCap.mockResolvedValue({ settlement: SETTLEMENT, maxRefundableCents: 0, combinedRefundPending: false });

    const response = await approve(1_000);

    expect(response.status).toBe(409);
    expect((await response.json()).error).toContain("nothing left to refund for it, so this appeal cannot be approved. Decline it.");
    expect(mocks.reserveOrganiserChildAppealRefund).not.toHaveBeenCalled();
  });

  it("refuses while the group cancel's own combined refund is not made, claiming and moving nothing (review F1)", async () => {
    mocks.organiserCardAppealCap.mockResolvedValue({ settlement: null, maxRefundableCents: 0, combinedRefundPending: true });

    const response = await approve(1_000);

    expect(response.status).toBe(409);
    expect((await response.json()).error).toBe(
      "This booking was paid for by the group organiser's card, and the group cancellation's own refund to that card is still being made or reconciled, so this appeal cannot be approved now. Approve it once that refund is made, or decline it.",
    );
    expect(mocks.refundRequestUpdateMany).not.toHaveBeenCalled();
    expect(mocks.reserveOrganiserChildAppealRefund).not.toHaveBeenCalled();
    expect(mocks.runOrganiserChildRefundDebtNow).not.toHaveBeenCalled();
    expect(mocks.sendEmail).not.toHaveBeenCalled();
    expect(mocks.enqueueXeroRefundCreditNoteOperation).not.toHaveBeenCalled();
  });

  it("answers 'already reviewed' when another review settled the request while this one waited for the lock, before any cap (review fix 4)", async () => {
    // Read PENDING before the lock; settled by the time this approval holds it.
    mocks.lockedRefundRequestFindUnique.mockResolvedValue({ status: "APPROVED" });
    mocks.organiserCardAppealCap.mockResolvedValue({ settlement: SETTLEMENT, maxRefundableCents: 0, combinedRefundPending: false });

    const response = await approve(5_000);

    expect(response.status).toBe(409);
    expect((await response.json()).error).toBe("This refund request has already been reviewed");
    expect(mocks.lockedRefundRequestFindUnique).toHaveBeenCalledWith({ where: { id: "refund_1" }, select: { status: true } });
    expect(mocks.executeRaw.mock.invocationCallOrder[0]).toBeLessThan(mocks.lockedRefundRequestFindUnique.mock.invocationCallOrder[0]!);
    expect(mocks.organiserCardAppealCap).not.toHaveBeenCalled();
    expect(mocks.refundRequestUpdateMany).not.toHaveBeenCalled();
    expect(mocks.reserveOrganiserChildAppealRefund).not.toHaveBeenCalled();
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });

  it("asks the cap under the lock, from the locked payment, net of what is already handed back", async () => {
    mocks.manualRefundTaskAggregate.mockResolvedValue({ _sum: { amountCents: 1_000 } });

    await approve(4_000);

    expect(mocks.organiserCardAppealCap).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: "booking_child", organiserSettled: true, parentBookingId: "booking_organiser" }),
      LOCKED_PAYMENT,
      { handBackCents: 1_000, lateCashCreditCents: 0, cardRefundOwedCents: 0 },
    );
    expect(mocks.executeRaw.mock.invocationCallOrder[0]).toBeLessThan(mocks.organiserCardAppealCap.mock.invocationCallOrder[0]!);
  });

  it("#4124 review F1: an open child refund debt comes off the ceiling once, in the headroom, not again as a card debt", async () => {
    const actual = (await vi.importActual("@/lib/organiser-child-refund")) as typeof import("@/lib/organiser-child-refund");
    mocks.organiserCardAppealCap.mockImplementation(actual.organiserCardAppealCap);
    // The joiner's $20 reduction is still owed back to the organiser's card.
    const childDebt = {
      id: "op_child_debt",
      type: "REFUND_BOOKING_MODIFICATION",
      status: "PENDING",
      idempotencyKey: buildOrganiserChildModificationRefundKey("mod_1"),
      amountCents: 2_000,
      allocationPlan: null,
      paymentTransactionId: null,
      createdAt: new Date("2026-06-20T00:00:00.000Z"),
      succeededAt: null,
    };
    mocks.paymentFindUnique.mockResolvedValue({ ...LOCKED_PAYMENT, recoveryOperations: [childDebt] });
    mocks.transaction.mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) =>
      callback({
        $executeRaw: mocks.executeRaw,
        manualRefundTask: { aggregate: mocks.manualRefundTaskAggregate },
        memberCredit: { aggregate: mocks.memberCreditAggregate },
        refundRequest: { findUnique: mocks.lockedRefundRequestFindUnique, updateMany: mocks.refundRequestUpdateMany },
        payment: { findUnique: mocks.paymentFindUnique },
        groupBookingSettlement: { findFirst: vi.fn().mockResolvedValue({ ...SETTLEMENT, status: "SUCCEEDED", refundPlan: null }) },
        paymentRecoveryOperation: {
          findUnique: vi.fn().mockResolvedValue(null),
          findMany: vi.fn().mockResolvedValue([{ paymentId: "payment_child", amountCents: 2_000 }]),
        },
        // $50 of the combined payment already refunded, all of it this joiner's.
        paymentRefund: { aggregate: vi.fn().mockResolvedValue({ _sum: { amountCents: 5_000 } }) },
      }),
    );

    const response = await approve(3_000);

    expect(response.status).toBe(200);
    // The debt was read as a card refund owed, and handed to the cap...
    expect(mocks.organiserCardAppealCap).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      { handBackCents: 0, lateCashCreditCents: 0, cardRefundOwedCents: 2_000 },
    );
    // ...which nets it once, through the headroom: $100 - $50 refunded - $20 owed.
    const cap = await mocks.organiserCardAppealCap.mock.results[0]!.value;
    expect(cap.maxRefundableCents).toBe(3_000);
    expect(mocks.reserveOrganiserChildAppealRefund).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ amountCents: 3_000 }),
    );
  });

  it("answers 409 and moves nothing when the reservation refuses after the claim (the claim rolls back with it)", async () => {
    mocks.reserveOrganiserChildAppealRefund.mockRejectedValue(
      new OrganiserChildRefundRefusedError("This appeal already has a refund to the group organiser's card from an earlier approval, so it was not approved again."),
    );

    const response = await approve(5_000);

    expect(response.status).toBe(409);
    expect((await response.json()).error).toContain("earlier approval");
    expect(mocks.runOrganiserChildRefundDebtNow).not.toHaveBeenCalled();
    expect(mocks.sendEmail).not.toHaveBeenCalled();
    expect(mocks.createAuditLog).not.toHaveBeenCalled();
  });

  it("sends neither outcome email when the admin chose not to notify", async () => {
    await approve(5_000, { notifyMember: false });

    expect(mocks.runOrganiserChildRefundDebtNow).toHaveBeenCalledTimes(1);
    expect(mocks.sendEmail).not.toHaveBeenCalled();
    expect(mocks.sendGroupOrganiserJoinerRefundEmail).not.toHaveBeenCalled();
  });

  it("writes to one person once when the organiser is the joiner", async () => {
    mocks.bookingFindUnique.mockResolvedValue({
      id: "booking_organiser",
      memberId: "member_joiner",
      member: { id: "member_joiner", firstName: "Jo", lastName: "Joiner", email: "JO@example.com" },
      organisation: null,
    });

    await approve(5_000);

    expect(joinerEmail()).toBeDefined();
    expect(mocks.sendGroupOrganiserJoinerRefundEmail).not.toHaveBeenCalled();
  });

  it("keeps the ordinary card path for a booking that is not the organiser's to refund", async () => {
    mocks.organiserCardAppealCap.mockResolvedValue(null);
    mocks.planStripeRefundAllocation.mockResolvedValue({
      slices: [{ paymentTransactionId: "txn_1", amountCents: 2_500 }],
      plannedAmountCents: 2_500,
    });
    // One answer per planned slice, as `refundPaymentTransactions` returns: made, so nothing is still owed (#4102).
    const slice = { paymentTransactionId: "txn_1", amountCents: 2_500 };
    mocks.refundPaymentTransactions.mockResolvedValue({
      refunds: [{ paymentIntentId: "pi_child", refundId: "re_1", amountCents: 2_500, status: "succeeded", slice }],
    });
    mocks.enqueueXeroRefundCreditNoteOperation.mockResolvedValue({ queueOperationId: "note_1" });

    const response = await approve(2_500);

    expect(response.status).toBe(200);
    expect(mocks.reserveOrganiserChildAppealRefund).not.toHaveBeenCalled();
    expect(mocks.refundPaymentTransactions).toHaveBeenCalledTimes(1);
    expect(mocks.enqueueRefundRequestRefundRecovery).not.toHaveBeenCalled();
    expect(mocks.enqueueXeroRefundCreditNoteOperation).toHaveBeenCalledWith("payment_child", 2_500, {
      createdByMemberId: "admin_1",
    });
    expect(mocks.sendGroupOrganiserJoinerRefundEmail).not.toHaveBeenCalled();
  });
});
