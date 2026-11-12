import { describe, expect, it } from "vitest";

import {
  buildGuestInvoiceLines,
  guestInvoiceLineAmountCents,
} from "@/lib/booking-guest-invoice-lines";
import {
  BookingInvoiceUnpricedNightError,
  bookingInvoiceFileName,
  buildBookingInvoiceData,
  canGenerateBookingInvoiceForStatus,
  type BookingInvoiceInput,
} from "@/lib/booking-invoice";
import { canDownloadBookingInvoice } from "@/lib/booking-invoice-access";
import { pdfSafeText, renderBookingInvoicePdf } from "@/lib/booking-invoice-pdf";
import { formatClubDate, requireCalendarDate } from "@/lib/club-time";

// Fork #115: the generated booking invoice — lines, totals, optional blocks,
// the PDF, and who may download it.

const FORMAT = { currencyCode: "NZD", locale: "en-NZ" };
const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

function guest(overrides: Partial<BookingInvoiceInput["guests"][number]> = {}) {
  return {
    firstName: "Aroha",
    lastName: "Smith",
    ageTier: "ADULT",
    isMember: true,
    rateMembershipTypeId: null,
    priceCents: 9000,
    nights: [
      { stayDate: day("2026-07-03"), priceCents: 3000 },
      { stayDate: day("2026-07-04"), priceCents: 3000 },
      { stayDate: day("2026-07-05"), priceCents: 3000 },
    ],
    ...overrides,
  };
}

function input(overrides: Partial<BookingInvoiceInput> = {}): BookingInvoiceInput {
  return {
    bookingId: "ckbooking1234567",
    checkIn: day("2026-07-03"),
    checkOut: day("2026-07-06"),
    finalPriceCents: 9000,
    changeFeeCents: 0,
    guests: [guest()],
    promoRedemptions: [],
    billToName: "Aroha Smith",
    lodge: {
      name: "Summit Lodge",
      address: "1 Mountain Road\nNational Park",
      postalAddress: null,
      bankAccountName: null,
      bankAccountDetails: null,
      gstNumber: null,
    },
    gstRegistered: true,
    amountPaidCents: 0,
    invoiceDate: formatClubDate(requireCalendarDate("2026-07-01"), FORMAT),
    format: FORMAT,
    ageTierLabels: new Map([["ADULT", "Adult"]]),
    rateMembershipLabelResolver: null,
    ...overrides,
  };
}

describe("buildGuestInvoiceLines (the shared per-guest builder)", () => {
  it("splits a stay at a price change and reconciles to the guest's price", () => {
    const lines = buildGuestInvoiceLines(
      [
        guest({
          priceCents: 10000,
          nights: [
            { stayDate: day("2026-07-03"), priceCents: 3000 },
            { stayDate: day("2026-07-04"), priceCents: 3000 },
            { stayDate: day("2026-07-05"), priceCents: 4000 },
          ],
        }),
      ],
      day("2026-07-03"),
      day("2026-07-06"),
      3,
    );
    expect(lines.map((line) => [line.run.nightCount, line.run.perNightCents])).toEqual([
      [2, 3000],
      [1, 4000],
    ]);
    expect(lines.reduce((sum, line) => sum + guestInvoiceLineAmountCents(line), 0)).toBe(10000);
    expect(lines.every((line) => !line.hasUnpricedNight)).toBe(true);
  });

  it("bills a partial stay only for the guest's own nights", () => {
    const [line] = buildGuestInvoiceLines(
      [guest({ priceCents: 3000, nights: [{ stayDate: day("2026-07-04"), priceCents: 3000 }] })],
      day("2026-07-03"),
      day("2026-07-06"),
      3,
    );
    expect(line!.run).toMatchObject({ nightCount: 1, perNightCents: 3000 });
    expect(line!.run.startDate).toEqual(day("2026-07-04"));
  });

  it("flags a guest holding an unpriced night and bills the stored total over the range", () => {
    const lines = buildGuestInvoiceLines(
      [
        guest({
          priceCents: 9001,
          nights: [
            { stayDate: day("2026-07-03"), priceCents: 3000 },
            { stayDate: day("2026-07-04"), priceCents: null },
          ],
        }),
      ],
      day("2026-07-03"),
      day("2026-07-06"),
      3,
    );
    expect(lines.every((line) => line.hasUnpricedNight)).toBe(true);
    expect(lines.reduce((sum, line) => sum + guestInvoiceLineAmountCents(line), 0)).toBe(9001);
  });
});

describe("buildBookingInvoiceData", () => {
  it("leaves the number blank, dates it today and totals the booking's final price", () => {
    const data = buildBookingInvoiceData(input());
    expect(data.invoiceNumber).toBeNull();
    expect(data.invoiceDate).toBe("1 Jul 2026");
    expect(data.stay).toMatchObject({ nights: 3, guests: 1 });
    expect(data.stay.checkIn).toContain("Friday");
    expect(data.stay.checkIn).toContain("3 July 2026");
    expect(data.lines).toEqual([
      {
        kind: "GUEST",
        guest: "Aroha Smith",
        category: "Adult · Member",
        nights: 3,
        ratePerNightCents: 3000,
        amountCents: 9000,
      },
    ]);
    expect(data.totalCents).toBe(9000);
    expect(data.subtotalCents).toBe(9000);
    expect(data.includesGst).toBe(true);
  });

  it("prints a promotion as its own line, so the total is the final price", () => {
    const data = buildBookingInvoiceData(
      input({
        finalPriceCents: 8000,
        promoRedemptions: [{ promoCode: { code: "WINTER10", internal: false } }],
      }),
    );
    expect(data.lines.at(-1)).toEqual({
      kind: "ADJUSTMENT",
      description: "Promo adjustment - WINTER10",
      amountCents: -1000,
    });
    expect(data.totalCents).toBe(8000);
    expect(data.subtotalCents).toBe(8000);
  });

  it("names a work party discount without printing its internal code", () => {
    const data = buildBookingInvoiceData(
      input({
        finalPriceCents: 4500,
        promoRedemptions: [
          { promoCode: { code: "WP-SECRET", internal: true, workPartyEvent: { name: "Spring working bee" } } },
        ],
      }),
    );
    const adjustment = data.lines.at(-1)!;
    expect(adjustment).toMatchObject({ description: "Working bee discount (Spring working bee)" });
    expect(JSON.stringify(data)).not.toContain("WP-SECRET");
  });

  it("adds a recorded change fee and includes it in the total", () => {
    const data = buildBookingInvoiceData(input({ changeFeeCents: 2500 }));
    expect(data.lines.at(-1)).toMatchObject({ kind: "FEE", amountCents: 2500 });
    expect(data.totalCents).toBe(11500);
  });

  it("shows amount paid and balance due only once a payment has arrived", () => {
    expect(buildBookingInvoiceData(input()).payments).toBeNull();
    expect(buildBookingInvoiceData(input({ amountPaidCents: 4000 })).payments).toEqual({
      amountPaidCents: 4000,
      balanceDueCents: 5000,
    });
    expect(
      buildBookingInvoiceData(input({ amountPaidCents: 9500 })).payments?.balanceDueCents,
    ).toBe(0);
  });

  it("uses the postal address when set, else the address, and the GST number only when set", () => {
    const plain = buildBookingInvoiceData(input());
    expect(plain.issuer.addressLines).toEqual(["1 Mountain Road", "National Park"]);
    expect(plain.issuer.contactLine).toBe("Booking Officer");
    expect(plain.issuer.gstNumber).toBeNull();

    const withPostal = buildBookingInvoiceData(
      input({ lodge: { ...input().lodge, postalAddress: "PO Box 9", gstNumber: "123-456-789" } }),
    );
    expect(withPostal.issuer.addressLines).toEqual(["PO Box 9"]);
    expect(withPostal.issuer.gstNumber).toBe("123-456-789");
  });

  it("shows the payment box only when bank details are set, with the booking's payment reference", () => {
    expect(buildBookingInvoiceData(input()).paymentDetails).toBeNull();
    const data = buildBookingInvoiceData(
      input({
        lodge: { ...input().lodge, bankAccountName: "Alpine Club Inc", bankAccountDetails: "12-3456-7890123-00" },
      }),
    );
    expect(data.paymentDetails).toEqual({
      accountName: "Alpine Club Inc",
      accountDetails: "12-3456-7890123-00",
      reference: "BOOKING-CKBOOKIN",
    });
  });

  it("drops the GST note for a club that is not GST-registered", () => {
    expect(buildBookingInvoiceData(input({ gstRegistered: false })).includesGst).toBe(false);
  });

  it("refuses a booking with a night still awaiting a price, rather than inventing a split", () => {
    expect(() =>
      buildBookingInvoiceData(
        input({ guests: [guest({ nights: [{ stayDate: day("2026-07-03"), priceCents: null }] })] }),
      ),
    ).toThrow(BookingInvoiceUnpricedNightError);
  });
});

describe("renderBookingInvoicePdf", () => {
  const pdfText = (buffer: Buffer) => buffer.toString("latin1");

  it("renders a PDF carrying the bill-to, totals and optional blocks", () => {
    const data = buildBookingInvoiceData(
      input({
        billToName: "Hilltop School",
        amountPaidCents: 4000,
        lodge: {
          ...input().lodge,
          bankAccountName: "Alpine Club Inc",
          bankAccountDetails: "12-3456-7890123-000",
          gstNumber: "123-456-789",
        },
      }),
    );
    const pdf = renderBookingInvoicePdf(data, FORMAT);
    const content = pdfText(pdf);
    expect(content.startsWith("%PDF-")).toBe(true);
    for (const expected of [
      "INVOICE",
      "Hilltop School",
      "Booking Officer",
      "GST Number: 123-456-789",
      "TOTAL \\(NZD\\)", // PDF strings escape brackets
      "Amount paid",
      "Balance due",
      "This amount includes GST",
      "Please pay by direct credit to",
      "Account number: 12-3456-7890123-000",
      "Thank you for your booking",
    ]) {
      expect(content).toContain(expected);
    }
  });

  it("leaves the optional blocks out when nothing is set and nothing is paid", () => {
    const content = pdfText(renderBookingInvoicePdf(buildBookingInvoiceData(input()), FORMAT));
    expect(content).not.toContain("Amount paid");
    expect(content).not.toContain("Please pay by direct credit to");
    expect(content).not.toContain("GST Number");
  });

  it("repeats the table header on every page of a long guest list", () => {
    const guests = Array.from({ length: 45 }, (_, i) => guest({ firstName: `Guest${i}` }));
    const data = buildBookingInvoiceData(input({ guests, finalPriceCents: 45 * 9000 }));
    const content = pdfText(renderBookingInvoicePdf(data, FORMAT));
    const pages = (content.match(/\/Type \/Page\b/g) ?? []).length;
    expect(pages).toBeGreaterThan(1);
    expect((content.match(/\(Rate \/ night\)/g) ?? []).length).toBe(pages);
  });

  it("wraps long names and bank details instead of letting them overlap", () => {
    const long = "A very long guest name that will certainly not fit in its column";
    const data = buildBookingInvoiceData(
      input({
        guests: [guest({ firstName: long }), guest()],
        finalPriceCents: 18000,
        lodge: {
          ...input().lodge,
          bankAccountName: `Alpine Club Incorporated ${"trading as the Mountain Lodge Trust ".repeat(3)}`,
          bankAccountDetails: "12-3456-7890123-00",
        },
      }),
    );
    const content = pdfText(renderBookingInvoicePdf(data, FORMAT));
    // The wrapped name is drawn as more than one text run, each its own line.
    expect(content).not.toContain(`(${long} Smith)`);
    expect(content).toContain("Please pay by direct credit to");
  });

  it("folds letters outside the PDF font to their base letter", () => {
    expect(pdfSafeText("Māui Ōtaki")).toBe("Maui Otaki");
    expect(pdfSafeText("José • Zoë")).toBe("José • Zoë");
  });
});

describe("bookingInvoiceFileName", () => {
  it("uses Xero's number when there is one, else the booking's short reference", () => {
    expect(bookingInvoiceFileName("ckbooking1234567", "INV-0042")).toBe("Invoice-INV-0042.pdf");
    expect(bookingInvoiceFileName("ckbooking1234567", null)).toBe("Invoice-CKBOOKIN.pdf");
  });
});

describe("canDownloadBookingInvoice", () => {
  const live = { deletedAt: null };
  const viewer = (overrides: Partial<{ isAdmin: boolean; canManageBooking: boolean; canViewAsAdmin: boolean }>) => ({
    isAdmin: false,
    canManageBooking: false,
    canViewAsAdmin: false,
    ...overrides,
  });

  it("allows the booking's manager and admin viewers, and nobody else", () => {
    expect(canDownloadBookingInvoice(viewer({ canManageBooking: true }), live)).toBe(true);
    expect(canDownloadBookingInvoice(viewer({ canViewAsAdmin: true }), live)).toBe(true);
    // A linked guest viewer neither manages the booking nor views it as an admin.
    expect(canDownloadBookingInvoice(viewer({}), live)).toBe(false);
  });

  it("keeps a deleted booking admin-only", () => {
    const deleted = { deletedAt: new Date("2026-07-01T00:00:00.000Z") };
    expect(canDownloadBookingInvoice(viewer({ canManageBooking: true }), deleted)).toBe(false);
    expect(canDownloadBookingInvoice(viewer({ isAdmin: true, canManageBooking: true }), deleted)).toBe(true);
  });
});

describe("canGenerateBookingInvoiceForStatus", () => {
  it("generates for owed, paid and awaiting-approval bookings only", () => {
    for (const status of ["PAYMENT_PENDING", "CONFIRMED", "PAID", "COMPLETED", "AWAITING_REVIEW"]) {
      expect(canGenerateBookingInvoiceForStatus(status), status).toBe(true);
    }
    for (const status of ["CANCELLED", "DRAFT", "WAITLISTED", "WAITLIST_OFFERED"]) {
      expect(canGenerateBookingInvoiceForStatus(status), status).toBe(false);
    }
  });
});
