import { beforeEach, describe, expect, it, vi } from "vitest";
import { CLUB_FORMAT_TEST } from "@/lib/__tests__/support/club-format-fixture";

/**
 * #4946: the booking page's cancellation schedule is the BOOKING'S lodge's.
 *
 * A two-lodge club whose lodges cancel differently. The page used to call the
 * loader without the lodge, so a booking at the second lodge showed the default
 * lodge's tiers while the cancel itself settled with the second lodge's. The
 * real loader runs here over a two-lodge fixture, so a call that drops the lodge
 * reads the default lodge's rows and this goes red.
 */
const mocks = vi.hoisted(() => ({
  cancellationFindMany: vi.fn(),
  bookingPeriodFindMany: vi.fn(),
  lodgeFindFirst: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    cancellationPolicy: { findMany: mocks.cancellationFindMany },
    bookingPeriod: { findMany: mocks.bookingPeriodFindMany },
    lodge: { findFirst: mocks.lodgeFindFirst },
  },
}));

import { loadBookingDetailCancellation } from "../_lib/booking-detail-cancellation";

const POLICY_ROWS = [
  // The default lodge: generous.
  { lodgeId: "lodge-default", daysBeforeStay: 14, refundPercentage: 100 },
  { lodgeId: "lodge-default", daysBeforeStay: 0, refundPercentage: 50 },
  // The second lodge: strict.
  { lodgeId: "lodge-b", daysBeforeStay: 30, refundPercentage: 100 },
  { lodgeId: "lodge-b", daysBeforeStay: 0, refundPercentage: 0 },
];

function load(options: { lodgeId: string; paid?: boolean; canCancel?: boolean }) {
  return loadBookingDetailCancellation({
    booking: { checkIn: new Date("2026-08-15"), lodgeId: options.lodgeId },
    access: { canCancel: options.canCancel ?? true, isDeleted: false },
    payment: { originalPaymentCaptured: options.paid ?? true },
    format: CLUB_FORMAT_TEST,
  });
}

describe("booking page cancellation schedule (#4946)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.bookingPeriodFindMany.mockResolvedValue([]);
    mocks.lodgeFindFirst.mockResolvedValue({ id: "lodge-default" });
    mocks.cancellationFindMany.mockImplementation(
      async ({ where }: { where: { OR: Array<{ lodgeId: string | null }> } }) => {
        const lodgeIds = where.OR.map((clause) => clause.lodgeId);
        return POLICY_ROWS.filter((row) => lodgeIds.includes(row.lodgeId));
      },
    );
  });

  it("shows a non-default lodge's booking that lodge's own rows", async () => {
    const result = await load({ lodgeId: "lodge-b" });

    expect(result.cancellationSchedule?.map((row) => row.description)).toEqual([
      "30+ days before stay: 100% refund",
      "Less than 30 days: 0% refund",
    ]);
    expect(mocks.lodgeFindFirst).not.toHaveBeenCalled();
  });

  it("CONTROL: the default lodge's booking shows the default lodge's rows", async () => {
    const result = await load({ lodgeId: "lodge-default" });

    expect(result.cancellationSchedule?.map((row) => row.description)).toEqual([
      "14+ days before stay: 100% refund",
      "Less than 14 days: 50% refund",
    ]);
  });

  it("shows no tiers for an unpaid cancellable booking, only the no-refund flag (PR #1389)", async () => {
    const result = await load({ lodgeId: "lodge-b", paid: false });

    expect(result).toEqual({
      cancellationSchedule: undefined,
      cancellationHasNoPayment: true,
    });
    expect(mocks.cancellationFindMany).not.toHaveBeenCalled();
  });

  it("says nothing about cancelling a booking that cannot be cancelled", async () => {
    const result = await load({ lodgeId: "lodge-b", canCancel: false });

    expect(result).toEqual({
      cancellationSchedule: undefined,
      cancellationHasNoPayment: false,
    });
  });
});
