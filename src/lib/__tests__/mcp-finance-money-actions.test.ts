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
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  listAdminPayments: vi.fn(),
  createAdminAdjustmentRequest: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/session-guards", () => ({ requireAdmin: h.requireAdmin }));
vi.mock("@/lib/admin-payments-service", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/admin-payments-service")),
  listAdminPayments: h.listAdminPayments,
}));
vi.mock("@/lib/member-credit", () => ({
  getMemberCreditBalance: vi.fn(),
  getAdminMemberCreditHistory: vi.fn(),
  getPendingAdminAdjustmentRequests: vi.fn(),
  createAdminAdjustmentRequest: h.createAdminAdjustmentRequest,
}));
vi.mock("@/lib/rate-limit", () => ({ getClientIp: vi.fn(() => "203.0.113.9") }));
vi.mock("@/lib/logger", () => ({ default: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));

import { POST as requestCreditAdjustment } from "@/app/api/admin/members/[id]/credits/route";
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
