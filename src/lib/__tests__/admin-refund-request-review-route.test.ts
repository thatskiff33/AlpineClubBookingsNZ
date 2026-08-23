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
    error: vi.fn(),
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
    mocks.paymentFindUnique.mockResolvedValue({
      amountCents: 10000,
      refundedAmountCents: 0,
    });
    mocks.paymentUpdate.mockResolvedValue({});
    mocks.transaction.mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) =>
      callback({
        refundRequest: {
          updateMany: mocks.refundRequestUpdateMany,
        },
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
