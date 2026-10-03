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
  hasAdminAccess: vi.fn(),
  checkRateLimit: vi.fn(),
  manualRefundTaskAggregate: vi.fn(),
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
    // #3827 (`INV-PAY-114`): no open edit refund hand-back on file.
    manualRefundTask: { aggregate: mocks.manualRefundTaskAggregate },
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
vi.mock("@/lib/access-roles", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/access-roles")),
  hasAdminAccess: mocks.hasAdminAccess,
}));
vi.mock("@/lib/admin-permissions", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/admin-permissions")),
  hasAdminAreaAccess: () => false,
}));
vi.mock("@/lib/rate-limit", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/rate-limit")),
  checkRateLimit: mocks.checkRateLimit,
}));
vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import { GET } from "@/app/api/bookings/[id]/cancel-preview/route";
import { clearPartPaymentPreviewCacheForTests } from "@/lib/internet-banking-part-payment-at-cancel";

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
  clearPartPaymentPreviewCacheForTests();
  mocks.hasAdminAccess.mockReturnValue(false);
  mocks.checkRateLimit.mockResolvedValue({ success: true, limit: 60, remaining: 59, resetAt: Date.now() + 60_000 });
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
  mocks.manualRefundTaskAggregate.mockResolvedValue({ _sum: { amountCents: null } });
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
      // The cancel refunds internet banking as credit; the dialog offers only that.
      refundMethodForced: "credit",
    });
    expect(mocks.readHoldPaymentEvidence).toHaveBeenCalledWith(
      expect.objectContaining({ id: "payment-ib", xeroInvoiceId: "inv-ib" }),
    );
  });

  it("#3827 (INV-PAY-114): quotes only the cash not already promised back on an open edit refund hand-back", async () => {
    // $150 recorded, $50 of it already owed back on an earlier edit's task -
    // read on the SAME booking read as the payment, never a second query.
    const booking = partPaidBooking();
    mocks.bookingFindUnique.mockResolvedValue({
      ...booking,
      payment: { ...booking.payment, manualRefundTasks: [{ amountCents: 5_000 }] },
    });

    const { status, body } = await preview();

    expect(status).toBe(200);
    expect(body).toMatchObject({ totalPaidCents: 10_000, creditRefundAmountCents: 5_000 });
    expect(mocks.bookingFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        include: {
          payment: {
            include: {
              manualRefundTasks: {
                where: {
                  status: "OPEN",
                  kind: "CANCELLED_BOOKING_HAND_BACK",
                  occurrenceKey: { startsWith: "edit-refund-hand-back:" },
                },
                select: { amountCents: true },
              },
            },
          },
        },
      }),
    );
    expect(mocks.manualRefundTaskAggregate).not.toHaveBeenCalled();
  });

  it("sends a member to the club, with the cancel's own sentence, when Xero shows cash it cannot size", async () => {
    mocks.readHoldPaymentEvidence.mockResolvedValue({
      ...PART_PAID,
      fromRecordedLinkOnly: true,
      cashComplete: false,
      amountDueCents: null,
    });

    const { status, body } = await preview();

    expect(status).toBe(409);
    expect(String(body.error)).toContain("contact the club");
  });

  it("DECISION 2: tells an officer the booking cancels as unpaid and the payment is settled by hand", async () => {
    mocks.hasAdminAccess.mockReturnValue(true);
    mocks.readHoldPaymentEvidence.mockResolvedValue({
      ...PART_PAID,
      fromRecordedLinkOnly: true,
      cashComplete: false,
      amountDueCents: null,
    });

    const { status, body } = await preview();

    expect(status).toBe(200);
    expect(body).toMatchObject({ hasPayment: false, paymentSettledByHand: true, creditRefundAmountCents: 0 });
  });

  it("reads Xero at most once a minute per booking for the dialog (D8)", async () => {
    await preview();
    await preview();

    expect(mocks.readHoldPaymentEvidence).toHaveBeenCalledTimes(1);
  });

  it("is rate-limited per user before any Xero read (D8)", async () => {
    mocks.checkRateLimit.mockResolvedValue({ success: false, limit: 60, remaining: 0, resetAt: Date.now() + 60_000 });

    const { status } = await preview();

    expect(status).toBe(429);
    expect(mocks.readHoldPaymentEvidence).not.toHaveBeenCalled();
    expect(mocks.checkRateLimit).toHaveBeenCalledWith(
      expect.objectContaining({ id: "booking-query" }),
      "cancel-preview:member-1",
    );
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
