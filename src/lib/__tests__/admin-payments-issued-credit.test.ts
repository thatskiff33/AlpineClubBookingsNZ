import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #3791 (F4): the payments list's settlement figures - its sort and its
 * settlement kind - read the credit ISSUED from a booking. A review's give-back
 * of applied credit names the booking as its source too, so both queries the
 * list makes ask for the issued credit types only, as the figures meant before.
 */

const mocks = vi.hoisted(() => ({
  paymentFindMany: vi.fn(),
  xeroSyncOperationFindMany: vi.fn(),
  xeroObjectLinkFindMany: vi.fn(),
  clubTimeSettingsFindUnique: vi.fn(),
  // #3372: the list reads Refunds owed / Credits owed beside its other reads.
  manualRefundTaskFindMany: vi.fn(),
  paymentRecoveryOperationFindMany: vi.fn(),
  memberCreditGroupBy: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    payment: { findMany: mocks.paymentFindMany },
    xeroSyncOperation: { findMany: mocks.xeroSyncOperationFindMany },
    xeroObjectLink: { findMany: mocks.xeroObjectLinkFindMany },
    clubTimeSettings: { findUnique: mocks.clubTimeSettingsFindUnique },
    manualRefundTask: { findMany: mocks.manualRefundTaskFindMany },
    paymentRecoveryOperation: { findMany: mocks.paymentRecoveryOperationFindMany },
    memberCredit: { groupBy: mocks.memberCreditGroupBy },
  },
}));
vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { adminPaymentsQuerySchema, listAdminPayments } from "@/lib/admin-payments-service";
import { BOOKING_ISSUED_CREDIT_TYPES } from "@/lib/member-credit-booking-rows";

const row = {
  id: "pay-1",
  bookingId: "booking-1",
  amountCents: 1_000,
  source: "STRIPE",
  reference: null,
  status: "SUCCEEDED",
  stripePaymentIntentId: null,
  xeroInvoiceId: null,
  xeroInvoiceNumber: null,
  refundedAmountCents: 0,
  updatedAt: new Date("2026-06-15T00:00:00.000Z"),
  transactions: [],
  refunds: [],
  recoveryOperations: [],
  booking: {
    id: "booking-1",
    status: "CONFIRMED",
    checkIn: new Date("2026-08-01T00:00:00.000Z"),
    checkOut: new Date("2026-08-03T00:00:00.000Z"),
    creditsFromCancellation: [],
    member: { id: "member-1", firstName: "Ada", lastName: "Member", email: "ada@example.com" },
  },
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.manualRefundTaskFindMany.mockResolvedValue([]);
  mocks.paymentRecoveryOperationFindMany.mockResolvedValue([]);
  mocks.memberCreditGroupBy.mockResolvedValue([]);
  mocks.paymentFindMany.mockImplementation(async (args: { where?: { id?: { in?: string[] } } }) =>
    args?.where?.id?.in === undefined ? [row] : [row].filter((r) => args.where!.id!.in!.includes(r.id)),
  );
  mocks.xeroSyncOperationFindMany.mockResolvedValue([]);
  mocks.xeroObjectLinkFindMany.mockResolvedValue([]);
  mocks.clubTimeSettingsFindUnique.mockResolvedValue({ timeZone: "Pacific/Auckland" });
});

describe("the payments list reads credit issued from a booking, not credit given back", () => {
  it("MUTATION: asks every query for the issued credit types only", async () => {
    await listAdminPayments(adminPaymentsQuerySchema.parse({ sort: "settlement" }));

    expect(mocks.paymentFindMany).toHaveBeenCalledTimes(2);
    // The relation's `where`, wherever the query hangs the booking (`select` on
    // the candidate read, `include` on the page read). Its `select` is not
    // pinned: #3372 widened it for the Net Collected kept-credit reader, which
    // the filter costs nothing - a restore is always a `CANCELLATION_REFUND`.
    type BookingRelation = { select?: { creditsFromCancellation?: { where?: unknown } } };
    type FindManyArgs = { select?: { booking?: BookingRelation }; include?: { booking?: BookingRelation } };
    for (const [args] of mocks.paymentFindMany.mock.calls as Array<[FindManyArgs]>) {
      const booking = args.select?.booking ?? args.include?.booking;
      expect(booking?.select?.creditsFromCancellation?.where).toEqual({
        type: { in: [...BOOKING_ISSUED_CREDIT_TYPES] },
      });
    }
  });
});
