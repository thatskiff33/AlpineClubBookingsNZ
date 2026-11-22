/**
 * ALP-721 (`INV-MCP-006`): the Finance area's money actions, each held to the
 * contract it exposes (`expectActionContract`):
 *
 * - the connection is answered with exactly the action's `returns` fields, so
 *   a field the finance screen reads but the action does not name (an email
 *   address, a Stripe id, a raw ledger row) never reaches the AI provider;
 * - the browser's answer is unchanged;
 * - the request the catalogue builds is the one the route accepts, and money
 *   travels as integer cents.
 *
 * The route's own guard is stubbed to admit a finance officer: who may call
 * each route is the route map's and the guard's job, tested with them, and
 * who is shown each action is `mcp-finance-action-visibility.test.ts`.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  listAdminPayments: vi.fn(),
  createAdminAdjustmentRequest: vi.fn(),
  getAdminAdjustmentRequests: vi.fn(),
  getMemberCreditBalance: vi.fn(),
  getAdminMemberCreditHistory: vi.fn(),
  getPendingAdminAdjustmentRequests: vi.fn(),
  reviewAdminAdjustmentRequest: vi.fn(),
  listOpeningCreditBatches: vi.fn(),
  generateAdminPaymentInvoice: vi.fn(),
  markUnmatchedBankRefundVoidAnswered: vi.fn(),
  toOpenManualRefundTaskPayloads: vi.fn(),
  toAutoRefundedManualRefundTaskPayload: vi.fn(),
  toDismissedManualRefundTaskPayload: vi.fn(),
  readApprovedAppealOutcomes: vi.fn(),
  organiserCardAppealCeilingFor: vi.fn(),
  resolveMetricsCapacityAndScope: vi.fn(),
  buildRevenueSeries: vi.fn(),
  getXeroContactGroupMemberships: vi.fn(),
  applyManualSubscriptionPayment: vi.fn(),
  applyManualBookingPayment: vi.fn(),
  prisma: {
    manualRefundTask: { findMany: vi.fn() },
    refundRequest: { findMany: vi.fn(), count: vi.fn() },
    booking: { findMany: vi.fn() },
    payment: { findMany: vi.fn() },
    member: { count: vi.fn(), findMany: vi.fn() },
    memberSubscription: { count: vi.fn(), findMany: vi.fn() },
  },
}));

vi.mock("@/lib/prisma", () => ({ prisma: h.prisma }));
vi.mock("@/lib/admin-page-revalidation", () => ({ revalidateAdminPage: vi.fn() }));
vi.mock("@/lib/admin-payment-invoice-service", () => ({ generateAdminPaymentInvoice: h.generateAdminPaymentInvoice }));
vi.mock("@/lib/bank-refund-void-follow-up", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/bank-refund-void-follow-up")),
  markUnmatchedBankRefundVoidAnswered: h.markUnmatchedBankRefundVoidAnswered,
}));
vi.mock("@/lib/manual-refund-task-queue-reads", () => ({
  NOT_RETIRED_REVIEW_WHERE: {},
  readOrDegrade: async (query: Promise<unknown[]>) => ({ rows: await query, unavailable: false }),
  readDismissedManualRefundTasks: async () => [{ id: "dismissed-row" }],
  readOpenTaskDisputes: async () => new Map(),
}));
vi.mock("@/lib/manual-refund-task-queue-payload", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/manual-refund-task-queue-payload")),
  toOpenManualRefundTaskPayloads: h.toOpenManualRefundTaskPayloads,
  toAutoRefundedManualRefundTaskPayload: h.toAutoRefundedManualRefundTaskPayload,
  toDismissedManualRefundTaskPayload: h.toDismissedManualRefundTaskPayload,
}));
vi.mock("@/lib/refund-appeal-outcome", () => ({ readApprovedAppealOutcomes: h.readApprovedAppealOutcomes }));
vi.mock("@/lib/organiser-child-refund", () => ({ organiserCardAppealCeilingFor: h.organiserCardAppealCeilingFor }));
vi.mock("@/lib/superseded-capture-hold-back", () => ({
  readSupersededCaptureHeldBack: async () => ({ byTransaction: new Map(), totalCents: 0 }),
}));
vi.mock("@/lib/club-time/server", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/club-time/server")),
  clubTimeZone: async () => "Pacific/Auckland",
}));
vi.mock("@/lib/club-format-server", () => ({
  clubFormatValues: async () => ({}),
  clubFormat: async () => ({ cents: (cents: number) => `$${(cents / 100).toFixed(2)}` }),
}));
vi.mock("@/lib/lodges", () => ({ resolveOptionalActiveLodgeId: async (_db: unknown, id: string) => id }));
vi.mock("@/lib/finance-booking-metrics", () => ({ resolveMetricsCapacityAndScope: h.resolveMetricsCapacityAndScope }));
vi.mock("@/lib/refunds-and-credits-owed", () => ({
  readRefundsAndCreditsOwed: async () => ({ refundsOwedCents: 7_000, creditsOwedCents: 3_000 }),
}));
vi.mock("@/lib/admin-reports", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/admin-reports")),
  buildRevenueSeries: h.buildRevenueSeries,
}));
vi.mock("@/lib/age-tier", () => ({ getAgeTierSettings: async () => [] }));
vi.mock("@/lib/xero-contact-groups", () => ({
  getXeroContactIdsForGroup: vi.fn(async () => []),
  getXeroContactGroupMemberships: h.getXeroContactGroupMemberships,
}));
vi.mock("@/lib/adult-member-hosting-retry-response", () => ({ hostingCoverageParticipantRetryResponse: () => null }));
vi.mock("@/lib/manual-subscription-payment", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/manual-subscription-payment")),
  applyManualSubscriptionPayment: h.applyManualSubscriptionPayment,
}));
vi.mock("@/lib/manual-booking-payment", () => ({ applyManualBookingPayment: h.applyManualBookingPayment }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/manual-refund-task-settlement-rules", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/manual-refund-task-settlement-rules")),
  refundAppealCeilingParts: () => ({ ceilingCents: 30_000, cardRefundOwedCents: 0 }),
}));
vi.mock("@/lib/session-guards", () => ({ requireAdmin: h.requireAdmin }));
vi.mock("@/lib/admin-payments-service", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/admin-payments-service")),
  listAdminPayments: h.listAdminPayments,
}));
vi.mock("@/lib/member-credit", () => ({
  getMemberCreditBalance: h.getMemberCreditBalance,
  getAdminMemberCreditHistory: h.getAdminMemberCreditHistory,
  getPendingAdminAdjustmentRequests: h.getPendingAdminAdjustmentRequests,
  createAdminAdjustmentRequest: h.createAdminAdjustmentRequest,
  getAdminAdjustmentRequests: h.getAdminAdjustmentRequests,
  reviewAdminAdjustmentRequest: h.reviewAdminAdjustmentRequest,
}));
vi.mock("@/lib/opening-credit-batch", () => ({ listOpeningCreditBatches: h.listOpeningCreditBatches }));
vi.mock("@/lib/rate-limit", () => ({ getClientIp: vi.fn(() => "203.0.113.9") }));
vi.mock("@/lib/logger", () => ({ default: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));

import { GET as listCreditApprovals } from "@/app/api/admin/credit-approvals/route";
import { PATCH as reviewCreditAdjustment } from "@/app/api/admin/members/[id]/credits/[requestId]/route";
import { GET as getMemberCredits, POST as requestCreditAdjustment } from "@/app/api/admin/members/[id]/credits/route";
import { GET as listOpeningCredits } from "@/app/api/admin/opening-credits/route";
import { POST as answerBankRefundVoid } from "@/app/api/admin/payments/bank-refund-voids/[id]/answered/route";
import { POST as generatePaymentInvoice } from "@/app/api/admin/payments/[id]/generate-invoice/route";
import { GET as listManualRefundTasks } from "@/app/api/admin/payments/manual-refund-tasks/route";
import { GET as listRefundRequests } from "@/app/api/admin/refund-requests/route";
import { GET as getFinanceReport } from "@/app/api/admin/reports/route";
import { GET as listSubscriptions } from "@/app/api/admin/subscriptions/route";
import { POST as recordSubscriptionPayment } from "@/app/api/admin/subscriptions/[id]/manual-payment/route";
import { POST as recordBookingPayment } from "@/app/api/admin/bookings/[id]/mark-paid/route";
import { GET as listPayments } from "@/app/api/admin/payments/route";
import { expectActionContract } from "@/lib/__tests__/helpers/mcp-action-contract";
import { adminSession } from "@/lib/__tests__/helpers/sessions";
import { findMcpAction, mcpActionInputSchema } from "@/lib/mcp/catalogue";
import { MCP_PRINCIPAL_HEADER } from "@/lib/mcp/principal";

const financeOfficer = adminSession({ id: "treasurer-1", accessRoles: ["USER", "FINANCE_ADMIN"] });

beforeEach(() => {
  vi.clearAllMocks();
  h.requireAdmin.mockResolvedValue({ ok: true, session: financeOfficer });
});

describe("list_payments", () => {
  const PAYMENTS_BODY = {
    data: [
      {
        id: "pay-1",
        bookingId: "booking-1",
        amountCents: 42_000,
        source: "STRIPE",
        reference: "BK-1001",
        status: "SUCCEEDED",
        stripePaymentIntentId: "pi_secret_ref",
        xeroInvoiceId: "xero-inv-uuid",
        xeroInvoiceNumber: "INV-0042",
        refundedAmountCents: 0,
        additionalAmountCents: 0,
        additionalPaymentStatus: null,
        lastUpdatedAt: "2026-06-30T01:00:00.000Z",
        updatedAt: "2026-06-30T01:00:00.000Z",
        xeroActivity: { failed: 0, partial: 0, pending: 0 },
        xeroState: "synced",
        settlementKind: "none",
        disputes: [],
        booking: {
          id: "booking-1",
          status: "CONFIRMED",
          checkIn: "2026-07-10T00:00:00.000Z",
          checkOut: "2026-07-12T00:00:00.000Z",
          creditsFromCancellation: [{ amountCents: 100, description: "x" }],
          member: { id: "m-1", firstName: "Aroha", lastName: "Ngata", email: "aroha@example.org" },
          organisation: { name: "Ski School", email: "office@example.org" },
        },
      },
    ],
    total: 1,
    page: 1,
    pageSize: 25,
    summary: {
      netCollectedCents: 42_000,
      refundsOwedCents: 0,
      creditsOwedCents: 0,
      refundedCents: 0,
      count: 1,
      additionalLedgerGapCents: 0,
      additionalLedgerGapBookings: 0,
    },
  };

  it("answers with the payment and booking fields, never contact details or provider ids", async () => {
    h.listAdminPayments.mockResolvedValue({ body: PAYMENTS_BODY });
    const { connection, browser } = await expectActionContract({
      actionId: "list_payments",
      handler: listPayments,
      args: { status: "SUCCEEDED", checkInFrom: "2026-07-01", page: 1 },
    });
    expect(JSON.stringify(connection)).not.toMatch(/aroha@example\.org|pi_secret_ref|xero-inv-uuid/);
    expect(browser).toEqual(PAYMENTS_BODY);
    expect(h.listAdminPayments).toHaveBeenCalledWith(
      expect.objectContaining({ status: "SUCCEEDED", checkInFrom: "2026-07-01", page: 1 }),
    );
  });

  it("offers no dollar amount filter: an app reads and sends cents", () => {
    const keys = Object.keys(mcpActionInputSchema(findMcpAction("list_payments")!).shape);
    expect(keys).not.toEqual(expect.arrayContaining(["amountExact"]));
    expect(keys.filter((key) => key.startsWith("amount"))).toEqual([]);
  });
});

describe("request_credit_adjustment", () => {
  const ARGS = {
    id: "member-7",
    amountCents: 2_500,
    description: "Goodwill for the broken heater",
    idempotencyKey: "9a7f3c1e-2b4d-4e8f-9a1b-3c5d7e9f1a2b",
    grantAccount: "GOODWILL",
  };

  it("asks for the adjustment in cents for a second officer to approve", async () => {
    h.createAdminAdjustmentRequest.mockResolvedValue({
      request: { id: "adj-1", status: "PENDING", memberId: "member-7", amountCents: 2_500 },
      replayed: false,
    });
    const { connection, browser } = await expectActionContract({
      actionId: "request_credit_adjustment",
      handler: requestCreditAdjustment,
      args: ARGS,
    });
    expect(connection).toEqual({
      success: true,
      requestId: "adj-1",
      requestStatus: "PENDING",
      replayed: false,
      message: expect.stringContaining("submitted for approval"),
    });
    expect(browser).toEqual(connection);
    expect(h.createAdminAdjustmentRequest).toHaveBeenCalledWith(
      "member-7",
      2_500,
      "Goodwill for the broken heater",
      "treasurer-1",
      ARGS.idempotencyKey,
      "GOODWILL",
      "203.0.113.9",
    );
  });

  it("refuses a fractional amount before the route sees it", () => {
    const schema = mcpActionInputSchema(findMcpAction("request_credit_adjustment")!);
    expect(schema.safeParse({ ...ARGS, amountCents: 25.5 }).success).toBe(false);
  });
});

// A member as the credit screens name them, and the contact detail that must stay behind.
const AROHA = { id: "member-7", firstName: "Aroha", lastName: "Ngata", email: "aroha@example.org" };
const TREASURER = { id: "treasurer-1", firstName: "Tama", lastName: "Reti" };
const SECRETARY = { id: "secretary-2", firstName: "Mere", lastName: "Hohaia" };

describe("list_credit_adjustment_requests", () => {
  const REQUESTS = [
    {
      id: "adj-1",
      memberId: "member-7",
      amountCents: 2_500,
      description: "Goodwill for the broken heater",
      grantAccount: "GOODWILL",
      status: "APPROVED",
      requestedById: "treasurer-1",
      reviewedById: "secretary-2",
      reviewedAt: "2026-06-30T02:00:00.000Z",
      createdAt: "2026-06-30T01:00:00.000Z",
      idempotencyKey: "9a7f3c1e-2b4d-4e8f-9a1b-3c5d7e9f1a2b",
      member: AROHA,
      requestedBy: TREASURER,
      reviewedBy: SECRETARY,
      approvedCredit: { id: "credit-1", createdAt: "2026-06-30T02:00:00.000Z" },
    },
  ];

  it("answers a connection with the requests under `requests`, the browser with the bare list", async () => {
    h.getAdminAdjustmentRequests.mockResolvedValue(REQUESTS);
    const { connection, browser } = await expectActionContract({
      actionId: "list_credit_adjustment_requests",
      handler: listCreditApprovals,
      args: { status: "approved" },
    });
    expect(JSON.stringify(connection)).not.toMatch(/aroha@example\.org|9a7f3c1e/);
    expect(browser).toEqual(REQUESTS);
    // The route still reads the filter case-insensitively.
    expect(h.getAdminAdjustmentRequests).toHaveBeenCalledWith("APPROVED");
  });

  it("lists the pending requests for a filter it does not know, as the queue always has", async () => {
    h.getAdminAdjustmentRequests.mockResolvedValue(REQUESTS);
    const schema = mcpActionInputSchema(findMcpAction("list_credit_adjustment_requests")!);
    expect(schema.parse({ status: "nonsense" })).toEqual({ status: "PENDING" });
    expect(schema.parse({})).toEqual({ status: "PENDING" });
    await listCreditApprovals(new NextRequest("https://club.example.test/api/admin/credit-approvals?status=nonsense"));
    expect(h.getAdminAdjustmentRequests).toHaveBeenLastCalledWith("PENDING");
  });
});

describe("get_member_credits", () => {
  const STAY = { id: "booking-1", checkIn: "2026-07-10T00:00:00.000Z", checkOut: "2026-07-12T00:00:00.000Z" };
  const HISTORY = [
    {
      id: "credit-1",
      memberId: "member-7",
      amountCents: -1_500,
      type: "ADMIN_ADJUSTMENT",
      description: "Spent on a stay",
      xeroCreditNoteId: "xero-cn-uuid",
      xeroCashCreditId: "cash-credit-row",
      approvalRequestId: "adj-1",
      createdAt: "2026-06-30T01:00:00.000Z",
      sourceBooking: STAY,
      appliedToBooking: STAY,
      requestedBy: TREASURER,
      approvedBy: SECRETARY,
      approvalRequest: { createdAt: "2026-06-29T01:00:00.000Z", reviewedAt: "2026-06-30T01:00:00.000Z" },
    },
  ];
  const PENDING = [
    {
      id: "adj-2",
      memberId: "member-7",
      amountCents: 1_000,
      description: "Ski pass refund",
      grantAccount: "MEMBER_OWN_MONEY",
      status: "PENDING",
      requestedById: "treasurer-1",
      idempotencyKey: "4b1c2d3e-5f6a-4b7c-8d9e-0f1a2b3c4d5e",
      xeroCashCreditId: null,
      createdAt: "2026-06-30T03:00:00.000Z",
      requestedBy: TREASURER,
    },
  ];

  it("answers with the balance, the ledger and the pending requests, never provider ids or idempotency keys", async () => {
    h.getMemberCreditBalance.mockResolvedValue(4_000);
    h.getAdminMemberCreditHistory.mockResolvedValue(HISTORY);
    h.getPendingAdminAdjustmentRequests.mockResolvedValue(PENDING);
    const { connection, browser } = await expectActionContract({
      actionId: "get_member_credits",
      handler: getMemberCredits,
      args: { id: "member-7" },
    });
    expect(JSON.stringify(connection)).not.toMatch(/xero-cn-uuid|cash-credit-row|4b1c2d3e/);
    expect(browser).toEqual({ balanceCents: 4_000, history: HISTORY, pendingRequests: PENDING });
    // Each read is for the member the app named, not the officer calling.
    for (const read of [h.getMemberCreditBalance, h.getAdminMemberCreditHistory, h.getPendingAdminAdjustmentRequests]) {
      expect(read).toHaveBeenCalledWith("member-7");
    }
  });
});

describe("review_credit_adjustment", () => {
  it("records the officer's decision on the request the app named and answers with the new balance", async () => {
    h.reviewAdminAdjustmentRequest.mockResolvedValue({ decision: "APPROVE", request: { id: "adj-2" } });
    h.getMemberCreditBalance.mockResolvedValue(5_000);
    const { connection, browser } = await expectActionContract({
      actionId: "review_credit_adjustment",
      handler: reviewCreditAdjustment,
      args: { id: "member-7", requestId: "adj-2", decision: "APPROVE" },
    });
    expect(connection).toEqual({ success: true, balanceCents: 5_000, message: "Adjustment approved and applied" });
    expect(browser).toEqual(connection);
    // The reviewer is the signed-in officer: the route's second-officer rule reads it.
    expect(h.reviewAdminAdjustmentRequest).toHaveBeenCalledWith(
      "member-7",
      "adj-2",
      "APPROVE",
      "treasurer-1",
      "203.0.113.9",
    );
  });

  it("is destructive and cannot be sent without a decision", () => {
    const action = findMcpAction("review_credit_adjustment")!;
    expect(action.kind).toBe("destructive");
    expect(mcpActionInputSchema(action).safeParse({ id: "member-7", requestId: "adj-2" }).success).toBe(false);
  });
});

describe("list_opening_credit_batches", () => {
  it("answers with each batch's total, count and who posted or reversed it", async () => {
    const BATCHES = [
      {
        id: "batch-1",
        totalCents: 125_000,
        rowCount: 14,
        postedAt: "2026-06-01T00:00:00.000Z",
        reversedAt: "2026-06-02T00:00:00.000Z",
        reversalReason: "Wrong file",
        postedBy: "Tama Reti",
        reversedBy: "Mere Hohaia",
        batchKey: "sha256-of-the-file",
      },
    ];
    h.listOpeningCreditBatches.mockResolvedValue(BATCHES);
    const { connection, browser } = await expectActionContract({
      actionId: "list_opening_credit_batches",
      handler: listOpeningCredits,
    });
    expect(JSON.stringify(connection)).not.toMatch(/sha256-of-the-file/);
    expect(browser).toEqual({ batches: BATCHES });
  });
});

describe("generate_payment_invoice", () => {
  it("answers a queued invoice with its status, operation and message, never Xero's own id", async () => {
    const QUEUED = {
      status: "queued",
      queueOperationId: "op-1",
      xeroInvoiceId: null,
      xeroInvoiceNumber: null,
      message: "Xero booking invoice queued for background processing.",
    };
    h.generateAdminPaymentInvoice.mockResolvedValue({ body: QUEUED, init: { status: 202 } });
    const { connection, browser } = await expectActionContract({
      actionId: "generate_payment_invoice",
      handler: generatePaymentInvoice,
      args: { id: "pay-1" },
    });
    expect(connection).toEqual({ status: "queued", queueOperationId: "op-1", xeroInvoiceNumber: null, message: QUEUED.message });
    expect(browser).toEqual(QUEUED);
    expect(h.generateAdminPaymentInvoice).toHaveBeenCalledWith({ paymentId: "pay-1", adminMemberId: "treasurer-1" });
  });

  it("answers a raised invoice with its number and drops the Xero invoice id", async () => {
    h.generateAdminPaymentInvoice.mockResolvedValue({
      body: { status: "generated", xeroInvoiceId: "xero-inv-uuid", xeroInvoiceNumber: "INV-0042", queueOperationId: "op-1" },
    });
    const response = await generatePaymentInvoice(
      new NextRequest("https://club.example.test/api/admin/payments/pay-1/generate-invoice", {
        method: "POST",
        headers: { [MCP_PRINCIPAL_HEADER]: "contract-test-principal" },
      }),
      { params: Promise.resolve({ id: "pay-1" }) },
    );
    expect(await response.json()).toEqual({ status: "generated", xeroInvoiceNumber: "INV-0042", queueOperationId: "op-1" });
  });
});

describe("answer_bank_refund_void", () => {
  it("records the officer's note against the link the app named", async () => {
    h.markUnmatchedBankRefundVoidAnswered.mockResolvedValue({ paymentId: "pay-1", bookingId: "booking-1", linkRow: "raw" });
    const { connection, browser } = await expectActionContract({
      actionId: "answer_bank_refund_void",
      handler: answerBankRefundVoid,
      args: { id: "link-1", note: "  Paid back by bank transfer on 30 June  ", confirmed: true },
    });
    expect(connection).toEqual({ success: true, paymentId: "pay-1", bookingId: "booking-1" });
    expect(browser).toEqual({ success: true, paymentId: "pay-1", bookingId: "booking-1", linkRow: "raw" });
    // The note is normalised as the website's is, and the answer is the signed-in officer's.
    expect(h.markUnmatchedBankRefundVoidAnswered).toHaveBeenCalledWith({
      linkId: "link-1",
      note: "Paid back by bank transfer on 30 June",
      actingMemberId: "treasurer-1",
    });
  });

  it("cannot be sent without the officer's confirmation", () => {
    const schema = mcpActionInputSchema(findMcpAction("answer_bank_refund_void")!);
    expect(schema.safeParse({ id: "link-1", note: "Done" }).success).toBe(false);
    expect(schema.safeParse({ id: "link-1", note: "Done", confirmed: false }).success).toBe(false);
  });
});

describe("list_manual_refund_tasks", () => {
  const TASK = {
    id: "task-1",
    bookingId: "booking-1",
    amountCents: 12_000,
    raisedAmountCents: 15_000,
    kind: "BANK_REFUND_VOID_FOLLOW_UP",
    awaitingLateCaptureApproval: false,
    partPaymentReview: true,
    editRefundHandBack: false,
    refundRequestHandBack: false,
    paidToGroupOrganiser: false,
    groupOrganiserHandBack: false,
    journalHandBackDismissRefusal: "Wait for the dispute to close.",
    disputedHandBackLost: false,
    disputeReduction: { reducedByCents: 3_000, stillOwedCents: 9_000 },
    markPaidRefusal: null,
    cardShortfallHandBack: false,
    cardShortfallCheck: false,
    bankRefundVoidFollowUp: { voidedCreditNoteNumber: "CN-0007", voidedAt: "2026-06-29T00:00:00.000Z" },
    partPaymentReviewXeroPaid: { reportedAt: "2026-06-28T00:00:00.000Z", cashCents: 4_000 },
    reason: "Cancelled cash booking",
    createdAt: "2026-06-20T00:00:00.000Z",
    memberName: "Aroha Ngata",
    checkIn: "2026-07-10T00:00:00.000Z",
    checkOut: "2026-07-12T00:00:00.000Z",
    viewerOwnsBooking: false,
  };
  const AUTO = {
    id: "task-2",
    bookingId: "booking-2",
    amountCents: 5_000,
    reason: "Late capture refunded",
    note: "Stripe refunded it",
    refundedAt: "2026-06-25T00:00:00.000Z",
    bookingDeleted: true,
    memberName: "Aroha Ngata",
    checkIn: "2026-07-10T00:00:00.000Z",
    checkOut: "2026-07-12T00:00:00.000Z",
  };
  const DISMISSED = {
    id: "task-3",
    bookingId: "booking-3",
    amountCents: 2_000,
    kind: null,
    reason: "Cancelled cash booking",
    note: "Member kept it as credit",
    dismissedAt: "2026-06-26T00:00:00.000Z",
    bookingDeleted: false,
    memberName: "Aroha Ngata",
    checkIn: "2026-07-10T00:00:00.000Z",
    checkOut: "2026-07-12T00:00:00.000Z",
  };

  it("answers with the three lists and their read flags, never the screen's link flags", async () => {
    h.prisma.manualRefundTask.findMany.mockResolvedValue([{ id: "raw-row" }]);
    h.toOpenManualRefundTaskPayloads.mockReturnValue([TASK]);
    h.toAutoRefundedManualRefundTaskPayload.mockReturnValue(AUTO);
    h.toDismissedManualRefundTaskPayload.mockReturnValue(DISMISSED);
    const { connection, browser } = await expectActionContract({
      actionId: "list_manual_refund_tasks",
      handler: listManualRefundTasks,
    });
    expect(JSON.stringify(connection)).not.toMatch(/viewerCanViewBookings|viewerOwnsBooking/);
    expect(browser).toEqual({
      viewerCanViewBookings: true,
      tasks: [TASK],
      autoRefundedUnavailable: false,
      autoRefunded: [AUTO],
      dismissedUnavailable: false,
      dismissed: [DISMISSED],
    });
    // Each open task is shaped for the signed-in officer (its ownership flag reads their id).
    expect(h.toOpenManualRefundTaskPayloads).toHaveBeenCalledWith([{ id: "raw-row" }], "treasurer-1", expect.any(Map));
  });
});

describe("list_refund_requests", () => {
  const LISTED = {
    id: "rr-1",
    bookingId: "booking-1",
    memberId: "member-7",
    reason: "Snow closed the road",
    requestedAmountCents: 20_000,
    status: "PENDING",
    adminNotes: "Checked the road report",
    approvedAmountCents: null,
    reviewedBy: "secretary-2",
    reviewedAt: "2026-06-30T00:00:00.000Z",
    createdAt: "2026-06-29T00:00:00.000Z",
    updatedAt: "2026-06-30T00:00:00.000Z",
    member: AROHA,
    booking: {
      id: "booking-1",
      checkIn: "2026-07-10T00:00:00.000Z",
      checkOut: "2026-07-12T00:00:00.000Z",
      finalPriceCents: 30_000,
      status: "CANCELLED",
      noEmails: false,
      organiserSettled: true,
      parentBookingId: "booking-0",
      creditsFromCancellation: [
        { amountCents: 1_000, description: "Late cash", type: "CANCELLATION_REFUND", restoredFromBookingId: null },
      ],
      payment: {
        id: "pay-1",
        source: "STRIPE",
        status: "SUCCEEDED",
        amountCents: 30_000,
        refundedAmountCents: 0,
        stripePaymentIntentId: "pi_secret_ref",
        manualRefundTasks: [],
        refunds: [],
        recoveryOperations: [],
      },
    },
  };
  const OUTCOME = {
    cardRefundState: "retrying",
    cardRefundOwedCents: 5_000,
    cardRefundRefusedCents: 0,
    cardRefundUnansweredCents: 0,
    handBackOwedCents: 0,
    handBackDismissedCents: 0,
    cardRefundClosedUnpaidCents: 0,
  };

  it("answers with the appeals, their payment and ceilings, never the requester's email or the Stripe id", async () => {
    h.prisma.refundRequest.findMany.mockResolvedValue([LISTED]);
    h.prisma.refundRequest.count.mockResolvedValue(1);
    // One row carrying every field: the outcome (an approved appeal's) and the organiser cap (a pending one's).
    h.readApprovedAppealOutcomes.mockResolvedValue(new Map([["rr-1", OUTCOME]]));
    h.organiserCardAppealCeilingFor.mockResolvedValue({ ceilingCents: 25_000, combinedRefundPending: false });
    const { connection, browser } = await expectActionContract({
      actionId: "list_refund_requests",
      handler: listRefundRequests,
      args: { status: "PENDING", page: 2, pageSize: 10 },
    });
    expect(JSON.stringify(connection)).not.toMatch(/aroha@example\.org|pi_secret_ref|noEmails/);
    expect(browser).toMatchObject({
      data: [
        {
          member: AROHA,
          booking: { noEmails: false, payment: { stripePaymentIntentId: "pi_secret_ref" }, appealCeilingCents: 30_000 },
        },
      ],
      page: 2,
      pageSize: 10,
      total: 1,
    });
    // The page the app asked for is the one read.
    expect(h.prisma.refundRequest.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { status: "PENDING" }, take: 10, skip: 10 }),
    );
  });
});

describe("get_finance_report", () => {
  it("answers with the report's figures for the window and lodge the app asked for", async () => {
    h.resolveMetricsCapacityAndScope.mockResolvedValue({ capacity: 20, bookingLodgeWhere: { lodgeId: "lodge-1" } });
    h.prisma.booking.findMany.mockResolvedValue([]);
    h.prisma.payment.findMany.mockResolvedValue([]);
    h.prisma.member.count.mockResolvedValue(40);
    h.prisma.memberSubscription.count.mockResolvedValue(10);
    h.buildRevenueSeries.mockReturnValue({
      granularity: "daily",
      data: [
        {
          periodStart: "2026-07-01",
          periodEnd: "2026-07-01",
          label: "1 Jul",
          tooltipLabel: "Wed 1 Jul",
          revenueCents: 0,
          bookingCount: 0,
        },
      ],
    });
    const { connection, browser } = await expectActionContract({
      actionId: "get_finance_report",
      handler: getFinanceReport,
      args: { from: "2026-07-01", to: "2026-07-07", lodgeId: "lodge-1" },
    });
    // Nothing in the report is withheld: it is aggregates only.
    expect(browser).toEqual(connection);
    expect(connection).toMatchObject({ summary: { refundsOwedCents: 7_000, creditsOwedCents: 3_000 } });
    expect(h.resolveMetricsCapacityAndScope).toHaveBeenCalledWith("lodge-1");
    expect(h.prisma.booking.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ lodgeId: "lodge-1", deletedAt: null }) }),
    );
  });

  it("asks for both days of the window", () => {
    const schema = mcpActionInputSchema(findMcpAction("get_finance_report")!);
    expect(schema.safeParse({ from: "2026-07-01" }).success).toBe(false);
    expect(schema.safeParse({ from: "2026-07-01", to: "2026-02-30" }).success).toBe(false);
  });
});

describe("list_subscriptions", () => {
  it("answers with the season's subscriptions, never email addresses or Xero ids", async () => {
    h.prisma.memberSubscription.findMany.mockResolvedValue([
      {
        id: "sub-1",
        memberId: "member-7",
        seasonYear: 2026,
        status: "PAID",
        xeroInvoiceId: "xero-inv-uuid",
        xeroInvoiceNumber: "INV-0100",
        paidAt: new Date("2026-06-01T00:00:00.000Z"),
        manuallyMarkedPaidAt: new Date("2026-06-01T00:00:00.000Z"),
        manualPaymentNote: "Paid in cash at the AGM",
        member: {
          firstName: "Aroha",
          lastName: "Ngata",
          email: "aroha@example.org",
          ageTier: "ADULT",
          role: "USER",
          canLogin: true,
          passwordChangedAt: null,
          lastLoginAt: null,
          passwordResetTokens: [],
          xeroContactId: "xero-contact-uuid",
          seasonalMembershipAssignments: [{ membershipType: { subscriptionBehavior: "REQUIRED" } }],
        },
      },
    ]);
    h.prisma.member.findMany.mockResolvedValue([]);
    h.getXeroContactGroupMemberships.mockResolvedValue({
      "xero-contact-uuid": [{ id: "xero-group-uuid", name: "Families" }],
    });
    const { connection, browser } = await expectActionContract({
      actionId: "list_subscriptions",
      handler: listSubscriptions,
      args: { seasonYear: 2026, status: "PAID", page: 1 },
    });
    expect(JSON.stringify(connection)).not.toMatch(/aroha@example\.org|xero-inv-uuid|xero-contact-uuid|xero-group-uuid/);
    expect(browser).toMatchObject({
      data: [{ xeroInvoiceId: "xero-inv-uuid", member: { email: "aroha@example.org" } }],
      summary: { total: 1, paid: 1 },
    });
    // The season the app named is the one read.
    expect(h.prisma.memberSubscription.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ seasonYear: 2026 }) }),
    );
  });
});

describe("record_subscription_manual_payment", () => {
  it("marks the subscription the app named paid, as the signed-in officer, with their email choice", async () => {
    const RESULT = {
      id: "sub-1",
      memberId: "member-7",
      seasonYear: 2026,
      status: "PAID",
      direction: "paid",
      memberNotified: true,
      receipt: "queued",
    };
    h.applyManualSubscriptionPayment.mockResolvedValue(RESULT);
    const { connection, browser } = await expectActionContract({
      actionId: "record_subscription_manual_payment",
      handler: recordSubscriptionPayment,
      args: { id: "sub-1", direction: "paid", notifyMember: true, note: "Cash at the AGM", confirmed: true },
    });
    expect(connection).toEqual({
      success: true,
      subscription: RESULT,
      message: "Subscription marked paid. A receipt is being emailed to the member.",
    });
    expect(browser).toEqual(connection);
    expect(h.applyManualSubscriptionPayment).toHaveBeenCalledWith({
      subscriptionId: "sub-1",
      direction: "paid",
      note: "Cash at the AGM",
      actingMemberId: "treasurer-1",
      notifyMember: true,
    });
  });

  it("cannot be sent without the officer's confirmation", () => {
    const schema = mcpActionInputSchema(findMcpAction("record_subscription_manual_payment")!);
    expect(schema.safeParse({ id: "sub-1", direction: "paid", notifyMember: true }).success).toBe(false);
  });
});

describe("record_booking_manual_payment", () => {
  const ARGS = {
    id: "booking-1",
    direction: "paid",
    notifyMember: false,
    expectedAmountCents: 42_000,
    additionalCoverage: { covered: true, expectedAdditionalAmountCents: 5_000 },
    note: "Cash at the lodge",
    confirmed: true,
  };

  it("records the payment against the figure the officer was shown, in cents", async () => {
    const RESULT = {
      bookingId: "booking-1",
      paymentId: "pay-1",
      direction: "paid",
      memberNotified: false,
      receipt: "not_requested",
      amountCents: 47_000,
      bookingStatus: "PAID",
      creditElectionCents: 1_000,
      additional: { outstandingCents: 5_000, settled: true, recordedAmountCents: 47_000, payableOnline: false },
    };
    h.applyManualBookingPayment.mockResolvedValue(RESULT);
    const { connection, browser } = await expectActionContract({
      actionId: "record_booking_manual_payment",
      handler: recordBookingPayment,
      args: ARGS,
    });
    expect(connection).toEqual({ success: true, booking: RESULT, message: expect.stringContaining("Payment recorded.") });
    expect(browser).toEqual(connection);
    // The officer's figures reach the settle unchanged, so a moved price is refused there.
    expect(h.applyManualBookingPayment).toHaveBeenCalledWith({
      bookingId: "booking-1",
      direction: "paid",
      note: "Cash at the lodge",
      actingMemberId: "treasurer-1",
      notifyMember: false,
      expectedAmountCents: 42_000,
      additionalCoverage: { covered: true, expectedAdditionalAmountCents: 5_000 },
    });
  });

  it("refuses a fractional amount before the route sees it", () => {
    const schema = mcpActionInputSchema(findMcpAction("record_booking_manual_payment")!);
    expect(schema.safeParse({ ...ARGS, expectedAmountCents: 420.5 }).success).toBe(false);
    expect(
      schema.safeParse({ ...ARGS, additionalCoverage: { covered: true, expectedAdditionalAmountCents: 50.25 } }).success,
    ).toBe(false);
  });
});
