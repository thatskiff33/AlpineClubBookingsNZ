import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #3653 (#1491 parity): a joiner cancelling a booking the group organiser paid
 * for by card, BEHIND the organiser's cancellation of the group. That
 * cancellation already tiered this child and owes its refund to the
 * organiser's card, so the executed cancel returns nothing of its own and says
 * whose the refund is. The preview asks the same lookup
 * (`findGroupCancellationChildDebt`) and says the same sentence, so it can never
 * quote a refund the cancel will not make.
 */

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  requireActiveSessionUser: vi.fn(),
  bookingFindUnique: vi.fn(),
  recoveryFindUnique: vi.fn(),
  clubTimeSettingsFindUnique: vi.fn(),
  loadCancellationPolicy: vi.fn(),
  paymentEligibleForPaidCancelPath: vi.fn(),
  organiserChildCancelBasis: vi.fn(),
  checkRateLimit: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ auth: mocks.auth }));
vi.mock("@/lib/session-guards", () => ({
  requireActiveSessionUser: mocks.requireActiveSessionUser,
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    booking: { findUnique: mocks.bookingFindUnique },
    paymentRecoveryOperation: { findUnique: mocks.recoveryFindUnique },
    clubTimeSettings: { findUnique: mocks.clubTimeSettingsFindUnique },
    // #3809/#3836: the ledger's applied credit (none) and the give-back history (none).
    memberCredit: { aggregate: async () => ({ _sum: { amountCents: null } }) },
    bookingModification: { findMany: async () => [], findFirst: async () => null },
  },
}));
vi.mock("@/lib/cancellation", () => ({
  loadCancellationPolicy: mocks.loadCancellationPolicy,
}));
vi.mock("@/lib/booking-cancel", () => ({
  paymentEligibleForPaidCancelPath: mocks.paymentEligibleForPaidCancelPath,
}));
vi.mock("@/lib/organiser-child-refund", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/organiser-child-refund")),
  organiserChildCancelBasis: mocks.organiserChildCancelBasis,
}));
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
vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import { GET } from "@/app/api/bookings/[id]/cancel-preview/route";
import { groupCancellationRefundNote } from "@/lib/organiser-child-refund";
import { buildOrganiserChildCancellationRefundKey } from "@/lib/payment-recovery-keys";
import { CLUB_FORMAT_TEST } from "@/lib/__tests__/support/club-format-fixture";

// Half back at least 14 days out; the frozen clock is 1 July, check-in 1 August.
const POLICY = [
  { daysBeforeStay: 14, refundPercentage: 50, creditRefundPercentage: 50 },
  { daysBeforeStay: 0, refundPercentage: 0, creditRefundPercentage: 0 },
];

const SETTLEMENT = { id: "settlement-1", stripePaymentIntentId: "pi_combined", amountCents: 20_000 };

function joinerBooking() {
  return {
    id: "child-1",
    memberId: "member-1",
    lodgeId: "lodge-1",
    status: "PAID",
    organiserSettled: true,
    parentBookingId: "organiser-1",
    finalPriceCents: 10_000,
    checkIn: new Date("2026-08-01T00:00:00.000Z"),
    payment: {
      id: "payment-child-1",
      bookingId: "child-1",
      source: "STRIPE",
      status: "SUCCEEDED",
      manuallyMarkedPaidAt: null,
      amountCents: 10_000,
      refundedAmountCents: 0,
      changeFeeCents: 0,
      creditAppliedCents: 0,
    },
  };
}

async function preview() {
  const response = await GET(
    new Request("http://localhost/api/bookings/child-1/cancel-preview") as never,
    { params: Promise.resolve({ id: "child-1" }) },
  );
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.checkRateLimit.mockResolvedValue({ success: true, limit: 60, remaining: 59, resetAt: Date.now() + 60_000 });
  mocks.auth.mockResolvedValue({ user: { id: "member-1" } });
  mocks.requireActiveSessionUser.mockResolvedValue(null);
  mocks.bookingFindUnique.mockResolvedValue(joinerBooking());
  mocks.loadCancellationPolicy.mockResolvedValue(POLICY);
  mocks.paymentEligibleForPaidCancelPath.mockResolvedValue(true);
  mocks.clubTimeSettingsFindUnique.mockResolvedValue({
    timeZone: "Pacific/Auckland",
    updatedByMemberId: null,
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  });
  // The group's cancellation tiered half of this child's 10000 and owes 5000:
  // the base nets that debt out, leaving 5000 the policy would tier again.
  mocks.organiserChildCancelBasis.mockResolvedValue({ settlement: SETTLEMENT, committedRefundCents: 5_000 });
  mocks.recoveryFindUnique.mockResolvedValue(null);
});

describe("cancel preview for a joiner behind the organiser's cancellation of the group (#3653)", () => {
  it("quotes no refund of its own, with the cancel's sentence, once the group's cancellation owes this child's refund", async () => {
    mocks.recoveryFindUnique.mockImplementation(async ({ where }: { where: { idempotencyKey: string } }) =>
      where.idempotencyKey === buildOrganiserChildCancellationRefundKey(SETTLEMENT.id, "child-1")
        ? { id: "debt-group", amountCents: 5_000 }
        : null,
    );

    const { status, body } = await preview();

    expect(status).toBe(200);
    expect(body).toMatchObject({
      hasPayment: true,
      refundAmountCents: 0,
      refundPercentage: 0,
      creditRefundAmountCents: 0,
      creditRefundPercentage: 0,
      keptAmountCents: 5_000,
      groupCancellationRefundCents: 5_000,
      groupCancellationRefundNote: groupCancellationRefundNote(5_000, CLUB_FORMAT_TEST),
      refundMethodForced: "organiser_card",
    });
    expect(body.groupCancellationRefundNote).toContain("$50.00");
  });

  it("tiers the remainder as before when the group's cancellation owes nothing for this child", async () => {
    const { status, body } = await preview();

    expect(status).toBe(200);
    expect(body).toMatchObject({ refundAmountCents: 2_500, refundPercentage: 50 });
    expect(body).not.toHaveProperty("groupCancellationRefundNote");
  });
});
