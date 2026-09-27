import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #3643 (`INV-PAY-107`): the cancel dialog's figures must agree with the
 * cancel for an internet banking booking Xero shows partly paid. The cancel
 * records the part payment and applies the policy to it; the preview asks the
 * same live question through the same reader (`readPartPaymentAtCancel`), so
 * it quotes the policy on the part payment, and refuses exactly when the
 * cancel would.
 */

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  requireActiveSessionUser: vi.fn(),
  bookingFindUnique: vi.fn(),
  memberCreditAggregate: vi.fn(),
  clubTimeSettingsFindUnique: vi.fn(),
  loadCancellationPolicy: vi.fn(),
  paymentEligibleForPaidCancelPath: vi.fn(),
  readHoldPaymentEvidence: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ auth: mocks.auth }));
vi.mock("@/lib/session-guards", () => ({
  requireActiveSessionUser: mocks.requireActiveSessionUser,
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    booking: { findUnique: mocks.bookingFindUnique },
    memberCredit: { aggregate: mocks.memberCreditAggregate },
    clubTimeSettings: { findUnique: mocks.clubTimeSettingsFindUnique },
  },
}));
vi.mock("@/lib/cancellation", () => ({
  loadCancellationPolicy: mocks.loadCancellationPolicy,
}));
vi.mock("@/lib/booking-cancel", () => ({
  paymentEligibleForPaidCancelPath: mocks.paymentEligibleForPaidCancelPath,
}));
vi.mock("@/lib/internet-banking-hold-payment-evidence", () => ({
  readHoldPaymentEvidence: mocks.readHoldPaymentEvidence,
}));
vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import { GET } from "@/app/api/bookings/[id]/cancel-preview/route";

// Half back when cancelled at least 14 days out; the frozen clock is 1 July
// and check-in is 1 August, so the half tier applies.
const POLICY = [
  { daysBeforeStay: 14, refundPercentage: 50, creditRefundPercentage: 50 },
  { daysBeforeStay: 0, refundPercentage: 0, creditRefundPercentage: 0 },
];

function partPaidBooking() {
  return {
    id: "booking-ib",
    memberId: "member-1",
    lodgeId: "lodge-1",
    status: "CONFIRMED",
    finalPriceCents: 30_000,
    checkIn: new Date("2026-08-01T00:00:00.000Z"),
    payment: {
      id: "payment-ib",
      bookingId: "booking-ib",
      source: "INTERNET_BANKING",
      status: "PENDING",
      xeroInvoiceId: "inv-ib",
      xeroInvoiceNumber: "INV-IB",
      manuallyMarkedPaidAt: null,
      amountCents: 30_000,
      refundedAmountCents: 0,
      changeFeeCents: 0,
      creditAppliedCents: 0,
    },
  };
}

const PART_PAID = {
  kind: "paid",
  readStartedAt: new Date(),
  invoices: [],
  fromRecordedLinkOnly: false,
  paidCents: 15_000,
  cashComplete: true,
  amountDueCents: 15_000,
  paidInFull: false,
};

async function preview() {
  const response = await GET(
    new Request("http://localhost/api/bookings/booking-ib/cancel-preview") as never,
    { params: Promise.resolve({ id: "booking-ib" }) },
  );
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockResolvedValue({ user: { id: "member-1" } });
  mocks.requireActiveSessionUser.mockResolvedValue(null);
  mocks.bookingFindUnique.mockResolvedValue(partPaidBooking());
  mocks.memberCreditAggregate.mockResolvedValue({ _sum: { amountCents: 0 } });
  mocks.loadCancellationPolicy.mockResolvedValue(POLICY);
  // A PENDING payment: the ordinary eligibility says no money was captured.
  mocks.paymentEligibleForPaidCancelPath.mockResolvedValue(false);
  mocks.clubTimeSettingsFindUnique.mockResolvedValue({
    timeZone: "Pacific/Auckland",
    updatedByMemberId: null,
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  });
  mocks.readHoldPaymentEvidence.mockResolvedValue(PART_PAID);
});

describe("cancel preview for a part-paid internet banking booking (#3643)", () => {
  it("quotes the policy on the part payment the cancel will record, as credit", async () => {
    const { status, body } = await preview();

    expect(status).toBe(200);
    expect(body).toMatchObject({
      hasPayment: true,
      totalPaidCents: 15_000,
      creditRefundAmountCents: 7_500,
      creditRefundPercentage: 50,
      manualRefund: false,
    });
    expect(mocks.readHoldPaymentEvidence).toHaveBeenCalledWith(
      expect.objectContaining({ id: "payment-ib", xeroInvoiceId: "inv-ib" }),
    );
  });

  it("refuses with the cancel's own sentence when Xero shows cash it cannot size", async () => {
    mocks.readHoldPaymentEvidence.mockResolvedValue({
      ...PART_PAID,
      fromRecordedLinkOnly: true,
      cashComplete: false,
      amountDueCents: null,
    });

    const { status, body } = await preview();

    expect(status).toBe(409);
    expect(String(body.error)).toContain("could not be read exactly");
  });

  it("still shows nothing paid when Xero shows nothing paid", async () => {
    mocks.readHoldPaymentEvidence.mockResolvedValue({
      kind: "unpaid",
      readStartedAt: new Date(),
      invoices: [],
    });

    const { status, body } = await preview();

    expect(status).toBe(200);
    expect(body).toMatchObject({ hasPayment: false, creditRefundAmountCents: 0 });
  });
});
