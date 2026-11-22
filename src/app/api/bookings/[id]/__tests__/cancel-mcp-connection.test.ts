import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * ALP-653 (`INV-MCP-006`): stage 1's `cancel_my_booking` and
 * `preview_cancel_booking` act on the member's OWN booking. A request that
 * arrives as an AI app connection (the internal principal header) never
 * carries an officer's authority on these two routes, even when the person
 * behind the connection is a Full Admin or a Booking Officer. On the website,
 * without the header, the officer keeps the reach #1313 gave them.
 *
 * The cancel service's own gate (non-owner, role USER, no bookings:edit flag
 * -> 403) is pinned in `booking-cancel.test.ts`; this file pins what the route
 * hands it. The role helpers are the real ones, fed a real officer session,
 * so the test fails if the route decides with the officer's session rather
 * than `memberOnlySessionUser`'s (ALP-718).
 */
const h = vi.hoisted(() => ({
  auth: vi.fn(),
  requireActiveSessionUser: vi.fn(),
  cancelBooking: vi.fn(),
  bookingFindUnique: vi.fn(),
  calculateCancellationPreview: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ auth: h.auth }));
vi.mock("@/lib/session-guards", () => ({ requireActiveSessionUser: h.requireActiveSessionUser }));
vi.mock("@/lib/booking-cancel", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/booking-cancel")),
  cancelBooking: h.cancelBooking,
  paymentEligibleForPaidCancelPath: vi.fn(async () => true),
}));
// The paid preview's money readers, stubbed so the test reaches the paid
// answer; the figures themselves are pinned in the cancel preview's own tests.
vi.mock("@/lib/rate-limit", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/rate-limit")),
  checkRateLimit: vi.fn(async () => ({ success: true })),
}));
vi.mock("@/lib/internet-banking-part-payment-at-cancel", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/internet-banking-part-payment-at-cancel")),
  readPartPaymentAtCancel: vi.fn(async () => null),
}));
vi.mock("@/lib/cancellation", () => ({ loadCancellationPolicy: vi.fn(async () => []) }));
vi.mock("@/lib/policies/booking-route-decisions", () => ({
  calculateCancellationPreview: h.calculateCancellationPreview,
}));
vi.mock("@/lib/club-time/server", () => ({ clubTime: vi.fn(async () => ({ today: () => "2026-07-01" })) }));
vi.mock("@/lib/stripe-dispute-hold", () => ({ paymentDisputedCaptureCents: vi.fn(async () => ({ cents: 0 })) }));
vi.mock("@/lib/superseded-capture-hold-back", () => ({ readSupersededCaptureHeldBack: vi.fn(async () => ({ totalCents: 0 })) }));
vi.mock("@/lib/booking-credit-give-back-marker", () => ({ bookingReducedThroughCreditGiveBack: vi.fn(async () => false) }));
vi.mock("@/lib/member-credit", () => ({ deriveBookingAppliedCreditCents: vi.fn(async () => 0) }));
vi.mock("@/lib/cancel-card-refund-shortfall-preview", () => ({
  cancelPreviewCardShortfall: vi.fn(async () => ({ cardShortfall: { cardCents: 8000, bankCents: 0, checkCents: 0 } })),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    booking: { findUnique: h.bookingFindUnique },
    memberCredit: { aggregate: vi.fn(async () => ({ _sum: { amountCents: null } })) },
  },
}));
// The unpaid answer names only fields the action promises, so a stray one is
// added here: a route that skipped the projection would send it.
vi.mock("@/lib/cancel-preview-answer", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("@/lib/cancel-preview-answer");
  return {
    ...actual,
    unpaidCancelPreviewAnswer: (input: Parameters<typeof actual.unpaidCancelPreviewAnswer>[0]) => ({
      ...actual.unpaidCancelPreviewAnswer(input),
      internalNote: "not for an AI provider",
    }),
  };
});
vi.mock("@/lib/club-format-server", () => ({ clubFormatValues: vi.fn(async () => ({})) }));
vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { POST } from "@/app/api/bookings/[id]/cancel/route";
import { GET as preview } from "@/app/api/bookings/[id]/cancel-preview/route";
import { officerMemberSession } from "@/lib/__tests__/helpers/mcp-action-contract";
import { MCP_PRINCIPAL_HEADER } from "@/lib/mcp/principal";

const OFFICER = "officer-1";
const params = Promise.resolve({ id: "b1" });

function cancelRequest(body: unknown, viaConnection: boolean) {
  return new NextRequest("http://localhost/api/bookings/b1/cancel", {
    method: "POST",
    body: JSON.stringify(body),
    headers: {
      "content-type": "application/json",
      ...(viaConnection ? { [MCP_PRINCIPAL_HEADER]: "signed-principal" } : {}),
    },
  });
}

function previewRequest(viaConnection: boolean) {
  return new NextRequest("http://localhost/api/bookings/b1/cancel-preview", {
    headers: viaConnection ? { [MCP_PRINCIPAL_HEADER]: "signed-principal" } : {},
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  // A Full Admin who is also a Booking Officer: the widest reach the website gives.
  h.auth.mockResolvedValue(officerMemberSession(OFFICER));
  h.requireActiveSessionUser.mockResolvedValue(null);
  h.cancelBooking.mockResolvedValue({
    status: 200,
    data: { success: true, refundAmountCents: 0, refundPercentage: 0, refundMethod: "card", message: "ok" },
  });
});

describe("POST /api/bookings/[id]/cancel through an AI app connection", () => {
  it("hands the service member authority only: role USER and no Booking Officer flag", async () => {
    const res = await POST(cancelRequest({ refundMethod: "card" }, true), { params });
    expect(res.status).toBe(200);
    const [, actor, role, , , , options] = h.cancelBooking.mock.calls[0];
    expect(actor).toBe(OFFICER);
    expect(role).toBe("USER");
    expect(options).toMatchObject({
      hasBookingsEditAccess: false,
      enforceStartedStayBlock: true,
      enforceMemberCancelDoor: true,
    });
  });

  it("refuses an officer's hosting-coverage override from a connection before the service runs", async () => {
    const override = { acknowledged: true, reason: "The custodian covers this stay.", strandedStateKey: `v1:${"a".repeat(64)}` };
    const res = await POST(cancelRequest({ refundMethod: "card", hostingCoverageOverride: override }, true), { params });
    expect(res.status).toBe(403);
    expect(h.cancelBooking).not.toHaveBeenCalled();
  });

  it("refuses the officer-only email choice from a connection before the service runs", async () => {
    const res = await POST(cancelRequest({ refundMethod: "card", notifyMember: false }, true), { params });
    expect(res.status).toBe(403);
    expect(h.cancelBooking).not.toHaveBeenCalled();
  });

  it("sends a connection only the cancel_my_booking fields of the service's answer", async () => {
    const data = {
      success: true,
      refundAmountCents: 0,
      refundPercentage: 0,
      refundMethod: "card",
      message: "ok",
      internalLedgerNote: "not for an AI provider",
      // Record ids the member cannot act on: kept from the AI provider.
      stripeRefundId: "re_123",
      manualRefundTaskId: "task-9",
    };
    h.cancelBooking.mockResolvedValue({ status: 200, data });
    const viaConnection = await POST(cancelRequest({ refundMethod: "card" }, true), { params });
    const { internalLedgerNote: _withheld, stripeRefundId: _refundId, manualRefundTaskId: _taskId, ...promised } = data;
    expect(await viaConnection.json()).toEqual(promised);
    const viaBrowser = await POST(cancelRequest({ refundMethod: "card" }, false), { params });
    expect(await viaBrowser.json()).toEqual(data);
  });

  it("keeps the officer's reach on the website, without the header", async () => {
    const res = await POST(cancelRequest({ refundMethod: "card" }, false), { params });
    expect(res.status).toBe(200);
    const [, , role, , , , options] = h.cancelBooking.mock.calls[0];
    expect(role).toBe("ADMIN");
    expect(options).toMatchObject({ hasBookingsEditAccess: true });
  });
});

describe("GET /api/bookings/[id]/cancel-preview through an AI app connection", () => {
  it("refuses another member's booking to an officer's connection", async () => {
    h.bookingFindUnique.mockResolvedValue({ id: "b1", memberId: "member-2", status: "PAID" });
    const res = await preview(previewRequest(true), { params });
    expect(res.status).toBe(403);
  });

  it("still lets the officer's connection reach the officer's own booking", async () => {
    // A status the member door refuses answers 400 AFTER the ownership gate,
    // which proves the gate let the officer's own booking through.
    h.bookingFindUnique.mockResolvedValue({ id: "b1", memberId: OFFICER, status: "CANCELLED" });
    const res = await preview(previewRequest(true), { params });
    expect(res.status).toBe(400);
  });

  it("sends a connection only the preview_cancel_booking fields of an unpaid preview", async () => {
    h.bookingFindUnique.mockResolvedValue({ id: "b1", memberId: OFFICER, status: "PENDING", payment: null });
    const viaConnection = await preview(previewRequest(true), { params });
    expect(viaConnection.status).toBe(200);
    const connection = await viaConnection.json();
    expect(connection).toMatchObject({ hasPayment: false, creditRestoredCents: 0 });
    expect(connection).not.toHaveProperty("internalNote");
    const viaBrowser = await preview(previewRequest(false), { params });
    expect(await viaBrowser.json()).toMatchObject({ internalNote: "not for an AI provider" });
  });

  it("sends a connection only the preview_cancel_booking fields of a paid preview", async () => {
    // The paid answer spreads the policy calculation, so a field added there
    // reaches the website at once; the route must project it for a connection.
    const figures = {
      refundAmountCents: 8000,
      keptAmountCents: 2000,
      changeFeeCents: 0,
      refundPercentage: 80,
      creditRefundAmountCents: 0,
      creditRefundPercentage: 0,
      creditRestoredCents: 0,
      totalPaidCents: 10000,
    };
    h.calculateCancellationPreview.mockReturnValue({ ...figures, policyTierInternalId: "tier-7" });
    h.bookingFindUnique.mockResolvedValue({
      id: "b1",
      memberId: OFFICER,
      status: "PAID",
      checkIn: new Date("2026-08-01T00:00:00.000Z"),
      lodgeId: "lodge-1",
      finalPriceCents: 10000,
      payment: {
        id: "p1",
        source: "STRIPE",
        amountCents: 10000,
        refundedAmountCents: 0,
        changeFeeCents: 0,
        manuallyMarkedPaidAt: null,
        manualRefundTasks: [],
      },
    });
    const viaConnection = await preview(previewRequest(true), { params });
    expect(viaConnection.status).toBe(200);
    const connection = await viaConnection.json();
    expect(connection).toMatchObject({ ...figures, hasPayment: true, manualRefund: false });
    expect(connection).not.toHaveProperty("policyTierInternalId");
    const viaBrowser = await preview(previewRequest(false), { params });
    expect(await viaBrowser.json()).toMatchObject({ policyTierInternalId: "tier-7" });
  });

  it("keeps the officer's preview of another member's booking on the website", async () => {
    h.bookingFindUnique.mockResolvedValue({ id: "b1", memberId: "member-2", status: "CANCELLED" });
    const res = await preview(previewRequest(false), { params });
    expect(res.status).toBe(400);
  });
});
