import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * B5 (#2262) — the mark-paid route's contract.
 *
 * Two shapes are refused with 422 rather than guessed, both because an
 * ambiguous money action is worse than a refused one:
 *  * #2260 notifyMember — required on "paid", rejected on "unpaid";
 *  * expectedAmountCents — required on "paid" (there is nothing to reconcile the
 *    admin's figure against without it), rejected on "unpaid".
 * And the route is gated finance:edit, not bookings:edit, despite its
 * bookings-shaped path.
 */

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  applyManualBookingPayment: vi.fn(),
}));

vi.mock("@/lib/session-guards", () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/manual-booking-payment", async () => {
  const actual = (await vi.importActual("@/lib/manual-booking-payment")) as typeof import("@/lib/manual-booking-payment");
  return { ...actual, applyManualBookingPayment: mocks.applyManualBookingPayment };
});
vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/audit", () => ({ createAuditLog: vi.fn() }));
vi.mock("@/lib/email", () => ({ sendBookingConfirmedEmail: vi.fn() }));
vi.mock("@/lib/booking-events", () => ({ recordBookingEvent: vi.fn() }));
vi.mock("@/lib/payment-transactions", () => ({
  applyLocalRefundAllocation: vi.fn(),
}));

import { POST } from "@/app/api/admin/bookings/[id]/mark-paid/route";

const params = Promise.resolve({ id: "booking-1" });

function makeRequest(body: Record<string, unknown>) {
  return new NextRequest(
    "https://example.test/api/admin/bookings/booking-1/mark-paid",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireAdmin.mockResolvedValue({
    ok: true,
    session: { user: { id: "admin-1" } },
  });
  mocks.applyManualBookingPayment.mockResolvedValue({
    bookingId: "booking-1",
    paymentId: "payment-1",
    direction: "paid",
    memberNotified: false,
    receipt: "not_requested",
    amountCents: 10000,
    bookingStatus: "PAID",
    creditElectionCents: null,
  });
});

describe("POST /api/admin/bookings/[id]/mark-paid", () => {
  it("is gated on finance:edit, not bookings:edit", async () => {
    await POST(
      makeRequest({
        direction: "paid",
        confirmed: true,
        notifyMember: false,
        expectedAmountCents: 10000,
      }),
      { params },
    );

    expect(mocks.requireAdmin).toHaveBeenCalledWith({
      permission: { area: "finance", level: "edit" },
    });
  });

  it("422s when marking paid without saying whether to email the member", async () => {
    const response = await POST(
      makeRequest({ direction: "paid", confirmed: true, expectedAmountCents: 1 }),
      { params },
    );

    expect(response.status).toBe(422);
    expect((await response.json()).error).toMatch(/notifyMember is required/);
    expect(mocks.applyManualBookingPayment).not.toHaveBeenCalled();
  });

  it("422s when a reversal carries notifyMember", async () => {
    const response = await POST(
      makeRequest({ direction: "unpaid", confirmed: true, notifyMember: false }),
      { params },
    );

    expect(response.status).toBe(422);
    expect((await response.json()).error).toMatch(/never emails the member/);
    expect(mocks.applyManualBookingPayment).not.toHaveBeenCalled();
  });

  it("422s when marking paid without the amount the admin was shown", async () => {
    const response = await POST(
      makeRequest({ direction: "paid", confirmed: true, notifyMember: true }),
      { params },
    );

    expect(response.status).toBe(422);
    expect((await response.json()).error).toMatch(/expectedAmountCents is required/);
  });

  it("422s when a reversal carries expectedAmountCents", async () => {
    const response = await POST(
      makeRequest({
        direction: "unpaid",
        confirmed: true,
        expectedAmountCents: 10000,
      }),
      { params },
    );

    expect(response.status).toBe(422);
    expect((await response.json()).error).toMatch(/settles no amount/);
  });

  it("400s without the explicit confirmation, so a money action is never a single click", async () => {
    const response = await POST(
      makeRequest({
        direction: "paid",
        notifyMember: false,
        expectedAmountCents: 10000,
      }),
      { params },
    );

    expect(response.status).toBe(400);
  });

  it("reports the receipt honestly rather than claiming a delivery", async () => {
    mocks.applyManualBookingPayment.mockResolvedValue({
      bookingId: "booking-1",
      paymentId: "payment-1",
      direction: "paid",
      memberNotified: true,
      receipt: "not_delivered",
      amountCents: 10000,
      bookingStatus: "PAID",
    });

    const response = await POST(
      makeRequest({
        direction: "paid",
        confirmed: true,
        notifyMember: true,
        expectedAmountCents: 10000,
      }),
      { params },
    );

    expect(response.status).toBe(200);
    expect((await response.json()).message).toMatch(
      /could not be sent — check the booking's email settings/,
    );
  });

  it("surfaces a domain refusal with its own status and message", async () => {
    const { ManualBookingPaymentError } = (await vi.importActual("@/lib/payment-reconciliation")) as typeof import("@/lib/payment-reconciliation");
    mocks.applyManualBookingPayment.mockRejectedValue(
      new ManualBookingPaymentError(
        "This booking has an outstanding Xero invoice — record the payment against the invoice in Xero instead.",
        409,
      ),
    );

    const response = await POST(
      makeRequest({
        direction: "paid",
        confirmed: true,
        notifyMember: false,
        expectedAmountCents: 10000,
      }),
      { params },
    );

    expect(response.status).toBe(409);
    expect((await response.json()).error).toMatch(/outstanding Xero invoice/);
  });

  /**
   * #2265 (#2262 door 3, delta LOW-e). The operator alert that also reports a
   * moved credit election is gated on the club's `adminPaymentFailure`
   * notification preference, which a club may have muted. The admin who has
   * just taken the member's cash must be told at the till regardless, so the
   * route says it in the response the dialog shows.
   */
  it("tells the admin synchronously when the settle CLEARED a stored credit election", async () => {
    mocks.applyManualBookingPayment.mockResolvedValue({
      bookingId: "booking-1",
      paymentId: "payment-1",
      direction: "paid",
      memberNotified: false,
      receipt: "not_requested",
      amountCents: 12000,
      bookingStatus: "PAID",
      creditElectionCents: 4500,
    });

    const response = await POST(
      makeRequest({
        direction: "paid",
        confirmed: true,
        notifyMember: false,
        expectedAmountCents: 12000,
      }),
      { params },
    );

    const message = (await response.json()).message as string;
    expect(message).toContain("Payment recorded.");
    expect(message).toContain("$45.00");
    expect(message).toMatch(/cash cannot use it/);
    expect(message).toMatch(/still on their account/);
  });

  it("tells the admin synchronously when a reversal RESTORED the member's election", async () => {
    mocks.applyManualBookingPayment.mockResolvedValue({
      bookingId: "booking-1",
      paymentId: "payment-1",
      direction: "unpaid",
      memberNotified: false,
      receipt: "not_requested",
      amountCents: 12000,
      bookingStatus: "PAYMENT_PENDING",
      creditElectionCents: 4500,
    });

    const response = await POST(
      makeRequest({ direction: "unpaid", confirmed: true }),
      { params },
    );

    const message = (await response.json()).message as string;
    expect(message).toContain("Manual payment reversed.");
    expect(message).toContain("$45.00");
    expect(message).toMatch(/put back on the booking/);
  });

  it("says nothing about credit on the ordinary settlement, which moves none", async () => {
    const response = await POST(
      makeRequest({
        direction: "paid",
        confirmed: true,
        notifyMember: false,
        expectedAmountCents: 10000,
      }),
      { params },
    );

    expect((await response.json()).message).toBe(
      "Payment recorded. The member was not emailed.",
    );
  });
});

/**
 * #2397 — the extra-owing half of the same contract.
 *
 * `additionalCoverage` is sent ONLY when the dialog showed an outstanding
 * extra; omitting it is the claim that it did not, which the settlement core
 * re-checks under its locks. A reversal never carries it, because a reversal
 * always puts an extra it settled back to owing.
 */
describe("POST /api/admin/bookings/[id]/mark-paid — the outstanding extra (#2397)", () => {
  it("passes the admin's answer, and its stale-figure guard, straight through", async () => {
    await POST(
      makeRequest({
        direction: "paid",
        confirmed: true,
        notifyMember: false,
        expectedAmountCents: 12100,
        additionalCoverage: {
          covered: true,
          expectedAdditionalAmountCents: 2100,
        },
      }),
      { params },
    );

    expect(mocks.applyManualBookingPayment).toHaveBeenCalledWith(
      expect.objectContaining({
        direction: "paid",
        expectedAmountCents: 12100,
        additionalCoverage: {
          covered: true,
          expectedAdditionalAmountCents: 2100,
        },
      }),
    );
  });

  it("sends null — never an invented default — when the dialog showed no extra", async () => {
    await POST(
      makeRequest({
        direction: "paid",
        confirmed: true,
        notifyMember: false,
        expectedAmountCents: 10000,
      }),
      { params },
    );

    expect(mocks.applyManualBookingPayment).toHaveBeenCalledWith(
      expect.objectContaining({ additionalCoverage: null }),
    );
  });

  it("422s when a reversal carries an answer about an extra", async () => {
    const response = await POST(
      makeRequest({
        direction: "unpaid",
        confirmed: true,
        additionalCoverage: {
          covered: true,
          expectedAdditionalAmountCents: 2100,
        },
      }),
      { params },
    );

    expect(response.status).toBe(422);
    expect((await response.json()).error).toMatch(/additionalCoverage cannot be sent/);
    expect(mocks.applyManualBookingPayment).not.toHaveBeenCalled();
  });

  it("400s on a malformed answer rather than coercing it", async () => {
    const response = await POST(
      makeRequest({
        direction: "paid",
        confirmed: true,
        notifyMember: false,
        expectedAmountCents: 12100,
        additionalCoverage: { covered: true, expectedAdditionalAmountCents: 0 },
      }),
      { params },
    );

    expect(response.status).toBe(400);
    expect(mocks.applyManualBookingPayment).not.toHaveBeenCalled();
  });

  it("tells the admin what became of the extra, both ways", async () => {
    mocks.applyManualBookingPayment.mockResolvedValue({
      bookingId: "booking-1",
      paymentId: "payment-1",
      direction: "paid",
      memberNotified: false,
      receipt: "not_requested",
      amountCents: 12100,
      bookingStatus: "PAID",
      creditElectionCents: null,
      additional: {
        outstandingCents: 2100,
        settled: true,
        recordedAmountCents: 12100,
        payableOnline: false,
      },
    });
    const settled = await POST(
      makeRequest({
        direction: "paid",
        confirmed: true,
        notifyMember: false,
        expectedAmountCents: 12100,
        additionalCoverage: {
          covered: true,
          expectedAdditionalAmountCents: 2100,
        },
      }),
      { params },
    );
    expect((await settled.json()).message).toMatch(
      /\$21\.00 extra owing on this booking was recorded as settled too/,
    );

    mocks.applyManualBookingPayment.mockResolvedValue({
      bookingId: "booking-1",
      paymentId: "payment-1",
      direction: "paid",
      memberNotified: false,
      receipt: "not_requested",
      // The not-covered branch records only what was handed over.
      amountCents: 10000,
      bookingStatus: "PAID",
      creditElectionCents: null,
      additional: {
        outstandingCents: 2100,
        settled: false,
        recordedAmountCents: 10000,
        payableOnline: true,
      },
    });
    const unsettled = await POST(
      makeRequest({
        direction: "paid",
        confirmed: true,
        notifyMember: false,
        expectedAmountCents: 12100,
        additionalCoverage: {
          covered: false,
          expectedAdditionalAmountCents: 2100,
        },
      }),
      { params },
    );
    const unsettledMessage = (await unsettled.json()).message as string;
    expect(unsettledMessage).toMatch(/still be asked for it/);
    // Owner decision, 31 Jul 2026: the RECORDED figure is named, because this is
    // the branch where the club deliberately books less than the booking's worth.
    expect(unsettledMessage).toMatch(
      /Only \$100\.00 was recorded as received/,
    );
    // #2397 F4: chasing a member for money they cannot send is the worst
    // available outcome, so the toast says which of the two situations applies.
    expect(unsettledMessage).toMatch(
      /They can pay it themselves from their booking page/,
    );
  });

  it("tells the admin to make contact when no card door survives for the extra", async () => {
    mocks.applyManualBookingPayment.mockResolvedValue({
      bookingId: "booking-1",
      paymentId: "payment-1",
      direction: "paid",
      memberNotified: false,
      receipt: "not_requested",
      amountCents: 10000,
      bookingStatus: "PAID",
      creditElectionCents: null,
      additional: {
        outstandingCents: 2100,
        settled: false,
        recordedAmountCents: 10000,
        payableOnline: false,
      },
    });

    const response = await POST(
      makeRequest({
        direction: "paid",
        confirmed: true,
        notifyMember: false,
        expectedAmountCents: 12100,
        additionalCoverage: {
          covered: false,
          expectedAdditionalAmountCents: 2100,
        },
      }),
      { params },
    );

    const message = (await response.json()).message as string;
    expect(message).toMatch(/someone will need to contact them to collect it/);
    expect(message).not.toMatch(/pay it themselves/);
  });
});
