import { describe, expect, it, vi } from "vitest";

/**
 * #5066 slice 2: the generated document is built from the booking page's own
 * read — its figures from `bookingInvoiceSummary` over the one amount-owed
 * read, its date the club's today, its bill-to the booking's owner.
 */
vi.mock("server-only", () => ({}));

import { renderGeneratedBookingInvoice } from "../_lib/booking-invoice-generated";
import { requireCalendarDate } from "@/lib/club-time";

const night = (iso: string, priceCents: number) => ({ stayDate: new Date(`${iso}T00:00:00.000Z`), priceCents });

function booking(overrides: Record<string, unknown> = {}) {
  return {
    id: "ckbooking1234567",
    status: "AWAITING_REVIEW",
    memberId: null,
    member: null,
    organisationId: "org-1",
    organisation: { name: "Hilltop School", email: null },
    checkIn: new Date("2026-08-03T00:00:00.000Z"),
    checkOut: new Date("2026-08-05T00:00:00.000Z"),
    finalPriceCents: 18_000,
    promoAdjustmentCents: -2_000,
    promoRedemptions: [{ id: "r1", applicationOrder: 0, priceAdjustmentCents: -2_000, promoCode: { code: "SCHOOL" } }],
    lodge: { name: "Summit Lodge" },
    guests: [
      {
        firstName: "Tama",
        lastName: "Teacher",
        ageTier: "ADULT",
        isMember: false,
        rateMembershipTypeId: null,
        priceCents: 20_000,
        nights: [night("2026-08-03", 10_000), night("2026-08-04", 10_000)],
      },
    ],
    payment: { status: "PENDING", changeFeeCents: 0, amountCents: 0, refundedAmountCents: 0, transactions: [] },
    manualRefundTasks: [],
    ...overrides,
  } as never;
}

const dependencies = (appliedCreditCents: number) => ({
  supplier: vi.fn(async () => ({ name: "Alpine Sports Club Incorporated", addressLines: ["PO Box 7"] })),
  format: vi.fn(async () => ({ currencyCode: "NZD", locale: "en-NZ" })),
  clubTime: vi.fn(async () => ({ today: () => requireCalendarDate("2026-07-01") }) as never),
  ageTierSettings: vi.fn(async () => [{ tier: "ADULT", label: "Adult" }] as never),
  rateMembershipLabelResolver: vi.fn(async () => ({ nonMemberTypeId: null })),
  amountOwed: vi.fn(async () => ({ owedCents: 18_000 - appliedCreditCents, dueCents: 18_000 - appliedCreditCents, appliedCreditCents })),
});

describe("renderGeneratedBookingInvoice", () => {
  it("builds the document from the booking, its owner, the club's today and the amount-owed read", async () => {
    const deps = dependencies(3_000);
    const { body, data, balanceCents } = await renderGeneratedBookingInvoice(booking(), { notYetApproved: true }, deps);
    expect(body.toString("latin1").startsWith("%PDF-")).toBe(true);
    expect(deps.amountOwed).toHaveBeenCalledTimes(1);
    expect(data).toMatchObject({
      title: "Invoice",
      billTo: "Hilltop School",
      placeOfStay: "Summit Lodge",
      documentDate: "1 Jul 2026",
      notYetApproved: true,
      totalCents: 18_000,
    });
    expect(data.lines.map((line) => line.amountCents)).toEqual([20_000, -2_000]);
    expect(data.accountRows).toEqual([
      { label: "Account credit applied", cents: 3_000, emphasis: false },
      { label: "Paid, less refunds and credits returned", cents: 0, emphasis: false },
      { label: "Due once reviewed", cents: 15_000, emphasis: true },
    ]);
    expect(balanceCents).toBe(15_000);
  });

  it("bills an organiser-pays organiser's own guests only, never the places the group settlement pays for", async () => {
    const joinerBooking = {
      status: "CONFIRMED",
      organiserSettled: true,
      finalPriceCents: 50_000,
      guests: [{ id: "joiner-guest", priceCents: 50_000 }],
    };
    const organiser = booking({
      status: "CONFIRMED",
      groupBookingAsOrganiser: {
        id: "group-1",
        paymentMode: "ORGANISER_PAYS",
        settlement: { id: "settlement-1", status: "SUCCEEDED", amountCents: 50_000 },
        joins: [{ id: "join-1", booking: joinerBooking }],
      },
    });
    const { data } = await renderGeneratedBookingInvoice(organiser, { notYetApproved: false }, dependencies(0));
    expect(data.lines.filter((line) => line.kind === "GUEST").map((line) => line.guest)).toEqual(["Tama Teacher"]);
    expect(data.totalCents).toBe(18_000);
    expect(data.lines.reduce((sum, line) => sum + line.amountCents, 0)).toBe(18_000);
  });
});
