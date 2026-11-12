import { beforeEach, describe, expect, it, vi } from "vitest";

const { readBookingAmountOwed } = vi.hoisted(() => ({
  readBookingAmountOwed: vi.fn(),
}));
vi.mock("@/lib/booking-amount-owed", () => ({ readBookingAmountOwed }));

import {
  isDashboardPaymentOwed,
  loadDashboardPaymentSnapshots,
  summarizeMemberPaymentOwed,
  type DashboardPaymentRow,
} from "../member-dashboard";

describe("summarizeMemberPaymentOwed", () => {
  it("adds outstanding initial and additional booking payments", () => {
    const summary = summarizeMemberPaymentOwed([
      {
        id: "booking-1",
        status: "CONFIRMED",
        amountDueCents: 12000,
        payment: null,
      },
      {
        id: "booking-2",
        status: "PAID",
        amountDueCents: 9000,
        payment: {
          status: "SUCCEEDED",
          additionalAmountCents: 3000,
          additionalPaymentStatus: "PENDING",
        },
      },
      {
        id: "booking-3",
        status: "CONFIRMED",
        amountDueCents: 8000,
        payment: {
          status: "PENDING",
          additionalAmountCents: 1000,
          additionalPaymentStatus: "PENDING",
        },
      },
    ]);

    expect(summary).toEqual({
      bookingCount: 3,
      totalCents: 24000,
    });
  });

  it("ignores bookings without any actionable amount due", () => {
    const summary = summarizeMemberPaymentOwed([
      {
        id: "booking-1",
        status: "PENDING",
        amountDueCents: 7000,
        payment: {
          status: "PENDING",
          additionalAmountCents: 0,
          additionalPaymentStatus: null,
        },
      },
      {
        id: "booking-2",
        status: "CONFIRMED",
        amountDueCents: 7000,
        payment: {
          status: "SUCCEEDED",
          additionalAmountCents: 0,
          additionalPaymentStatus: null,
        },
      },
      {
        id: "booking-3",
        status: "PAID",
        amountDueCents: 7000,
        payment: {
          status: "SUCCEEDED",
          additionalAmountCents: 2000,
          additionalPaymentStatus: "SUCCEEDED",
        },
      },
    ]);

    expect(summary).toEqual({
      bookingCount: 0,
      totalCents: 0,
    });
  });

  it("identifies the singular booking that should receive payment attention", () => {
    expect(
      isDashboardPaymentOwed({
        id: "booking-owed",
        status: "PAID",
        amountDueCents: 0,
        payment: {
          status: "SUCCEEDED",
          additionalAmountCents: 3500,
          additionalPaymentStatus: "PENDING",
        },
      }),
    ).toBe(true);

    expect(
      isDashboardPaymentOwed({
        id: "booking-settled",
        status: "PAID",
        amountDueCents: 0,
        payment: {
          status: "SUCCEEDED",
          additionalAmountCents: 3500,
          additionalPaymentStatus: "SUCCEEDED",
        },
      }),
    ).toBe(false);
  });

  it("does not treat zero-dollar unpaid bookings as payment-owed targets", () => {
    const booking = {
      id: "booking-zero",
      status: "CONFIRMED",
      amountDueCents: 0,
      payment: null,
    };

    expect(isDashboardPaymentOwed(booking)).toBe(false);
    expect(summarizeMemberPaymentOwed([booking])).toEqual({
      bookingCount: 0,
      totalCents: 0,
    });
  });
});

// #4944 (`INV-PAY-119`): the card quotes what the booking page's Amount due
// quotes - the one read's floored figure - not the bare price.
describe("loadDashboardPaymentSnapshots", () => {
  const unpaid = (overrides: Partial<DashboardPaymentRow> = {}): DashboardPaymentRow => ({
    id: "booking-1",
    status: "PAYMENT_PENDING",
    finalPriceCents: 30000,
    payment: null,
    ...overrides,
  });

  beforeEach(() => {
    readBookingAmountOwed.mockReset();
  });

  it("nets the credit applied to a $300 booking to $200", async () => {
    readBookingAmountOwed.mockResolvedValue({
      owedCents: 20000,
      dueCents: 20000,
      appliedCreditCents: 10000,
    });
    const row = unpaid();

    const snapshots = await loadDashboardPaymentSnapshots([row]);

    expect(readBookingAmountOwed).toHaveBeenCalledWith(row);
    expect(summarizeMemberPaymentOwed(snapshots)).toEqual({
      bookingCount: 1,
      totalCents: 20000,
    });
  });

  it("adds a change fee recorded on an unpaid payment", async () => {
    readBookingAmountOwed.mockResolvedValue({
      owedCents: 32500,
      dueCents: 32500,
      appliedCreditCents: 0,
    });
    const row = unpaid({
      status: "CONFIRMED",
      payment: {
        status: "PENDING",
        additionalAmountCents: 0,
        additionalPaymentStatus: null,
        changeFeeCents: 2500,
      },
    });

    const snapshots = await loadDashboardPaymentSnapshots([row]);

    expect(readBookingAmountOwed).toHaveBeenCalledWith(row);
    expect(summarizeMemberPaymentOwed(snapshots).totalCents).toBe(32500);
  });

  it("neither counts nor links a booking its credit covers, nor lets surplus credit lower another", async () => {
    readBookingAmountOwed.mockImplementation(async (booking: { id: string }) =>
      booking.id === "covered"
        ? { owedCents: -5000, dueCents: 0, appliedCreditCents: 35000 }
        : { owedCents: 10000, dueCents: 10000, appliedCreditCents: 0 },
    );

    const snapshots = await loadDashboardPaymentSnapshots([
      unpaid({ id: "covered" }),
      unpaid({ id: "owing", finalPriceCents: 10000 }),
    ]);

    expect(summarizeMemberPaymentOwed(snapshots)).toEqual({
      bookingCount: 1,
      totalCents: 10000,
    });
    expect(snapshots.filter(isDashboardPaymentOwed).map((s) => s.id)).toEqual(["owing"]);
    // Floored: a negative figure would cancel an additional ask on the same booking.
    expect(snapshots.map((s) => s.amountDueCents)).toEqual([0, 10000]);
  });

  it("still adds an outstanding additional ask on a paid booking, without reading its price", async () => {
    const snapshots = await loadDashboardPaymentSnapshots([
      unpaid({
        status: "PAID",
        payment: {
          status: "SUCCEEDED",
          additionalAmountCents: 4000,
          additionalPaymentStatus: "PENDING",
          changeFeeCents: null,
        },
      }),
    ]);

    expect(readBookingAmountOwed).not.toHaveBeenCalled();
    expect(summarizeMemberPaymentOwed(snapshots)).toEqual({
      bookingCount: 1,
      totalCents: 4000,
    });
  });

  it("adds nothing from the price once the payment has succeeded", async () => {
    const snapshots = await loadDashboardPaymentSnapshots([
      unpaid({
        status: "CONFIRMED",
        payment: {
          status: "SUCCEEDED",
          additionalAmountCents: 0,
          additionalPaymentStatus: null,
          changeFeeCents: null,
        },
      }),
    ]);

    expect(readBookingAmountOwed).not.toHaveBeenCalled();
    expect(summarizeMemberPaymentOwed(snapshots)).toEqual({
      bookingCount: 0,
      totalCents: 0,
    });
  });
});
