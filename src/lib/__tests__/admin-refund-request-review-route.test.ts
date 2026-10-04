import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import {
  contentAdminSession,
  readOnlyAdminSession,
} from "./helpers/admin-area-gate-sessions";
import {
  formatClubInstantDate,
  requireClubTimeZone,
  requireInstant,
} from "@/lib/club-time";

const mocks = vi.hoisted(() => ({
  enqueueRefundRequestRefundRecovery: vi.fn(),
  auth: vi.fn(),
  requireActiveSessionUser: vi.fn(),
  refundRequestFindUnique: vi.fn(),
  refundRequestUpdateMany: vi.fn(),
  paymentFindUnique: vi.fn(),
  paymentUpdate: vi.fn(),
  executeRaw: vi.fn(),
  manualRefundTaskAggregate: vi.fn(),
  manualRefundTaskCreateMany: vi.fn(),
  manualRefundTaskDeleteMany: vi.fn(),
  memberCreditAggregate: vi.fn(),
  transaction: vi.fn(),
  processRefund: vi.fn(),
  refundPaymentTransactions: vi.fn(),
  planStripeRefundAllocation: vi.fn(),
  isXeroConnected: vi.fn(),
  enqueueXeroRefundCreditNoteOperation: vi.fn(),
  kickQueuedXeroOutboxOperationsIfConnected: vi.fn(),
  sendEmail: vi.fn(),
  refundRequestApprovedTemplate: vi.fn(),
  refundRequestDeclinedTemplate: vi.fn(),
  createAuditLog: vi.fn(),
  loggerError: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  auth: mocks.auth,
}));

vi.mock("@/lib/session-guards", async () => ({
  requireAdmin: (await import("./helpers/require-admin-mock"))
    .evaluateRequireAdminMock,
  requireActiveSessionUser: mocks.requireActiveSessionUser,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    refundRequest: {
      findUnique: mocks.refundRequestFindUnique,
      updateMany: mocks.refundRequestUpdateMany,
    },
    $transaction: mocks.transaction,
  },
}));

vi.mock("@/lib/audit", () => ({
  createAuditLog: mocks.createAuditLog,
}));

vi.mock("@/lib/stripe", () => ({
  processRefund: mocks.processRefund,
}));

vi.mock("@/lib/xero", () => ({
  isXeroConnected: mocks.isXeroConnected,
}));

vi.mock("@/lib/xero-operation-outbox", () => ({
  enqueueXeroRefundCreditNoteOperation: mocks.enqueueXeroRefundCreditNoteOperation,
  kickQueuedXeroOutboxOperationsIfConnected:
    mocks.kickQueuedXeroOutboxOperationsIfConnected,
}));

vi.mock("@/lib/email", () => ({
  sendEmail: mocks.sendEmail,
}));

vi.mock("@/lib/email-templates/refunds", () => ({
  // #2321: one function per outcome — no boolean can route approval wording to
  // a declined member.
  refundRequestApprovedTemplate: mocks.refundRequestApprovedTemplate,
  refundRequestDeclinedTemplate: mocks.refundRequestDeclinedTemplate,
}));

vi.mock("@/lib/logger", () => ({
  default: {
    error: mocks.loggerError,
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock("@/lib/payment-recovery", () => ({
  enqueueAdditionalPaymentIntentRecovery: vi.fn().mockResolvedValue({ id: "recovery_additional" }),
  enqueueRefundRequestRefundRecovery: (...args: unknown[]) =>
    mocks.enqueueRefundRequestRefundRecovery(...args),
}));

vi.mock("@/lib/payment-transactions", () => ({
  refundPaymentTransactions: mocks.refundPaymentTransactions,
  planStripeRefundAllocation: mocks.planStripeRefundAllocation,
  PartialRefundError: class PartialRefundError extends Error {
    completedRefundCents = 0;
  },
}));

import { PUT } from "@/app/api/admin/refund-requests/[id]/route";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";

describe("PUT /api/admin/refund-requests/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mocks.auth.mockResolvedValue({
      user: { id: "admin_1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }] },
    });
    mocks.requireActiveSessionUser.mockResolvedValue(null);
    mocks.processRefund.mockResolvedValue({ id: "re_1" });
    mocks.refundPaymentTransactions.mockResolvedValue({
      refunds: [{ refundId: "re_1", paymentIntentId: "pi_1", amountCents: 2500 }],
    });
    // #1510: the route freezes the allocation before the inline refund and
    // passes the same slices to both the refund and the recovery enqueue.
    mocks.planStripeRefundAllocation.mockResolvedValue({
      slices: [{ paymentTransactionId: "txn_1", amountCents: 2500 }],
      plannedAmountCents: 2500,
      totalRefundableCents: 10000,
    });
    mocks.isXeroConnected.mockResolvedValue(true);
    mocks.enqueueXeroRefundCreditNoteOperation.mockResolvedValue({
      queueOperationId: "op_credit_note_1",
      message: "queued",
    });
    mocks.kickQueuedXeroOutboxOperationsIfConnected.mockResolvedValue({
      found: 1,
      processed: 1,
      succeeded: 1,
      failed: 0,
      skipped: 0,
    });
    mocks.sendEmail.mockResolvedValue(undefined);
    mocks.refundRequestApprovedTemplate.mockReturnValue("<p>approved</p>");
    mocks.refundRequestDeclinedTemplate.mockReturnValue("<p>declined</p>");
    mocks.refundRequestUpdateMany.mockResolvedValue({ count: 1 });
    // #3827: the approval re-reads the payment under lock(1) for its cap.
    mocks.paymentFindUnique.mockResolvedValue({
      id: "payment_1",
      bookingId: "booking_1",
      source: "STRIPE",
      status: "SUCCEEDED",
      amountCents: 10000,
      refundedAmountCents: 0,
    });
    mocks.executeRaw.mockResolvedValue(1);
    mocks.manualRefundTaskAggregate.mockResolvedValue({ _sum: { amountCents: null } });
    mocks.memberCreditAggregate.mockResolvedValue({ _sum: { amountCents: null } });
    mocks.manualRefundTaskCreateMany.mockResolvedValue({ count: 1 });
    mocks.manualRefundTaskDeleteMany.mockResolvedValue({ count: 1 });
    mocks.paymentUpdate.mockResolvedValue({});
    mocks.transaction.mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) =>
      callback({
        $executeRaw: mocks.executeRaw,
        manualRefundTask: {
          aggregate: mocks.manualRefundTaskAggregate,
          createMany: mocks.manualRefundTaskCreateMany,
          deleteMany: mocks.manualRefundTaskDeleteMany,
        },
        refundRequest: {
          updateMany: mocks.refundRequestUpdateMany,
        },
        memberCredit: { aggregate: mocks.memberCreditAggregate },
        payment: {
          findUnique: mocks.paymentFindUnique,
          update: mocks.paymentUpdate,
        },
      })
    );
  });

  it("queues a refund credit note after approving a refund appeal", async () => {
    const initialRefundRequest = {
      id: "refund_1",
      status: "PENDING",
      booking: {
        id: "booking_1",
        checkIn: new Date("2026-07-01"),
        checkOut: new Date("2026-07-03"),
        payment: {
          id: "payment_1",
          stripePaymentIntentId: "pi_1",
          amountCents: 10000,
          refundedAmountCents: 0,
          status: "SUCCEEDED",
        },
        member: {
          email: "member@example.com",
        },
      },
      member: {
        id: "member_1",
        firstName: "Alice",
        lastName: "Example",
        email: "member@example.com",
      },
    };
    const updatedRefundRequest = {
      ...initialRefundRequest,
      status: "APPROVED",
      approvedAmountCents: 2500,
    };

    mocks.refundRequestFindUnique
      .mockResolvedValueOnce(initialRefundRequest)
      .mockResolvedValueOnce(updatedRefundRequest);

    const request = new NextRequest("http://localhost/api/admin/refund-requests/refund_1", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "x-forwarded-for": "127.0.0.1",
      },
      body: JSON.stringify({
        status: "APPROVED",
        approvedAmountCents: 2500,
      }),
    });

    const response = await PUT(request, {
      params: Promise.resolve({ id: "refund_1" }),
    });

    expect(response.status).toBe(200);
    expect(mocks.refundPaymentTransactions).toHaveBeenCalledWith({
      paymentId: "payment_1",
      amountCents: 2500,
      // #1510: the inline refund executes the frozen slices.
      allocation: [{ paymentTransactionId: "txn_1", amountCents: 2500 }],
      metadata: {
        bookingId: "booking_1",
        reason: "refund_appeal_approved",
        refundRequestId: "refund_1",
      },
      idempotencyKeyPrefix: "refund_request_refund_1",
      format: CLUB_FORMAT_TEST,
    });
    expect(mocks.enqueueXeroRefundCreditNoteOperation).toHaveBeenCalledWith(
      "payment_1",
      2500,
      {
        createdByMemberId: "admin_1",
      }
    );
    expect(mocks.kickQueuedXeroOutboxOperationsIfConnected).toHaveBeenCalledWith({
      limit: 1,
    });
  });

  function approvedRefundRequest() {
    return {
      id: "refund_1",
      status: "PENDING",
      booking: {
        id: "booking_1",
        checkIn: new Date("2026-07-01"),
        checkOut: new Date("2026-07-03"),
        payment: {
          id: "payment_1",
          stripePaymentIntentId: "pi_1",
          amountCents: 10000,
          refundedAmountCents: 0,
          status: "SUCCEEDED",
        },
        member: { email: "member@example.com" },
      },
      member: {
        id: "member_1",
        firstName: "Alice",
        lastName: "Example",
        email: "member@example.com",
      },
    };
  }

  function approveRequest() {
    return new NextRequest("http://localhost/api/admin/refund-requests/refund_1", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "x-forwarded-for": "127.0.0.1",
      },
      body: JSON.stringify({ status: "APPROVED", approvedAmountCents: 2500 }),
    });
  }

  // Issue #818: the refund must be claimed before any Stripe money movement, so
  // a concurrent approval that loses the claim never issues a refund.
  it("does not issue a Stripe refund when the claim is lost to a concurrent approval", async () => {
    mocks.refundRequestFindUnique.mockResolvedValue(approvedRefundRequest());
    mocks.refundRequestUpdateMany.mockResolvedValue({ count: 0 });

    const response = await PUT(approveRequest(), {
      params: Promise.resolve({ id: "refund_1" }),
    });

    expect(response.status).toBe(409);
    expect(mocks.refundPaymentTransactions).not.toHaveBeenCalled();
    expect(mocks.enqueueXeroRefundCreditNoteOperation).not.toHaveBeenCalled();
  });

  // #3827 (`INV-PAY-115`): paid 200, an edit lowered it to 150 by internet
  // banking (a 50 refund task still OPEN), the cancel then handed back 75. The
  // gross remainder is 125, but 50 of it is already promised back by the edit's
  // own task, so an appeal can be approved for 75 at most - approving 125 would
  // queue a credit note for the same 50 twice.
  describe("caps at the cash net of open edit refunds (#3827)", () => {
    function lockedPaymentAfterEditAndCancel() {
      // The route's pre-lock read (approvedRefundRequest) still says nothing
      // was refunded: the cap must come from the re-read under the lock.
      mocks.paymentFindUnique.mockResolvedValue({
        id: "payment_1",
        bookingId: "booking_1",
        source: "STRIPE",
        status: "PARTIALLY_REFUNDED",
        amountCents: 20000,
        refundedAmountCents: 7500,
      });
      mocks.manualRefundTaskAggregate.mockResolvedValue({ _sum: { amountCents: 5000 } });
      mocks.refundRequestFindUnique.mockResolvedValue(approvedRefundRequest());
    }

    function approveFor(approvedAmountCents: number) {
      return new NextRequest("http://localhost/api/admin/refund-requests/refund_1", {
        method: "PUT",
        headers: { "Content-Type": "application/json", "x-forwarded-for": "127.0.0.1" },
        body: JSON.stringify({ status: "APPROVED", approvedAmountCents }),
      });
    }

    it("refuses an approval that would re-promise an open edit refund, before any claim or money", async () => {
      lockedPaymentAfterEditAndCancel();

      const response = await PUT(approveFor(12500), {
        params: Promise.resolve({ id: "refund_1" }),
      });

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: "Amount exceeds maximum refundable of $75.00",
      });
      expect(mocks.manualRefundTaskAggregate).toHaveBeenCalledWith({
        // `INV-PAY-116`: EVERY open hand-back on the payment, any key - an
        // edit's, an earlier appeal's, and a cancellation's own.
        where: {
          paymentId: "payment_1",
          status: "OPEN",
          kind: "CANCELLED_BOOKING_HAND_BACK",
        },
        _sum: { amountCents: true },
      });
      expect(mocks.refundRequestUpdateMany).not.toHaveBeenCalled();
      expect(mocks.planStripeRefundAllocation).not.toHaveBeenCalled();
      expect(mocks.refundPaymentTransactions).not.toHaveBeenCalled();
      expect(mocks.enqueueXeroRefundCreditNoteOperation).not.toHaveBeenCalled();
    });

    it("approves up to that net figure, reading it and claiming under lock(1)", async () => {
      lockedPaymentAfterEditAndCancel();

      const response = await PUT(approveFor(7500), {
        params: Promise.resolve({ id: "refund_1" }),
      });

      expect(response.status).toBe(200);
      const lockSql = (mocks.executeRaw.mock.calls[0]?.[0] as TemplateStringsArray).join("?");
      expect(lockSql).toContain("pg_advisory_xact_lock(1)");
      const lockedAt = mocks.executeRaw.mock.invocationCallOrder[0];
      expect(lockedAt).toBeLessThan(mocks.manualRefundTaskAggregate.mock.invocationCallOrder[0]);
      // `INV-PAY-116`: the handed-back sums are read BEFORE the payment, so a
      // cancellation hand-back completing between them errs the cap low.
      expect(mocks.manualRefundTaskAggregate.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.paymentFindUnique.mock.invocationCallOrder[0],
      );
      expect(mocks.memberCreditAggregate.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.paymentFindUnique.mock.invocationCallOrder[0],
      );
      expect(mocks.manualRefundTaskAggregate.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.refundRequestUpdateMany.mock.invocationCallOrder[0],
      );
      // The claim ran inside the locked transaction, before the provider call.
      expect(mocks.refundRequestUpdateMany.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.planStripeRefundAllocation.mock.invocationCallOrder[0],
      );
      expect(mocks.transaction).toHaveBeenCalledTimes(1);
    });
  });

  // #3827 (owner decision D-3813-7, `INV-PAY-116`): what no card refund can
  // carry goes back by bank transfer, as ONE officer task raised inside the
  // approval's locked transaction, and the member is told so.
  describe("an approval the card cannot carry raises a bank-transfer task (D-3813-7)", () => {
    function approveFor(approvedAmountCents: number) {
      return new NextRequest("http://localhost/api/admin/refund-requests/refund_1", {
        method: "PUT",
        headers: { "Content-Type": "application/json", "x-forwarded-for": "127.0.0.1" },
        body: JSON.stringify({ status: "APPROVED", approvedAmountCents }),
      });
    }
    function stripePlans(plannedAmountCents: number) {
      mocks.planStripeRefundAllocation.mockResolvedValue({
        slices: plannedAmountCents > 0 ? [{ paymentTransactionId: "txn_1", amountCents: plannedAmountCents }] : [],
        plannedAmountCents,
        totalRefundableCents: plannedAmountCents,
      });
    }
    function sentTemplateData() {
      const [args] = mocks.sendEmail.mock.calls[0] as [{ templateData: Record<string, string> }];
      return args.templateData;
    }
    function paidBy(source: "INTERNET_BANKING" | "STRIPE") {
      mocks.paymentFindUnique.mockResolvedValue({
        id: "payment_1",
        bookingId: "booking_1",
        source,
        status: "SUCCEEDED",
        amountCents: 10000,
        refundedAmountCents: 0,
      });
    }

    it("internet banking: the whole amount becomes one task, under the lock, after the claim", async () => {
      mocks.refundRequestFindUnique.mockResolvedValue(approvedRefundRequest());
      paidBy("INTERNET_BANKING");
      stripePlans(0);

      const response = await PUT(approveFor(2500), { params: Promise.resolve({ id: "refund_1" }) });

      expect(response.status).toBe(200);
      expect(mocks.manualRefundTaskCreateMany).toHaveBeenCalledTimes(1);
      expect(mocks.manualRefundTaskCreateMany).toHaveBeenCalledWith({
        data: [
          expect.objectContaining({
            bookingId: "booking_1",
            paymentId: "payment_1",
            amountCents: 2500,
            raisedAmountCents: 2500,
            kind: "CANCELLED_BOOKING_HAND_BACK",
            occurrenceKey: "refund-request-hand-back:refund_1",
          }),
        ],
        skipDuplicates: true,
      });
      // Inside the one locked transaction, after the claim and the plan.
      expect(mocks.transaction).toHaveBeenCalledTimes(1);
      expect(mocks.planStripeRefundAllocation).toHaveBeenCalledWith(
        expect.objectContaining({ paymentId: "payment_1", amountCents: 2500, store: expect.anything() }),
      );
      expect(mocks.executeRaw.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.manualRefundTaskCreateMany.mock.invocationCallOrder[0],
      );
      expect(mocks.refundRequestUpdateMany.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.manualRefundTaskCreateMany.mock.invocationCallOrder[0],
      );
      // Nothing for the card to do; the payment mirror is not touched here.
      expect(mocks.refundPaymentTransactions).toHaveBeenCalledWith(
        expect.objectContaining({ amountCents: 0, allocation: [] }),
      );
      expect(mocks.paymentUpdate).not.toHaveBeenCalled();
      // D-3813-8: NO note at approval for the bank-transfer part - the
      // request's own note is queued when its task is marked paid back.
      expect(mocks.enqueueXeroRefundCreditNoteOperation).not.toHaveBeenCalled();
      expect(mocks.refundRequestApprovedTemplate).toHaveBeenCalledWith(
        expect.objectContaining({ amountCents: 2500, bankTransferCents: 2500 }),
        expect.anything(),
      );
      expect(sentTemplateData().refundSentence).toBe(
        "The club will refund $25.00 to you by bank transfer.",
      );
      expect(mocks.createAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({ approvedAmountCents: 2500, bankTransferCents: 2500 }),
        }),
      );
    });

    it("a payment partly by card: the card takes its part, the task the rest", async () => {
      mocks.refundRequestFindUnique.mockResolvedValue(approvedRefundRequest());
      paidBy("INTERNET_BANKING");
      stripePlans(1000);

      const response = await PUT(approveFor(2500), { params: Promise.resolve({ id: "refund_1" }) });

      expect(response.status).toBe(200);
      expect(mocks.manualRefundTaskCreateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: [expect.objectContaining({ amountCents: 1500, occurrenceKey: "refund-request-hand-back:refund_1" })],
        }),
      );
      expect(mocks.refundPaymentTransactions).toHaveBeenCalledWith(
        expect.objectContaining({ amountCents: 1000 }),
      );
      // The card part's note only; the bank-transfer part's comes at payout.
      expect(mocks.enqueueXeroRefundCreditNoteOperation).toHaveBeenCalledWith(
        "payment_1",
        1000,
        expect.anything(),
      );
      expect(sentTemplateData().refundSentence).toBe(
        "A refund of $10.00 will be processed to your original payment method, and the club will refund the remaining $15.00 to you by bank transfer.",
      );
    });

    it("a card payment the card fully carries raises no task and keeps its wording", async () => {
      mocks.refundRequestFindUnique.mockResolvedValue(approvedRefundRequest());
      stripePlans(2500);

      const response = await PUT(approveFor(2500), { params: Promise.resolve({ id: "refund_1" }) });

      expect(response.status).toBe(200);
      expect(mocks.manualRefundTaskCreateMany).not.toHaveBeenCalled();
      expect(sentTemplateData().refundSentence).toBe(
        "A refund of $25.00 will be processed to your original payment method.",
      );
      expect(sentTemplateData().amount).toBe("$25.00");
    });

    it("a second appeal is capped by the first one's open task", async () => {
      // $200 by internet banking; the cancel credited back $100; the first
      // appeal's $100 task is still OPEN. Nothing is left to approve.
      mocks.paymentFindUnique.mockResolvedValue({
        id: "payment_1",
        bookingId: "booking_1",
        source: "INTERNET_BANKING",
        status: "PARTIALLY_REFUNDED",
        amountCents: 20000,
        refundedAmountCents: 10000,
      });
      mocks.manualRefundTaskAggregate.mockResolvedValue({ _sum: { amountCents: 10000 } });
      mocks.refundRequestFindUnique.mockResolvedValue(approvedRefundRequest());

      const response = await PUT(approveFor(10000), { params: Promise.resolve({ id: "refund_1" }) });

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: "Amount exceeds maximum refundable of $0.00",
      });
      expect(mocks.refundRequestUpdateMany).not.toHaveBeenCalled();
      expect(mocks.manualRefundTaskCreateMany).not.toHaveBeenCalled();
    });

    it("releasing the claim deletes its OPEN task in the same locked transaction", async () => {
      mocks.refundRequestFindUnique.mockResolvedValue(approvedRefundRequest());
      paidBy("INTERNET_BANKING");
      stripePlans(1000);
      mocks.refundPaymentTransactions.mockRejectedValue(new Error("stripe down"));
      mocks.enqueueRefundRequestRefundRecovery.mockRejectedValue(new Error("db unavailable"));

      const response = await PUT(approveFor(2500), { params: Promise.resolve({ id: "refund_1" }) });

      expect(response.status).toBe(500);
      expect(mocks.transaction).toHaveBeenCalledTimes(2);
      expect(mocks.manualRefundTaskDeleteMany).toHaveBeenCalledWith({
        where: { occurrenceKey: "refund-request-hand-back:refund_1", status: "OPEN" },
      });
      const releaseLock = mocks.executeRaw.mock.invocationCallOrder[1];
      expect((mocks.executeRaw.mock.calls[1]?.[0] as TemplateStringsArray).join("?")).toContain(
        "pg_advisory_xact_lock(1)",
      );
      expect(releaseLock).toBeLessThan(mocks.refundRequestUpdateMany.mock.invocationCallOrder[1]);
      expect(mocks.refundRequestUpdateMany.mock.invocationCallOrder[1]).toBeLessThan(
        mocks.manualRefundTaskDeleteMany.mock.invocationCallOrder[0],
      );
    });

    it("a release that lost the request to someone else deletes nothing", async () => {
      mocks.refundRequestFindUnique.mockResolvedValue(approvedRefundRequest());
      paidBy("INTERNET_BANKING");
      stripePlans(1000);
      mocks.refundRequestUpdateMany
        .mockResolvedValueOnce({ count: 1 })
        .mockResolvedValueOnce({ count: 0 });
      mocks.refundPaymentTransactions.mockRejectedValue(new Error("stripe down"));
      mocks.enqueueRefundRequestRefundRecovery.mockRejectedValue(new Error("db unavailable"));

      await PUT(approveFor(2500), { params: Promise.resolve({ id: "refund_1" }) });

      expect(mocks.manualRefundTaskDeleteMany).not.toHaveBeenCalled();
    });

    // L3: a CARD payment whose ledger plans short of the approved amount is
    // ledger drift, never a bank transfer nobody decided on.
    it("a card payment planned short raises no task: the drift is logged and the card refunds what it can", async () => {
      mocks.refundRequestFindUnique.mockResolvedValue(approvedRefundRequest());
      paidBy("STRIPE");
      stripePlans(1000);

      const response = await PUT(approveFor(2500), { params: Promise.resolve({ id: "refund_1" }) });

      expect(response.status).toBe(200);
      expect(mocks.manualRefundTaskCreateMany).not.toHaveBeenCalled();
      expect(mocks.refundPaymentTransactions).toHaveBeenCalledWith(
        expect.objectContaining({ amountCents: 1000 }),
      );
      // A card payment keeps today's behaviour: the whole approval's note.
      expect(mocks.enqueueXeroRefundCreditNoteOperation).toHaveBeenCalledWith(
        "payment_1",
        2500,
        expect.anything(),
      );
      expect(mocks.loggerError).toHaveBeenCalledWith(
        expect.objectContaining({ approvedAmountCents: 2500, plannedAmountCents: 1000 }),
        "Approved refund appeal plan covers less than the approved amount; refunding what the payment ledger shows Stripe-refundable",
      );
      expect(sentTemplateData().refundSentence).toBe(
        "A refund of $25.00 will be processed to your original payment method.",
      );
      expect(mocks.createAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({ metadata: expect.objectContaining({ bankTransferCents: 0 }) }),
      );
    });

    // L4: a task this request's key already holds means nobody would be asked
    // to send the money - refuse, rolling the claim back, rather than promise it.
    it("refuses, rolling the claim back, when no bank-transfer task could be raised", async () => {
      mocks.refundRequestFindUnique.mockResolvedValue(approvedRefundRequest());
      paidBy("INTERNET_BANKING");
      stripePlans(0);
      mocks.manualRefundTaskCreateMany.mockResolvedValue({ count: 0 });
      let transactionRejected = false;
      mocks.transaction.mockImplementationOnce(async (callback: (tx: unknown) => Promise<unknown>) =>
        callback({
          $executeRaw: mocks.executeRaw,
          manualRefundTask: {
            aggregate: mocks.manualRefundTaskAggregate,
            createMany: mocks.manualRefundTaskCreateMany,
            deleteMany: mocks.manualRefundTaskDeleteMany,
          },
          refundRequest: { updateMany: mocks.refundRequestUpdateMany },
          memberCredit: { aggregate: mocks.memberCreditAggregate },
          payment: { findUnique: mocks.paymentFindUnique, update: mocks.paymentUpdate },
        }).catch((err: unknown) => {
          transactionRejected = true;
          throw err;
        }),
      );

      const response = await PUT(approveFor(2500), { params: Promise.resolve({ id: "refund_1" }) });

      expect(response.status).toBe(409);
      // The callback threw, so Postgres rolls the claim back with it.
      expect(transactionRejected).toBe(true);
      expect(mocks.refundPaymentTransactions).not.toHaveBeenCalled();
      expect(mocks.enqueueXeroRefundCreditNoteOperation).not.toHaveBeenCalled();
      expect(mocks.sendEmail).not.toHaveBeenCalled();
      expect(mocks.createAuditLog).not.toHaveBeenCalled();
    });
  });

  // L2: an appeal exists only on a cancelled booking, so the cash-settled
  // refusal must not tell the officer to cancel it.
  it("refuses a cash-settled booking without telling the officer to cancel it again", async () => {
    const request = approvedRefundRequest();
    mocks.refundRequestFindUnique.mockResolvedValue({
      ...request,
      booking: {
        ...request.booking,
        payment: { ...request.booking.payment, manuallyMarkedPaidAt: new Date("2026-06-01T00:00:00.000Z") },
      },
    });

    const response = await PUT(approveRequest(), { params: Promise.resolve({ id: "refund_1" }) });

    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe(
      "This booking was paid in cash or by an off-Xero bank transfer, so there is no card payment to refund and this appeal cannot be approved here. Its cancellation already raised a refund task on the payments board for the money the cancellation policy returns; settle any further refund with the treasurer.",
    );
    expect(body.error).not.toMatch(/cancel the booking/i);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  // M1 (`INV-PAY-116`): an appeal's cap also subtracts money already returned
  // through the two channels that never move `refundedAmountCents`.
  describe("the appeal cap nets money already returned another way (#3827)", () => {
    function approveFor(approvedAmountCents: number) {
      return new NextRequest("http://localhost/api/admin/refund-requests/refund_1", {
        method: "PUT",
        headers: { "Content-Type": "application/json", "x-forwarded-for": "127.0.0.1" },
        body: JSON.stringify({ status: "APPROVED", approvedAmountCents }),
      });
    }

    it("late cash on a cancelled member booking: the credit already minted is not approved again", async () => {
      // $100 arrived by bank transfer after the cancel and became $100 of
      // account credit; the payment still reads $100 refundable.
      mocks.paymentFindUnique.mockResolvedValue({
        id: "payment_1",
        bookingId: "booking_1",
        source: "INTERNET_BANKING",
        status: "SUCCEEDED",
        amountCents: 10000,
        refundedAmountCents: 0,
      });
      mocks.memberCreditAggregate.mockResolvedValue({ _sum: { amountCents: 6000 } });
      mocks.refundRequestFindUnique.mockResolvedValue(approvedRefundRequest());

      const response = await PUT(approveFor(5000), { params: Promise.resolve({ id: "refund_1" }) });

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: "Amount exceeds maximum refundable of $40.00",
      });
      expect(mocks.memberCreditAggregate).toHaveBeenCalledWith({
        where: {
          sourceBookingId: { in: ["booking_1"] },
          type: "CANCELLATION_REFUND",
          description: { startsWith: "Internet Banking payment credit for " },
        },
        _sum: { amountCents: true },
      });
      expect(mocks.refundRequestUpdateMany).not.toHaveBeenCalled();
      expect(mocks.manualRefundTaskCreateMany).not.toHaveBeenCalled();
    });

    it("late cash on an organisation booking: its open cancellation hand-back is netted", async () => {
      mocks.paymentFindUnique.mockResolvedValue({
        id: "payment_1",
        bookingId: "booking_1",
        source: "INTERNET_BANKING",
        status: "SUCCEEDED",
        amountCents: 10000,
        refundedAmountCents: 0,
      });
      // The #3369 organisation hand-back: no occurrence key, any amount.
      mocks.manualRefundTaskAggregate.mockResolvedValue({ _sum: { amountCents: 10000 } });
      mocks.refundRequestFindUnique.mockResolvedValue(approvedRefundRequest());

      const response = await PUT(approveFor(100), { params: Promise.resolve({ id: "refund_1" }) });

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: "Amount exceeds maximum refundable of $0.00",
      });
      expect(mocks.refundRequestUpdateMany).not.toHaveBeenCalled();
    });
  });

  // #1039 item 1 (PR #846 residual): a failed Stripe refund no longer bounces
  // the claim back to PENDING — the approval stands and a durable payment
  // recovery operation completes the refund without an operator.
  it("keeps the approval and enqueues durable refund recovery when the Stripe refund fails", async () => {
    mocks.refundRequestFindUnique.mockResolvedValue(approvedRefundRequest());
    mocks.refundRequestUpdateMany.mockResolvedValue({ count: 1 });
    mocks.refundPaymentTransactions.mockRejectedValue(new Error("stripe down"));
    mocks.enqueueRefundRequestRefundRecovery.mockResolvedValue({ id: "op_1" });

    const response = await PUT(approveRequest(), {
      params: Promise.resolve({ id: "refund_1" }),
    });

    expect(response.status).toBe(200);
    // Only the claiming updateMany runs; the claim is never reverted.
    expect(mocks.refundRequestUpdateMany).toHaveBeenCalledTimes(1);
    // #1510: the recovery row carries the frozen plan (the exact slices the
    // inline attempt executed), not a remainder, so the cron replays byte-
    // identical keys.
    expect(mocks.enqueueRefundRequestRefundRecovery).toHaveBeenCalledWith(
      expect.objectContaining({
        refundRequestId: "refund_1",
        amountCents: 2500,
        allocationPlan: [{ paymentTransactionId: "txn_1", amountCents: 2500 }],
      })
    );
    // The Xero credit note still queues: the refund will complete durably.
    expect(mocks.enqueueXeroRefundCreditNoteOperation).toHaveBeenCalled();
  });

  // #1510: one frozen plan drives BOTH the inline refund and the durable
  // recovery, so a multi-transaction partial-progress replay re-requests the
  // identical `refund_request_<id>_<txn>_<amount>` Stripe keys instead of a
  // re-derived, shifted allocation that would mint new refunds.
  it("passes the identical frozen slices to both the inline refund and the recovery enqueue on failure", async () => {
    mocks.refundRequestFindUnique.mockResolvedValue(approvedRefundRequest());
    mocks.refundRequestUpdateMany.mockResolvedValue({ count: 1 });
    const frozenPlan = [
      { paymentTransactionId: "txn_new", amountCents: 1500 },
      { paymentTransactionId: "txn_old", amountCents: 1000 },
    ];
    mocks.planStripeRefundAllocation.mockResolvedValue({
      slices: frozenPlan,
      plannedAmountCents: 2500,
      totalRefundableCents: 8000,
    });
    mocks.refundPaymentTransactions.mockRejectedValue(new Error("stripe down"));
    mocks.enqueueRefundRequestRefundRecovery.mockResolvedValue({ id: "op_1" });

    const response = await PUT(approveRequest(), {
      params: Promise.resolve({ id: "refund_1" }),
    });

    expect(response.status).toBe(200);
    const [inlineArgs] = mocks.refundPaymentTransactions.mock.calls[0] as [
      { allocation: unknown; amountCents: number; idempotencyKeyPrefix: string },
    ];
    expect(inlineArgs.allocation).toEqual(frozenPlan);
    expect(inlineArgs.amountCents).toBe(2500);
    expect(inlineArgs.idempotencyKeyPrefix).toBe("refund_request_refund_1");
    const [enqueueArgs] = mocks.enqueueRefundRequestRefundRecovery.mock
      .calls[0] as [{ allocationPlan: unknown; amountCents: number }];
    expect(enqueueArgs.allocationPlan).toEqual(frozenPlan);
    expect(enqueueArgs.amountCents).toBe(2500);
    // Literally one frozen plan object, shared by both paths.
    expect(enqueueArgs.allocationPlan).toBe(inlineArgs.allocation);
  });

  it("falls back to releasing the claim when the recovery enqueue also fails", async () => {
    mocks.refundRequestFindUnique.mockResolvedValue(approvedRefundRequest());
    mocks.refundRequestUpdateMany.mockResolvedValue({ count: 1 });
    mocks.refundPaymentTransactions.mockRejectedValue(new Error("stripe down"));
    mocks.enqueueRefundRequestRefundRecovery.mockRejectedValue(
      new Error("db unavailable")
    );

    const response = await PUT(approveRequest(), {
      params: Promise.resolve({ id: "refund_1" }),
    });

    expect(response.status).toBe(500);
    expect(mocks.refundRequestUpdateMany).toHaveBeenCalledTimes(2);
    expect(mocks.refundRequestUpdateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: { id: "refund_1", status: "APPROVED" },
        data: expect.objectContaining({ status: "PENDING", approvedAmountCents: null }),
      })
    );
    expect(mocks.enqueueXeroRefundCreditNoteOperation).not.toHaveBeenCalled();
  });

  /*
    CT-4 (#2870), epic #2988 — the lodge nights this email prints are CALENDAR
    DAYS, so no timezone touches them.

    `Booking.checkIn` / `checkOut` are `@db.Date`. They used to reach the member
    through `formatNZDate`, which is an INSTANT formatter: it takes the column's
    UTC-midnight encoding and asks what civil day that moment falls on in a
    zone. For New Zealand that is midday on the same date, so the answer was
    right and stayed right. Anywhere behind UTC it is the evening BEFORE, and the
    member is told their stay starts a day earlier than it does — on the email
    confirming a refund decision about that stay.

    WHAT THIS PROVES, AND WHAT IT CANNOT. It proves the two dates in the email
    are the stored days, read with no zone at all. It says NOTHING about which
    zone AUTHORITY the route obeys, because a correct calendar-day read consults
    none: `src/app/api/admin/refund-requests/[id]/route.ts` contains no
    `clubTime()` / `clubTimeZone()` call, and an earlier version of this test
    persisted `America/Denver` into a Prisma mock the route never reads — 0
    delegate calls, measured — behind a comment claiming the two zones had to
    differ so a zoned read could be told from a zone-free one. They did not, and
    it could not. The premise below is the thing that actually keeps the
    assertion honest: it checks that the INSTANT formatter would answer
    differently, so the fixture can still catch a regression to it.
  */
  it("prints the stored lodge nights in the outcome email, with no zone applied", async () => {
    // The defect, spelled out on this very fixture: read 1 July's `@db.Date`
    // encoding as a moment in a zone behind UTC and the member is told 30 June.
    expect(
      formatClubInstantDate(
        requireInstant(new Date("2026-07-01T00:00:00.000Z")),
        requireClubTimeZone("America/Denver"),
        CLUB_FORMAT_TEST,
      ),
      "This fixture no longer distinguishes a calendar-day read from an instant " +
        "one, so the assertion below cannot fail for the right reason.",
    ).toBe("30 Jun 2026");

    mocks.refundRequestFindUnique.mockResolvedValue(approvedRefundRequest());
    mocks.refundRequestUpdateMany.mockResolvedValue({ count: 1 });

    const response = await PUT(approveRequest(), {
      params: Promise.resolve({ id: "refund_1" }),
    });

    expect(response.status).toBe(200);
    expect(mocks.sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        templateData: expect.objectContaining({
          // The house medium shape, unchanged from what `formatNZDate` produced
          // in New Zealand — and the stay's real dates, which the instant
          // formatter would not give anywhere behind UTC.
          checkIn: "1 Jul 2026",
          checkOut: "3 Jul 2026",
        }),
      }),
    );
  });

  // #1792: admin per-action member-email choice. `notifyMember` gates ONLY the
  // outcome notice — the refund decision, ledger/aggregate math, and Stripe/Xero
  // work are byte-identical regardless of the choice, and the suppression is
  // recorded honestly (only when there was an email to suppress).
  describe("notifyMember email choice (#1792)", () => {
    function putRequest(body: Record<string, unknown>) {
      return new NextRequest(
        "http://localhost/api/admin/refund-requests/refund_1",
        {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            "x-forwarded-for": "127.0.0.1",
          },
          body: JSON.stringify(body),
        }
      );
    }

    // The exact refund the approve path always issues; asserted identical for
    // both the default (notify) and the suppress (notifyMember:false) cases so a
    // suppressed notice can never change what money moves.
    const EXPECTED_REFUND = {
      paymentId: "payment_1",
      amountCents: 2500,
      allocation: [{ paymentTransactionId: "txn_1", amountCents: 2500 }],
      metadata: {
        bookingId: "booking_1",
        reason: "refund_appeal_approved",
        refundRequestId: "refund_1",
      },
      idempotencyKeyPrefix: "refund_request_refund_1",
      format: CLUB_FORMAT_TEST,
    };

    function auditMetadata(action: string) {
      return mocks.createAuditLog.mock.calls.find(
        (c) => (c[0] as { action?: string } | undefined)?.action === action
      )?.[0]?.metadata as Record<string, unknown> | undefined;
    }

    it("approve without the flag emails the member and records no notify field", async () => {
      mocks.refundRequestFindUnique.mockResolvedValue(approvedRefundRequest());

      const response = await PUT(
        putRequest({ status: "APPROVED", approvedAmountCents: 2500 }),
        { params: Promise.resolve({ id: "refund_1" }) }
      );

      expect(response.status).toBe(200);
      expect(mocks.sendEmail).toHaveBeenCalledTimes(1);
      // #2321: the approve arm must send the APPROVED-outcome template —
      // renaming either key in the route goes red here, not in a member's
      // inbox. BOTH halves are pinned: `templateName` selects the club's saved
      // override, but `html` is the body a club with NO override actually
      // receives, so swapping only the HTML builders would otherwise post
      // decline wording to an approved member unnoticed.
      expect(mocks.sendEmail).toHaveBeenCalledWith(
        expect.objectContaining({ templateName: "refund-request-approved" })
      );
      expect(mocks.refundRequestApprovedTemplate).toHaveBeenCalledTimes(1);
      expect(mocks.refundRequestDeclinedTemplate).not.toHaveBeenCalled();
      expect(mocks.refundPaymentTransactions).toHaveBeenCalledWith(EXPECTED_REFUND);
      expect(mocks.enqueueXeroRefundCreditNoteOperation).toHaveBeenCalled();
      expect(auditMetadata("refund-request.approve")).not.toHaveProperty(
        "notifyMember"
      );
    });

    it("approve with notifyMember:false suppresses the email, audits the choice, and moves money identically", async () => {
      mocks.refundRequestFindUnique.mockResolvedValue(approvedRefundRequest());

      const response = await PUT(
        putRequest({
          status: "APPROVED",
          approvedAmountCents: 2500,
          notifyMember: false,
        }),
        { params: Promise.resolve({ id: "refund_1" }) }
      );

      expect(response.status).toBe(200);
      // No outcome notice went out...
      expect(mocks.sendEmail).not.toHaveBeenCalled();
      // ...but the refund and credit note are byte-identical to the default case.
      expect(mocks.refundPaymentTransactions).toHaveBeenCalledWith(EXPECTED_REFUND);
      expect(mocks.enqueueXeroRefundCreditNoteOperation).toHaveBeenCalledWith(
        "payment_1",
        2500,
        { createdByMemberId: "admin_1" }
      );
      expect(auditMetadata("refund-request.approve")).toMatchObject({
        bookingId: "booking_1",
        approvedAmountCents: 2500,
        notifyMember: false,
      });
    });

    it("approve with notifyMember:true emails the member and records no notify field", async () => {
      mocks.refundRequestFindUnique.mockResolvedValue(approvedRefundRequest());

      const response = await PUT(
        putRequest({
          status: "APPROVED",
          approvedAmountCents: 2500,
          notifyMember: true,
        }),
        { params: Promise.resolve({ id: "refund_1" }) }
      );

      expect(response.status).toBe(200);
      expect(mocks.sendEmail).toHaveBeenCalledTimes(1);
      // #2321: outcome-template pinning (see the default-notify approve case).
      expect(mocks.sendEmail).toHaveBeenCalledWith(
        expect.objectContaining({ templateName: "refund-request-approved" })
      );
      expect(mocks.refundRequestApprovedTemplate).toHaveBeenCalledTimes(1);
      expect(mocks.refundRequestDeclinedTemplate).not.toHaveBeenCalled();
      expect(mocks.refundPaymentTransactions).toHaveBeenCalledWith(EXPECTED_REFUND);
      expect(auditMetadata("refund-request.approve")).not.toHaveProperty(
        "notifyMember"
      );
    });

    it("rejects a non-boolean notifyMember on approve with 400 and touches no money", async () => {
      mocks.refundRequestFindUnique.mockResolvedValue(approvedRefundRequest());

      const response = await PUT(
        putRequest({
          status: "APPROVED",
          approvedAmountCents: 2500,
          notifyMember: "false",
        }),
        { params: Promise.resolve({ id: "refund_1" }) }
      );

      expect(response.status).toBe(400);
      expect(mocks.refundPaymentTransactions).not.toHaveBeenCalled();
      expect(mocks.refundRequestUpdateMany).not.toHaveBeenCalled();
      expect(mocks.sendEmail).not.toHaveBeenCalled();
      expect(mocks.createAuditLog).not.toHaveBeenCalled();
    });

    it("reject without the flag emails the member and records no notify field", async () => {
      mocks.refundRequestFindUnique.mockResolvedValue(approvedRefundRequest());

      const response = await PUT(putRequest({ status: "REJECTED" }), {
        params: Promise.resolve({ id: "refund_1" }),
      });

      expect(response.status).toBe(200);
      expect(mocks.sendEmail).toHaveBeenCalledTimes(1);
      // #2321: the reject arm must send the DECLINED-outcome template — the
      // exact wiring whose absence let a declined member be told "approved".
      // Both halves pinned (see the approve case): the HTML builder is the
      // body a club with no saved override actually receives.
      expect(mocks.sendEmail).toHaveBeenCalledWith(
        expect.objectContaining({ templateName: "refund-request-declined" })
      );
      expect(mocks.refundRequestDeclinedTemplate).toHaveBeenCalledTimes(1);
      expect(mocks.refundRequestApprovedTemplate).not.toHaveBeenCalled();
      // Reject never refunds; only the claiming updateMany runs.
      expect(mocks.refundPaymentTransactions).not.toHaveBeenCalled();
      expect(mocks.refundRequestUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "refund_1", status: "PENDING" },
          data: expect.objectContaining({
            status: "REJECTED",
            approvedAmountCents: 0,
          }),
        })
      );
      expect(auditMetadata("refund-request.reject")).not.toHaveProperty(
        "notifyMember"
      );
    });

    it("reject with notifyMember:false suppresses the email, audits the choice, and applies the decision identically", async () => {
      mocks.refundRequestFindUnique.mockResolvedValue(approvedRefundRequest());

      const response = await PUT(
        putRequest({ status: "REJECTED", notifyMember: false }),
        { params: Promise.resolve({ id: "refund_1" }) }
      );

      expect(response.status).toBe(200);
      expect(mocks.sendEmail).not.toHaveBeenCalled();
      expect(mocks.refundPaymentTransactions).not.toHaveBeenCalled();
      expect(mocks.refundRequestUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "refund_1", status: "PENDING" },
          data: expect.objectContaining({
            status: "REJECTED",
            approvedAmountCents: 0,
          }),
        })
      );
      expect(auditMetadata("refund-request.reject")).toMatchObject({
        bookingId: "booking_1",
        notifyMember: false,
      });
    });

    it("reject with notifyMember:true emails the member and records no notify field", async () => {
      mocks.refundRequestFindUnique.mockResolvedValue(approvedRefundRequest());

      const response = await PUT(
        putRequest({ status: "REJECTED", notifyMember: true }),
        { params: Promise.resolve({ id: "refund_1" }) }
      );

      expect(response.status).toBe(200);
      expect(mocks.sendEmail).toHaveBeenCalledTimes(1);
      // #2321: outcome-template pinning (see the default-notify reject case).
      expect(mocks.sendEmail).toHaveBeenCalledWith(
        expect.objectContaining({ templateName: "refund-request-declined" })
      );
      expect(mocks.refundRequestDeclinedTemplate).toHaveBeenCalledTimes(1);
      expect(mocks.refundRequestApprovedTemplate).not.toHaveBeenCalled();
      expect(auditMetadata("refund-request.reject")).not.toHaveProperty(
        "notifyMember"
      );
    });

    it("rejects a non-boolean notifyMember on reject with 400 and makes no decision", async () => {
      mocks.refundRequestFindUnique.mockResolvedValue(approvedRefundRequest());

      const response = await PUT(
        putRequest({ status: "REJECTED", notifyMember: 0 }),
        { params: Promise.resolve({ id: "refund_1" }) }
      );

      expect(response.status).toBe(400);
      expect(mocks.refundRequestUpdateMany).not.toHaveBeenCalled();
      expect(mocks.sendEmail).not.toHaveBeenCalled();
      expect(mocks.createAuditLog).not.toHaveBeenCalled();
    });
  });
});

// ---------------------------------------------------------------------------
// Per-area gate (#2921 / the fork PR #2949 shape). This route declares
// `{ area: "finance", level: "edit" }` and moves member money. Before the sweep
// the mock never received that requirement, so every test above proved only that
// the actor was *some* admin — and re-pointing the literal at
// `{ area: "overview", level: "view" }` would have left the whole file green.
//
// Denials need no fixtures: `requireAdmin` answers before the handler reads the
// refund request, so a 403 plus an untouched transaction is the whole assertion.
// The positive control is every test above, which approves refunds as a full
// ADMIN and does hold `finance: edit`.
// ---------------------------------------------------------------------------
describe("per-area gate on PUT /api/admin/refund-requests/[id] (#2921)", () => {
  function approveRequest() {
    return new NextRequest(
      "http://localhost/api/admin/refund-requests/refund_1",
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "x-forwarded-for": "127.0.0.1",
        },
        body: JSON.stringify({ status: "APPROVED", approvedAmountCents: 2500 }),
      },
    );
  }

  const routeParams = { params: Promise.resolve({ id: "refund_1" }) };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireActiveSessionUser.mockResolvedValue(null);
  });

  it("refuses a view-only admin, so the level half of finance:edit is real", async () => {
    mocks.auth.mockResolvedValue(readOnlyAdminSession);

    const response = await PUT(approveRequest(), routeParams);

    expect(response.status).toBe(403);
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.refundPaymentTransactions).not.toHaveBeenCalled();
  });

  it("refuses an admin with no finance access, so the area half is real", async () => {
    mocks.auth.mockResolvedValue(contentAdminSession);

    const response = await PUT(approveRequest(), routeParams);

    expect(response.status).toBe(403);
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.refundPaymentTransactions).not.toHaveBeenCalled();
  });
});
