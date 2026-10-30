import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #3949 (owner decision, 22 Oct 2026; `INV-PAY-137`): a joiner cancelling a
 * place the group organiser paid for by internet banking is refunded to the
 * ORGANISER by bank transfer, tiered on the CARD tiers as every refund to the
 * organiser is - never on the credit tiers an internet banking payment of the
 * joiner's own would use. With the two tiers apart (50% card, 75% credit) a
 * $400 place quotes $200, the figure the cancel raises its hand-back for
 * (`ib-group-child-hand-back.realdb.test.ts` proves the cancel's side).
 */

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  requireActiveSessionUser: vi.fn(),
  bookingFindUnique: vi.fn(),
  clubTimeSettingsFindUnique: vi.fn(),
  loadCancellationPolicy: vi.fn(),
  paymentEligibleForPaidCancelPath: vi.fn(),
  checkRateLimit: vi.fn(),
  transaction: vi.fn(),
  modifications: vi.fn(),
  receipts: vi.fn(),
  extraLinks: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ auth: mocks.auth }));
vi.mock("@/lib/session-guards", () => ({ requireActiveSessionUser: mocks.requireActiveSessionUser }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    booking: { findUnique: mocks.bookingFindUnique },
    clubTimeSettings: { findUnique: mocks.clubTimeSettingsFindUnique },
    memberCredit: { aggregate: async () => ({ _sum: { amountCents: null } }) },
    bookingModification: { findMany: mocks.modifications, findFirst: async () => null },
    paymentTransaction: { findMany: mocks.receipts },
    xeroObjectLink: { findMany: mocks.extraLinks },
    xeroSyncOperation: { findMany: async () => [] },
    // A card-shortfall read would open a snapshot here; the organiser's refund by hand never asks for one.
    $transaction: mocks.transaction,
  },
}));
vi.mock("@/lib/cancellation", () => ({ loadCancellationPolicy: mocks.loadCancellationPolicy }));
vi.mock("@/lib/booking-cancel", () => ({ paymentEligibleForPaidCancelPath: mocks.paymentEligibleForPaidCancelPath }));
vi.mock("@/lib/club-format-server", async () => {
  const { CLUB_FORMAT_TEST } = await import("@/lib/__tests__/support/club-format-fixture");
  return { clubFormatValues: async () => CLUB_FORMAT_TEST };
});
vi.mock("@/lib/internet-banking-part-payment-at-cancel", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/internet-banking-part-payment-at-cancel")),
  readPartPaymentAtCancel: async () => null,
}));
vi.mock("@/lib/access-roles", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/access-roles")),
  hasAdminAccess: () => false,
}));
vi.mock("@/lib/admin-permissions", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/admin-permissions")),
  hasAdminAreaAccess: () => false,
}));
vi.mock("@/lib/rate-limit", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/rate-limit")),
  checkRateLimit: mocks.checkRateLimit,
}));
vi.mock("@/lib/logger", () => ({ default: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));

import { GET } from "@/app/api/bookings/[id]/cancel-preview/route";

// The frozen clock is 1 July and check-in 1 August: the 14-day tier applies.
const POLICY = [
  { daysBeforeStay: 14, refundPercentage: 50, creditRefundPercentage: 75 },
  { daysBeforeStay: 0, refundPercentage: 0, creditRefundPercentage: 0 },
];
const PLACE_CENTS = 40_000;

function joinerBooking(organiserPaid: boolean) {
  return {
    id: "child-1",
    memberId: "member-1",
    lodgeId: "lodge-1",
    status: "PAID",
    organiserSettled: organiserPaid,
    parentBookingId: organiserPaid ? "organiser-1" : null,
    finalPriceCents: PLACE_CENTS,
    checkIn: new Date("2026-08-01T00:00:00.000Z"),
    payment: {
      id: "payment-child-1",
      bookingId: "child-1",
      source: "INTERNET_BANKING",
      status: "SUCCEEDED",
      manuallyMarkedPaidAt: null,
      amountCents: PLACE_CENTS,
      refundedAmountCents: 0,
      changeFeeCents: 0,
      creditAppliedCents: 0,
      manualRefundTasks: [],
    },
  };
}

async function preview() {
  const response = await GET(new Request("http://localhost/api/bookings/child-1/cancel-preview") as never, {
    params: Promise.resolve({ id: "child-1" }),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.modifications.mockResolvedValue([]);
  mocks.receipts.mockResolvedValue([]);
  mocks.extraLinks.mockResolvedValue([{ localId: "increase", xeroObjectId: "extra", metadata: { organiserBilling: true, priceDiffCents: 5_000, changeFeeCents: 1_000 } }]);
  mocks.checkRateLimit.mockResolvedValue({ success: true, limit: 60, remaining: 59, resetAt: Date.now() + 60_000 });
  mocks.auth.mockResolvedValue({ user: { id: "member-1" } });
  mocks.requireActiveSessionUser.mockResolvedValue(null);
  mocks.loadCancellationPolicy.mockResolvedValue(POLICY);
  mocks.paymentEligibleForPaidCancelPath.mockResolvedValue(true);
  mocks.clubTimeSettingsFindUnique.mockResolvedValue({
    timeZone: "Pacific/Auckland",
    updatedByMemberId: null,
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  });
});

describe("#3949: the cancel preview for a joiner the organiser paid for by internet banking", () => {
  it("quotes the card tier's $200 of a $400 place, refunded to the organiser by hand, never the 75% credit tier", async () => {
    mocks.bookingFindUnique.mockResolvedValue(joinerBooking(true));

    const { status, body } = await preview();

    expect(status).toBe(200);
    // The dialog's organiser note reads `refundAmountCents` (`ForcedRefundNote`), the card tier.
    expect(body).toMatchObject({ refundMethodForced: "organiser_by_hand", refundAmountCents: 20_000, refundPercentage: 50, manualRefund: false });
    expect(body).not.toHaveProperty("cardShortfall");
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("the joiner's own internet banking payment is still forced to account credit, on the credit tier", async () => {
    mocks.bookingFindUnique.mockResolvedValue(joinerBooking(false));

    const { body } = await preview();

    expect(body).toMatchObject({ refundMethodForced: "credit", creditRefundAmountCents: 30_000, creditRefundPercentage: 75 });
  });
});


describe("#4299: preview only withholds extra-invoice fees actually paid", () => {
  it.each([
    { cashCents: 0, refundCents: 15_000 },
    { cashCents: 500, refundCents: 15_000 },
    { cashCents: 2_000, refundCents: 15_500 },
    { cashCents: 6_000, refundCents: 17_500 },
  ])("matches cancellation for $cashCents cents paid on the extra", async ({ cashCents, refundCents }) => {
    const booking = joinerBooking(true);
    booking.finalPriceCents = 35_000;
    booking.payment.amountCents = 30_000 + cashCents;
    booking.payment.changeFeeCents = 1_000;
    mocks.bookingFindUnique.mockResolvedValue(booking);
    mocks.modifications.mockResolvedValue([{ id: "increase", priceDiffCents: 5_000, changeFeeCents: 1_000 }]);
    mocks.receipts.mockResolvedValue([{ xeroInvoiceId: "extra", amountCents: cashCents }]);

    const { status, body } = await preview();

    expect(status).toBe(200);
    expect(body).toMatchObject({ refundMethodForced: "organiser_by_hand", refundAmountCents: refundCents, refundPercentage: 50 });
  });
});

describe("#4299: a price cut pays part of the extra invoice fee", () => {
  it.each([
    { cashCents: 500, paidFeeCents: 1_000, refundCents: 14_750 },
    { cashCents: 200, paidFeeCents: 700, refundCents: 14_750 },
    { cashCents: 0, paidFeeCents: 500, refundCents: 14_750 },
  ])("excludes the netted fee and $cashCents cents cash from the 50% refund basis", async ({ cashCents, paidFeeCents, refundCents }) => {
    const booking = joinerBooking(true);
    booking.finalPriceCents = 29_500;
    booking.payment.amountCents = 30_000 + cashCents;
    booking.payment.changeFeeCents = 1_000;
    mocks.bookingFindUnique.mockResolvedValue(booking);
    mocks.modifications.mockResolvedValue([{ id: "increase", priceDiffCents: -500, changeFeeCents: 1_000 }]);
    mocks.extraLinks.mockResolvedValue([{ localId: "increase", xeroObjectId: "extra", metadata: { organiserBilling: true, priceDiffCents: -500, changeFeeCents: 1_000 } }]);
    mocks.receipts.mockResolvedValue([{ xeroInvoiceId: "extra", amountCents: cashCents }]);

    const { status, body } = await preview();

    expect(status).toBe(200);
    // The final-price cap masks the old formula in refundAmountCents; pin the excluded fee too.
    expect(body.changeFeeCents).toBe(paidFeeCents);
    expect(body).toMatchObject({ refundMethodForced: "organiser_by_hand", refundAmountCents: refundCents, refundPercentage: 50 });
  });
});
