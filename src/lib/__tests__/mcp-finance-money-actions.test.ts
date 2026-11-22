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
}));

vi.mock("@/lib/prisma", () => ({ prisma: {} }));
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
import { GET as listPayments } from "@/app/api/admin/payments/route";
import { expectActionContract } from "@/lib/__tests__/helpers/mcp-action-contract";
import { adminSession } from "@/lib/__tests__/helpers/sessions";
import { findMcpAction, mcpActionInputSchema } from "@/lib/mcp/catalogue";

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
