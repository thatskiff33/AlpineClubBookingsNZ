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
import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  listAdminPayments: vi.fn(),
  createAdminAdjustmentRequest: vi.fn(),
  getAdminAdjustmentRequests: vi.fn(),
  getMemberCreditBalance: vi.fn(),
  getAdminMemberCreditHistory: vi.fn(),
  getPendingAdminAdjustmentRequests: vi.fn(),
  getPendingCreditDeductionCorrections: vi.fn(),
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
  buildSubscriptionBillingPreview: vi.fn(),
  confirmSubscriptionBillingPreview: vi.fn(),
  reconcileSubscriptionBillingExceptions: vi.fn(),
  enqueueMembershipSubscriptionChargeOperation: vi.fn(),
  closeAlreadyPaidSubscriptionCharge: vi.fn(),
  createAuditLog: vi.fn(),
  requireFinanceViewerApiAccess: vi.fn(),
  requireFinanceManagerApiAccess: vi.fn(),
  getFinanceBookingMetrics: vi.fn(),
  getFinanceSyncDiagnosticsStatus: vi.fn(),
  runManualFinanceSync: vi.fn(),
  backfillFinanceMonthlyFacts: vi.fn(),
  getLatestFinanceSyncRun: vi.fn(),
  prisma: {
    membershipSubscriptionCharge: { findMany: vi.fn(), count: vi.fn() },
    membershipBillingException: { findMany: vi.fn() },
    membershipSubscriptionBillingSettings: { findUnique: vi.fn() },
    familyGroup: { findUnique: vi.fn() },
    familyGroupSeasonInvoiceMarker: { findFirst: vi.fn(), create: vi.fn(), updateMany: vi.fn() },
    $transaction: vi.fn(),
    manualRefundTask: { findMany: vi.fn() },
    refundRequest: { findMany: vi.fn(), count: vi.fn() },
    booking: { findMany: vi.fn() },
    payment: { findMany: vi.fn() },
    member: { count: vi.fn(), findMany: vi.fn() },
    memberSubscription: { count: vi.fn(), findMany: vi.fn() },
  },
}));

vi.mock("@/lib/admin-credit-deduction-queries", () => ({ getPendingCreditDeductionCorrections: h.getPendingCreditDeductionCorrections }));
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
vi.mock("@/lib/finance-booking-metrics", () => ({
  resolveMetricsCapacityAndScope: h.resolveMetricsCapacityAndScope,
  getFinanceBookingMetrics: h.getFinanceBookingMetrics,
}));
vi.mock("@/lib/finance-api-auth", () => ({
  requireFinanceViewerApiAccess: h.requireFinanceViewerApiAccess,
  requireFinanceManagerApiAccess: h.requireFinanceManagerApiAccess,
}));
vi.mock("@/lib/finance-sync-diagnostics", () => ({ getFinanceSyncDiagnosticsStatus: h.getFinanceSyncDiagnosticsStatus }));
vi.mock("@/lib/finance-sync-manual", () => ({ runManualFinanceSync: h.runManualFinanceSync }));
vi.mock("@/lib/finance-monthly-fact-backfill", () => ({ backfillFinanceMonthlyFacts: h.backfillFinanceMonthlyFacts }));
vi.mock("@/lib/finance-sync-storage", () => ({ getLatestFinanceSyncRun: h.getLatestFinanceSyncRun }));
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
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/membership-subscription-billing", () => ({
  buildSubscriptionBillingPreview: h.buildSubscriptionBillingPreview,
  confirmSubscriptionBillingPreview: h.confirmSubscriptionBillingPreview,
  reconcileSubscriptionBillingExceptions: h.reconcileSubscriptionBillingExceptions,
  SubscriptionBillingError: class SubscriptionBillingError extends Error {},
}));
vi.mock("@/lib/xero-invoicing-guard", () => import("@/lib/__tests__/helpers/xero-invoicing-guard-mock"));
vi.mock("@/lib/xero-subscription-invoices", () => ({
  enqueueMembershipSubscriptionChargeOperation: h.enqueueMembershipSubscriptionChargeOperation,
}));
vi.mock("@/lib/membership-subscription-charge-close", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/membership-subscription-charge-close")),
  closeAlreadyPaidSubscriptionCharge: h.closeAlreadyPaidSubscriptionCharge,
}));
vi.mock("@/lib/financial-year-server", () => ({ refreshFinancialYearConfig: async () => 3 }));
vi.mock("@/lib/audit", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/audit")),
  createAuditLog: h.createAuditLog,
}));
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
import { GET as getSubscriptionBilling, POST as runSubscriptionBilling } from "@/app/api/admin/subscription-billing/route";
import { GET as getFinanceBookingMetrics } from "@/app/api/finance/bookings/metrics/route";
import { POST as backfillFinanceMonthlyFacts } from "@/app/api/finance/sync/backfill-monthly-facts/route";
import { POST as runFinanceSync } from "@/app/api/finance/sync/run/route";
import { GET as getFinanceSyncStatus } from "@/app/api/finance/sync/status/route";
import { GET as listPayments } from "@/app/api/admin/payments/route";
import { expectActionContract } from "@/lib/__tests__/helpers/mcp-action-contract";
import { adminSession } from "@/lib/__tests__/helpers/sessions";
import { findMcpAction, MCP_ACTIONS, mcpActionInputSchema } from "@/lib/mcp/catalogue";
import { MCP_PRINCIPAL_HEADER } from "@/lib/mcp/principal";

const financeOfficer = adminSession({ id: "treasurer-1", accessRoles: ["USER", "FINANCE_ADMIN"] });

beforeEach(() => {
  vi.clearAllMocks();
  h.requireAdmin.mockResolvedValue({ ok: true, session: financeOfficer });
  h.getPendingCreditDeductionCorrections.mockResolvedValue([]);
  h.requireFinanceViewerApiAccess.mockResolvedValue({ ok: true, member: { id: "treasurer-1" } });
  h.requireFinanceManagerApiAccess.mockResolvedValue({ ok: true, member: { id: "treasurer-1" } });
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
        disputes: [{ stripeDisputeId: "dp_secret_ref", status: "needs_response", amountCents: 42_000, paymentId: "pay-1" }],
        cancellationSettlement: { accountCreditCents: 30_000, restoredAppliedCreditCents: 0, refundToOriginalMethodCents: 12_000 },
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
    expect(JSON.stringify(connection)).not.toMatch(/aroha@example\.org|pi_secret_ref|xero-inv-uuid|dp_secret_ref/);
    // A refund is told apart from account credit, and a disputed capture is visible.
    expect(connection).toMatchObject({
      data: [
        {
          cancellationSettlement: { accountCreditCents: 30_000, refundToOriginalMethodCents: 12_000 },
          disputes: [{ status: "needs_response", amountCents: 42_000 }],
        },
      ],
    });
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

  it("is destructive: the requester cannot withdraw it from the app", () => {
    expect(findMcpAction("request_credit_adjustment")!.kind).toBe("destructive");
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
    const corrections = [{ id: "correction-1", requestId: "adj-3", amountCents: -2_500, description: "Granted by mistake", createdAt: "2026-06-30T04:00:00.000Z" }];
    h.getPendingCreditDeductionCorrections.mockResolvedValue(corrections);
    const { connection, browser } = await expectActionContract({
      actionId: "get_member_credits",
      handler: getMemberCredits,
      args: { id: "member-7" },
    });
    expect(JSON.stringify(connection)).not.toMatch(/xero-cn-uuid|cash-credit-row|4b1c2d3e/);
    expect(browser).toEqual({ balanceCents: 4_000, history: HISTORY, pendingRequests: PENDING, pendingCorrections: corrections });
    // Each read is for the member the app named, not the officer calling.
    for (const read of [h.getMemberCreditBalance, h.getAdminMemberCreditHistory, h.getPendingAdminAdjustmentRequests, h.getPendingCreditDeductionCorrections]) {
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

describe("subscription billing actions", () => {
  const TOKEN = "c".repeat(64);
  const PREVIEW = {
    seasonYear: 2026,
    decisionDate: "2026-07-01",
    yearEndMonth: 3,
    dueDays: 30,
    scopeMemberIds: null,
    totalCents: 18_000,
    confirmationToken: TOKEN,
    entries: [
      {
        key: "entry-1",
        seasonYear: 2026,
        membershipAnnualFeeId: "fee-1",
        membershipTypeId: "type-1",
        membershipTypeKey: "FULL",
        membershipTypeName: "Full member",
        subscriptionCategoryName: "Couple",
        billingBasis: "PER_MEMBER",
        prorationRule: "NONE",
        annualAmountCents: 18_000,
        chargedAmountCents: 18_000,
        coveredMonths: 12,
        decisionDate: "2026-07-01",
        coverageStart: "2026-04-01",
        coverageEnd: "2027-03-31",
        familyGroupId: "family-1",
        recipient: { id: "member-7", name: "Aroha Ngata", email: "aroha@example.org" },
        coveredMembers: [{ id: "member-7", name: "Aroha Ngata" }],
        xeroAccountCode: "200",
        xeroItemCode: "SUB",
        components: [
          {
            label: "Annual fee",
            description: "2026/27 subscription",
            annualAmountCents: 18_000,
            chargedAmountCents: 18_000,
            prorated: false,
            xeroAccountCode: "200",
            xeroItemCode: "SUB",
            sortOrder: 0,
          },
        ],
      },
    ],
    exceptions: [
      {
        fingerprint: "fp-1",
        code: "NO_FEE",
        message: "No fee for this type",
        seasonYear: 2026,
        memberId: "member-8",
        familyGroupId: "family-2",
        membershipTypeId: "type-2",
        context: { rawSetting: "exception-context-secret" },
      },
    ],
    alreadyCoveredMemberIds: ["member-9"],
    exemptMemberIds: ["member-10"],
    exemptMembers: [
      { memberId: "member-10", memberName: "Tama Reti", ageTier: null, exemptBy: "MEMBERSHIP_TYPE", membershipTypeName: "Life" },
    ],
    alreadyInvoiced: [{ memberId: "member-11", memberName: "Mere Hohaia", xeroInvoiceNumber: "INV-0200", status: "UNPAID" }],
    alreadyInvoicedFamilies: [
      {
        familyGroupId: "family-3",
        holderMemberId: "member-12",
        holderName: "Hemi Walker",
        xeroInvoiceNumber: "INV-0201",
        status: "PAID",
        membersCovered: 3,
        holderBasisUnresolvable: false,
        operatorMarked: true,
        markerNote: "Paid at AGM",
        markedByName: "Tama Reti",
        markedAt: "2026-06-01T00:00:00.000Z",
      },
    ],
    ungroupedCategoryMembers: [
      { subscriptionCategoryId: "cat-1", subscriptionCategoryName: "Couple", members: [{ memberId: "member-7", memberName: "Aroha Ngata" }] },
    ],
  };
  const CHARGE = {
    id: "charge-1",
    idempotencyKey: "charge-idem-key",
    seasonYear: 2026,
    source: "ANNUAL_BATCH",
    status: "INVOICE_FAILED",
    membershipTypeName: "Full member",
    subscriptionCategoryName: null,
    billingBasis: "PER_MEMBER",
    annualAmountCents: 18_000,
    chargedAmountCents: 18_000,
    coverageStart: "2026-04-01T00:00:00.000Z",
    coverageEnd: "2027-03-31T00:00:00.000Z",
    recipientMemberId: "member-7",
    recipientName: "Aroha Ngata",
    recipientEmail: "aroha@example.org",
    dueDays: 30,
    xeroInvoiceId: "xero-inv-uuid",
    xeroInvoiceNumber: "INV-0300",
    xeroInvoiceUrl: "https://in.xero.com/secret-link",
    emailSentAt: "2026-06-02T00:00:00.000Z",
    lastErrorCode: "XERO_DOWN",
    lastErrorMessage: "Xero was unavailable",
    confirmedAt: "2026-06-01T00:00:00.000Z",
    createdAt: "2026-06-01T00:00:00.000Z",
    coverage: [{ memberId: "member-7", memberName: "Aroha Ngata", releasedAt: "2026-06-03T00:00:00.000Z", subscription: { status: "UNPAID" } }],
  };
  const EXCEPTION = {
    id: "exc-1",
    fingerprint: "fp-old",
    seasonYear: 2026,
    source: "ANNUAL_BATCH",
    status: "OPEN",
    code: "NO_FEE",
    message: "No fee for this type",
    memberId: "member-8",
    familyGroupId: "family-2",
    membershipTypeId: "type-2",
    context: { rawSetting: "exception-context-secret" },
    firstSeenAt: "2026-05-01T00:00:00.000Z",
    lastSeenAt: "2026-06-01T00:00:00.000Z",
  };
  const WITHHELD = /aroha@example\.org|xero-inv-uuid|secret-link|charge-idem-key|exception-context-secret|"member-9"/;

  function stubPanel() {
    h.buildSubscriptionBillingPreview.mockResolvedValue(PREVIEW);
    h.prisma.membershipSubscriptionCharge.findMany.mockResolvedValue([CHARGE]);
    h.prisma.membershipBillingException.findMany.mockResolvedValue([EXCEPTION]);
    h.prisma.membershipSubscriptionBillingSettings.findUnique.mockResolvedValue({
      invoiceDueDays: 30,
      familyBillingMode: "BILL_MEMBERS_INDIVIDUALLY",
    });
  }

  it("get_subscription_billing answers with the preview, charges and exceptions, never contact details or Xero ids", async () => {
    stubPanel();
    const { connection, browser } = await expectActionContract({
      actionId: "get_subscription_billing",
      handler: getSubscriptionBilling,
      args: { seasonYear: 2026, decisionDate: "2026-07-01" },
    });
    expect(JSON.stringify(connection)).not.toMatch(WITHHELD);
    expect(connection).toMatchObject({ preview: { confirmationToken: TOKEN } });
    expect(browser).toMatchObject({ preview: PREVIEW, charges: [CHARGE], exceptions: [EXCEPTION] });
    expect(h.buildSubscriptionBillingPreview).toHaveBeenCalledWith(
      expect.objectContaining({ seasonYear: 2026, decisionDate: new Date("2026-07-01T00:00:00.000Z") }),
    );
  });

  // ALP-721 review: the answer is cut at MCP_RESULT_MAX_CHARS, which can drop
  // entries while the confirmation token survives, so a summary read from the
  // same preview comes first and the app is told to show it before confirming.
  it("get_subscription_billing opens with a summary of what confirming would invoice, read from the preview", async () => {
    stubPanel();
    const { connection } = await expectActionContract({
      actionId: "get_subscription_billing",
      handler: getSubscriptionBilling,
      args: { seasonYear: 2026, decisionDate: "2026-07-01" },
    });
    expect(Object.keys(connection as object)[0]).toBe("summary");
    expect((connection as { summary: unknown }).summary).toEqual({
      entryCount: 1,
      totalCents: 18_000,
      coveredMemberCount: 1,
      byMembership: [{ subscriptionCategoryName: "Couple", membershipTypeName: null, entryCount: 1, chargedCents: 18_000 }],
      exemptCount: 1,
      alreadyInvoicedCount: 1,
      alreadyInvoicedFamilyCount: 1,
      exceptionCount: 1,
      withheldCount: 1,
      warningCount: 0,
      needsDecisionCount: 0,
    });
    // A cut at the limit keeps the summary: it sits before the token and every entry.
    const text = JSON.stringify(connection);
    expect(text.indexOf('"summary"')).toBeLessThan(text.indexOf('"confirmationToken"'));
    const action = findMcpAction("get_subscription_billing")!;
    expect(action.summary).toContain("Show the officer `summary` before asking them to confirm");
    expect(findMcpAction("confirm_subscription_billing_batch")!.summary).toContain("seen the preview's `summary`");
  });

  it("totals the summary from the preview's own total and groups, never pricing again", async () => {
    const entry = PREVIEW.entries[0]!;
    stubPanel();
    h.buildSubscriptionBillingPreview.mockResolvedValue({
      ...PREVIEW,
      // Deliberately not the entries' sum: the summary reports the preview's figure.
      totalCents: 99_999,
      entries: [
        { ...entry, key: "a", subscriptionCategoryName: null, membershipTypeName: "Full member", chargedAmountCents: 9_000 },
        { ...entry, key: "b", subscriptionCategoryName: null, membershipTypeName: "Full member", chargedAmountCents: 9_000,
          coveredMembers: [{ id: "m-1", name: "One" }, { id: "m-2", name: "Two" }] },
        { ...entry, key: "c", subscriptionCategoryName: null, membershipTypeName: "Junior", chargedAmountCents: 4_000 },
      ],
      exceptions: [
        ...PREVIEW.exceptions,
        { ...PREVIEW.exceptions[0]!, fingerprint: "fp-2", code: "CLOSED_FAMILY_PARTLY_REVERSED" },
        { ...PREVIEW.exceptions[0]!, fingerprint: "fp-3", code: "CLOSED_FAMILY_MEMBER_NEEDS_DECISION" },
      ],
    });
    const { connection } = await expectActionContract({
      actionId: "get_subscription_billing",
      handler: getSubscriptionBilling,
      args: { seasonYear: 2026, decisionDate: "2026-07-01" },
    });
    expect((connection as { summary: unknown }).summary).toMatchObject({
      entryCount: 3,
      totalCents: 99_999,
      coveredMemberCount: 4,
      byMembership: [
        { subscriptionCategoryName: null, membershipTypeName: "Full member", entryCount: 2, chargedCents: 18_000 },
        { subscriptionCategoryName: null, membershipTypeName: "Junior", entryCount: 1, chargedCents: 4_000 },
      ],
      exceptionCount: 3,
      withheldCount: 2,
      warningCount: 1,
      needsDecisionCount: 1,
    });
  });

  it("refresh_subscription_billing closes stale problems for the season and day the app named", async () => {
    stubPanel();
    h.reconcileSubscriptionBillingExceptions.mockResolvedValue({ resolvedCount: 2 });
    const { connection, browser } = await expectActionContract({
      actionId: "refresh_subscription_billing",
      handler: runSubscriptionBilling,
      args: { seasonYear: 2026, decisionDate: "2026-07-01" },
    });
    expect(JSON.stringify(connection)).not.toMatch(WITHHELD);
    expect(connection).toMatchObject({ success: true, reconciledCount: 2 });
    expect(browser).toMatchObject({ success: true, reconciledCount: 2, preview: PREVIEW });
    expect(h.reconcileSubscriptionBillingExceptions).toHaveBeenCalledWith({
      seasonYear: 2026,
      decisionDate: new Date("2026-07-01T00:00:00.000Z"),
      yearEndMonth: 3,
    });
  });

  it("confirm_subscription_billing_batch confirms the preview the officer reviewed, by its token", async () => {
    h.buildSubscriptionBillingPreview.mockResolvedValue(PREVIEW);
    h.confirmSubscriptionBillingPreview.mockResolvedValue({ chargeIds: ["charge-1"], exceptionCount: 1 });
    h.enqueueMembershipSubscriptionChargeOperation.mockResolvedValue({ queueOperationId: "op-1", message: "Subscription invoice queued." });
    const { connection, browser } = await expectActionContract({
      actionId: "confirm_subscription_billing_batch",
      handler: runSubscriptionBilling,
      args: { seasonYear: 2026, decisionDate: "2026-07-01", confirmationToken: TOKEN, confirmed: true },
    });
    expect(connection).toEqual({
      success: true,
      message: "1 immutable charge created; 1 exception recorded.",
      chargeIds: ["charge-1"],
      exceptionCount: 1,
      queued: [{ queueOperationId: "op-1", message: "Subscription invoice queued." }],
    });
    expect(browser).toEqual(connection);
    // The catalogue fixes the variant: the app cannot turn a confirm into a settings change.
    expect(h.confirmSubscriptionBillingPreview).toHaveBeenCalledWith(
      expect.objectContaining({ expectedConfirmationToken: TOKEN, source: "ANNUAL_BATCH", confirmedByMemberId: "treasurer-1" }),
    );
    expect(findMcpAction("confirm_subscription_billing_batch")!.kind).toBe("destructive");
  });

  it("retry_subscription_charge queues the named charge's invoice work", async () => {
    h.enqueueMembershipSubscriptionChargeOperation.mockResolvedValue({ queueOperationId: "op-2", message: "Subscription invoice queued." });
    const { connection, browser } = await expectActionContract({
      actionId: "retry_subscription_charge",
      handler: runSubscriptionBilling,
      args: { chargeId: "charge-1" },
    });
    expect(connection).toEqual({ success: true, queueOperationId: "op-2", message: "Subscription invoice queued." });
    expect(browser).toEqual(connection);
    expect(h.enqueueMembershipSubscriptionChargeOperation).toHaveBeenCalledWith("charge-1", { createdByMemberId: "treasurer-1" });
  });

  it("close_paid_subscription_charge closes the named charge with the officer's reason", async () => {
    h.closeAlreadyPaidSubscriptionCharge.mockResolvedValue({ closed: true, message: "Charge closed as paid." });
    const { connection, browser } = await expectActionContract({
      actionId: "close_paid_subscription_charge",
      handler: runSubscriptionBilling,
      args: { chargeId: "charge-1", reason: "Paid in cash" },
    });
    expect(connection).toEqual({ success: true, closed: true, message: "Charge closed as paid." });
    expect(browser).toEqual(connection);
    expect(h.closeAlreadyPaidSubscriptionCharge).toHaveBeenCalledWith({
      chargeId: "charge-1",
      reason: "Paid in cash",
      actorMemberId: "treasurer-1",
    });
  });

  it("mark_family_invoiced and unmark_family_invoiced set and release the named family's marker", async () => {
    h.prisma.familyGroup.findUnique.mockResolvedValue({ id: "family-1" });
    h.prisma.$transaction.mockImplementation(async (run: (tx: typeof h.prisma) => Promise<unknown>) => run(h.prisma));
    h.prisma.familyGroupSeasonInvoiceMarker.findFirst.mockResolvedValue(null);
    h.prisma.familyGroupSeasonInvoiceMarker.create.mockResolvedValue({ id: "marker-1" });
    const marked = await expectActionContract({
      actionId: "mark_family_invoiced",
      handler: runSubscriptionBilling,
      args: { seasonYear: 2026, familyGroupId: "family-1", note: "Invoiced by hand" },
    });
    expect(marked.connection).toEqual({ success: true, message: "Family marked as already invoiced for this season." });
    expect(h.prisma.familyGroupSeasonInvoiceMarker.create).toHaveBeenCalledWith({
      data: { familyGroupId: "family-1", seasonYear: 2026, note: "Invoiced by hand", markedByMemberId: "treasurer-1" },
    });

    h.prisma.familyGroupSeasonInvoiceMarker.updateMany.mockResolvedValue({ count: 1 });
    const unmarked = await expectActionContract({
      actionId: "unmark_family_invoiced",
      handler: runSubscriptionBilling,
      args: { seasonYear: 2026, familyGroupId: "family-1" },
    });
    expect(unmarked.connection).toEqual({ success: true, message: "Family marker removed; it can be billed again." });
    expect(unmarked.browser).toEqual(unmarked.connection);
    expect(h.prisma.familyGroupSeasonInvoiceMarker.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { familyGroupId: "family-1", seasonYear: 2026, releasedAt: null } }),
    );
  });

  it("offers no action that changes the club's billing settings", () => {
    const settingsActions = MCP_ACTIONS.filter(
      (action) => action.path === "/api/admin/subscription-billing" && action.fixedBody?.action === "UPDATE_SETTINGS",
    );
    expect(settingsActions).toEqual([]);
  });
});

describe("finance workspace actions", () => {
  const DAY = {
    date: "2026-07-01",
    bookingCount: 2,
    guestNights: 6,
    occupiedBeds: 6,
    availableBeds: 14,
    occupancyRate: 30,
    bookedRevenueCents: 36_000,
  };
  const STATUS = { bookingCount: 2, bookingNights: 3, guestNights: 6, bookedRevenueCents: 36_000 };
  const BUCKET = { ...STATUS, occupancy: { occupiedBedNights: 6, capacityBedNights: 20, occupancyRate: 30 } };
  const WINDOW = { from: "2026-07-01", to: "2026-07-07", effectiveFrom: "2026-07-01", effectiveTo: "2026-07-07", dayCount: 7 };
  const METRICS = {
    generatedAt: "2026-07-01T00:00:00.000Z",
    bookingCount: 2,
    moneyReconciliation: { totalBookings: 2, byState: { RECONCILED: 2, UNRECONCILED: 0 }, byReason: { PRICE_MISMATCH: 0 } },
    paymentSummary: {
      bookingCount: 2,
      bookingsWithPayment: 2,
      bookingsWithoutPayment: 0,
      paymentStatusBreakdown: { SUCCEEDED: 2 },
      additionalPaymentStatusBreakdown: { NONE: 2 },
      capturedGrossCents: 36_000,
      capturedAdditionalCents: 0,
      outstandingAdditionalCents: 0,
      outstandingAdditionalBookings: 0,
      additionalLedgerGapCents: 0,
      additionalLedgerGapBookings: 0,
      refundedCents: 0,
      handBackOwedCents: 0,
      cardRefundOwedCents: 0,
      lateCaptureOwedCents: 0,
      lateCashCreditedCents: 0,
      keptCreditCents: 0,
      netCollectedCents: 36_000,
      refundsOwedCents: 7_000,
      creditsOwedCents: 3_000,
      creditAppliedCents: 0,
      changeFeeCents: 0,
    },
    realized: {
      window: { ...WINDOW, cutoffDate: "2026-07-07" },
      totals: { ...BUCKET, averageNightlyRevenueCents: 12_000 },
      statusBreakdown: { PAID: STATUS },
      byDate: [DAY],
    },
    forward: {
      window: { ...WINDOW, asOfDate: "2026-07-01" },
      totals: {
        committed: { ...BUCKET, statusBreakdown: { PAID: STATUS } },
        atRisk: { ...BUCKET, statusBreakdown: { PENDING: STATUS } },
        totalPipeline: BUCKET,
      },
      byDate: [{ date: "2026-07-01", committed: DAY, atRisk: DAY, totalPipeline: DAY }],
    },
  };

  it("get_finance_booking_metrics answers with both windows for the days the app named", async () => {
    h.getFinanceBookingMetrics.mockResolvedValue(METRICS);
    const { connection, browser } = await expectActionContract({
      actionId: "get_finance_booking_metrics",
      handler: getFinanceBookingMetrics,
      args: { realizedFrom: "2026-07-01", realizedTo: "2026-07-07", forwardFrom: "2026-07-01", forwardTo: "2026-07-07" },
    });
    expect(browser).toEqual(METRICS);
    expect(connection).toEqual(METRICS);
    expect(h.getFinanceBookingMetrics).toHaveBeenCalledWith(
      expect.objectContaining({
        realized: { from: "2026-07-01", to: "2026-07-07", cutoffDate: undefined },
        forward: { from: "2026-07-01", to: "2026-07-07", asOfDate: undefined },
      }),
    );
  });

  const SYNC_RUN = {
    id: "run-1",
    workflow: "finance-daily",
    trigger: "MANUAL",
    status: "PARTIAL",
    startedAt: "2026-07-01T00:00:00.000Z",
    completedAt: "2026-07-01T00:01:00.000Z",
    durationMs: 60_000,
    xeroTenantId: "xero-tenant-uuid",
    requestedByMemberId: "treasurer-1",
    snapshotCount: 3,
    totalRowCount: 120,
    datasetCount: 2,
    successfulDatasetCount: 1,
    failedDatasetCount: 1,
    datasets: [{ datasetKey: "pnl", snapshotCount: 3, totalRowCount: 120, snapshotTypes: ["PROFIT_AND_LOSS"], errorMessage: null }],
    errorSummary: "Balance sheet failed",
    failureDetails: [{ stage: "fetch", datasetKey: "balance-sheet", message: "Xero timed out" }],
  };
  const CRON_RUN = {
    id: "cron-1",
    jobName: "finance-sync",
    status: "SUCCEEDED",
    startedAt: "2026-07-01T00:00:00.000Z",
    completedAt: "2026-07-01T00:01:00.000Z",
    durationMs: 60_000,
    financeSyncRunId: "run-1",
    financeSyncStatus: "PARTIAL",
    snapshotCount: 3,
    totalRowCount: 120,
    datasetCount: 2,
    failedDatasetCount: 1,
    error: null,
    reason: "nightly",
  };

  it("get_finance_sync_status answers with the runs and schedule, never the Xero organisation id", async () => {
    const STATUS_BODY = {
      workflow: "finance-daily",
      latestRun: SYNC_RUN,
      cron: { jobName: "finance-sync", schedule: "0 3 * * *", timezone: "Pacific/Auckland", latestRun: CRON_RUN },
      recentFailures: { syncRuns: [SYNC_RUN], cronRuns: [CRON_RUN] },
    };
    h.getFinanceSyncDiagnosticsStatus.mockResolvedValue(STATUS_BODY);
    const { connection, browser } = await expectActionContract({
      actionId: "get_finance_sync_status",
      handler: getFinanceSyncStatus,
    });
    expect(JSON.stringify(connection)).not.toMatch(/xero-tenant-uuid|requestedByMemberId/);
    expect(browser).toEqual(STATUS_BODY);
  });

  const EXECUTION = {
    runId: "run-2",
    workflow: "finance-daily",
    trigger: "MANUAL",
    status: "PARTIAL",
    xeroTenantId: "xero-tenant-uuid",
    startedAt: new Date("2026-07-01T00:00:00.000Z"),
    completedAt: new Date("2026-07-01T00:01:00.000Z"),
    snapshotCount: 3,
    totalRowCount: 120,
    datasetResults: [
      {
        datasetKey: "pnl",
        snapshotCount: 3,
        totalRowCount: 120,
        snapshotTypes: ["PROFIT_AND_LOSS"],
        factRowCount: 40,
        unresolvedFactRowCount: 2,
        errorMessage: "Two rows had no GL code",
      },
    ],
  };

  function syncRequest(viaConnection: boolean) {
    return new NextRequest("https://club.example.test/api/finance/sync/run", {
      method: "POST",
      headers: viaConnection ? { [MCP_PRINCIPAL_HEADER]: "contract-test-principal" } : {},
    });
  }

  it("run_finance_sync answers a connection with the outcome as JSON and keeps the browser's redirect", async () => {
    h.runManualFinanceSync.mockResolvedValue({ outcome: "finished", execution: EXECUTION });
    // The redirect is the browser's answer, so the contract helper (which wants a 2xx both ways) cannot run it.
    const viaApp = await runFinanceSync(syncRequest(true));
    expect(viaApp.status).toBe(200);
    const body = await viaApp.json();
    expect(Object.keys(body).sort()).toEqual(Object.keys(findMcpAction("run_finance_sync")!.returns).sort());
    expect(body).toEqual({
      outcome: "partial",
      runId: "run-2",
      status: "PARTIAL",
      startedAt: "2026-07-01T00:00:00.000Z",
      completedAt: "2026-07-01T00:01:00.000Z",
      snapshotCount: 3,
      totalRowCount: 120,
      datasetResults: EXECUTION.datasetResults,
    });
    expect(JSON.stringify(body)).not.toMatch(/xero-tenant-uuid/);
    expect(h.runManualFinanceSync).toHaveBeenCalledWith({ requestedByMemberId: "treasurer-1" });

    const viaBrowser = await runFinanceSync(syncRequest(false));
    expect(viaBrowser.status).toBe(303);
    expect(viaBrowser.headers.get("location")).toMatch(/\/finance\?sync=partial$/);
  });

  it("run_finance_sync answers a connection's refusals as JSON: already running, failed, and the guard's own", async () => {
    h.runManualFinanceSync.mockResolvedValueOnce({ outcome: "already-running", runId: "run-1", startedAt: new Date("2026-07-01T00:00:00.000Z") });
    const running = await runFinanceSync(syncRequest(true));
    expect(running.status).toBe(409);
    expect(await running.json()).toMatchObject({ outcome: "already-running", runId: "run-1" });

    h.runManualFinanceSync.mockRejectedValueOnce(new Error("Xero down"));
    const failed = await runFinanceSync(syncRequest(true));
    expect(failed.status).toBe(500);
    expect(await failed.json()).toEqual({ error: "Manual finance sync failed", outcome: "failed" });

    h.requireFinanceManagerApiAccess.mockResolvedValueOnce({
      ok: false,
      response: NextResponse.json({ error: "Finance manager access required" }, { status: 403 }),
    });
    const refused = await runFinanceSync(syncRequest(true));
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: "Finance manager access required" });

    // The browser still lands back on the finance page.
    h.requireFinanceManagerApiAccess.mockResolvedValueOnce({
      ok: false,
      response: NextResponse.json({ error: "Finance manager access required" }, { status: 403 }),
    });
    const browserRefused = await runFinanceSync(syncRequest(false));
    expect(browserRefused.status).toBe(303);
    expect(browserRefused.headers.get("location")).toMatch(/\/finance$/);
  });

  it("backfill_finance_monthly_facts runs from the month the app named and answers with the run", async () => {
    h.getLatestFinanceSyncRun.mockResolvedValue({ status: "SUCCEEDED" });
    h.backfillFinanceMonthlyFacts.mockResolvedValue({ ...EXECUTION, status: "SUCCEEDED" });
    const { connection, browser } = await expectActionContract({
      actionId: "backfill_finance_monthly_facts",
      handler: backfillFinanceMonthlyFacts,
      args: { fromMonth: "2024-04", maxChunks: 3 },
    });
    const expected = {
      runId: "run-2",
      status: "SUCCEEDED",
      snapshotCount: 3,
      totalRowCount: 120,
      datasetResults: EXECUTION.datasetResults,
    };
    expect(connection).toEqual(expected);
    expect(browser).toEqual(expected);
    expect(h.backfillFinanceMonthlyFacts).toHaveBeenCalledWith(
      expect.objectContaining({ requestedByMemberId: "treasurer-1", fromMonth: "2024-04", maxChunks: 3 }),
    );
  });

  it("backfill_finance_monthly_facts keeps the route's lenient reading and its refusals word for word", async () => {
    h.getLatestFinanceSyncRun.mockResolvedValue(null);
    h.backfillFinanceMonthlyFacts.mockResolvedValue({ ...EXECUTION, status: "SUCCEEDED" });
    const post = (body: unknown) =>
      backfillFinanceMonthlyFacts(
        new NextRequest("https://club.example.test/api/finance/sync/backfill-monthly-facts", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      );
    // A blank or non-string month means none; a numeric string chunk count is read as a number.
    expect((await post({ fromMonth: "  ", maxChunks: "12" })).status).toBe(200);
    expect(h.backfillFinanceMonthlyFacts).toHaveBeenLastCalledWith(expect.objectContaining({ fromMonth: null, maxChunks: 12 }));
    expect((await post(undefined)).status).toBe(200);
    expect(h.backfillFinanceMonthlyFacts).toHaveBeenLastCalledWith(expect.objectContaining({ fromMonth: null, maxChunks: 30 }));
    // Only an absent body means the defaults; a JSON null is refused (#5407).
    expect((await post(null)).status).toBe(400);
    const badMonth = await post({ fromMonth: "2024-13", maxChunks: 0 });
    expect(badMonth.status).toBe(400);
    expect(await badMonth.json()).toEqual({ error: "fromMonth must be a YYYY-MM month key" });
    const badChunks = await post({ maxChunks: 2.5 });
    expect(badChunks.status).toBe(400);
    expect(await badChunks.json()).toEqual({ error: "maxChunks must be a positive integer" });
  });
});
