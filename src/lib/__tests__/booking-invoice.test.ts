import { describe, expect, it } from "vitest";

import { buildGuestInvoiceLines, guestInvoiceLineAmountCents } from "@/lib/booking-guest-invoice-lines";
import {
  BOOKING_INVOICE_NOT_YET_APPROVED,
  BookingInvoiceNotAvailableError,
  buildBookingInvoiceData,
  planBookingInvoiceLines,
  type BookingInvoiceInput,
} from "@/lib/booking-invoice";
import { generatedBookingInvoiceOnOffer, primaryXeroInvoiceOnOffer } from "@/lib/booking-invoice-access";
import { pdfMoney, pdfSafeText, renderBookingInvoicePdf } from "@/lib/booking-invoice-pdf";
import type { BookingInvoiceSummary } from "@/lib/booking-invoice-summary";
import { resolveClubInvoiceSupplier } from "@/lib/club-invoice-supplier";
import { formatClubDate, requireCalendarDate } from "@/lib/club-time";
import { postalAddressLines, storedPostalAddress } from "@/lib/postal-address-lines";

/**
 * #5066 slice 2: the app's own booking invoice, made only while the club's Xero
 * module is off — its lines, figures, words and who is offered it (owner
 * decisions of 15 Nov 2026).
 */
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

function summary(overrides: Partial<BookingInvoiceSummary> = {}): BookingInvoiceSummary {
  return {
    totalCents: 9000,
    changeFeeCents: 0,
    creditAppliedCents: 0,
    paidCents: 0,
    keptCents: 0,
    balanceCents: 9000,
    balanceWhen: "NOW",
    ...overrides,
  };
}

function input(overrides: Partial<BookingInvoiceInput> = {}): BookingInvoiceInput {
  return {
    bookingId: "ckbooking1234567",
    checkIn: day("2026-07-03"),
    checkOut: day("2026-07-06"),
    finalPriceCents: 9000,
    promoAdjustmentCents: 0,
    guests: [guest()],
    promoRedemptions: [],
    billToName: "Aroha Smith",
    supplier: { name: "Alpine Sports Club Incorporated", addressLines: ["PO Box 7", "Ohakune 4625"] },
    lodgeName: "Summit Lodge",
    summary: summary(),
    notYetApproved: false,
    documentDate: formatClubDate(requireCalendarDate("2026-07-01"), FORMAT),
    format: FORMAT,
    ageTierLabels: new Map([["ADULT", "Adult"]]),
    rateMembershipLabelResolver: null,
    ...overrides,
  };
}

const redemption = (id: string, order: number, code: string, cents: number, extra: Record<string, unknown> = {}) => ({
  id,
  applicationOrder: order,
  priceAdjustmentCents: cents,
  promoCode: { code, ...extra },
});

describe("planBookingInvoiceLines: the lines, or why there are none", () => {
  it("cuts each guest's stay with the shared run builder the Xero invoice uses", () => {
    const priced = guest({
      priceCents: 10000,
      nights: [
        { stayDate: day("2026-07-03"), priceCents: 3000 },
        { stayDate: day("2026-07-04"), priceCents: 3000 },
        { stayDate: day("2026-07-05"), priceCents: 4000 },
      ],
    });
    const plan = planBookingInvoiceLines({ ...input(), guests: [priced], finalPriceCents: 10000 });
    expect(plan.kind).toBe("LINES");
    if (plan.kind !== "LINES") return;
    const shared = buildGuestInvoiceLines([priced], day("2026-07-03"), day("2026-07-06"), 3);
    expect(plan.guestRuns.map((line) => line.run)).toEqual(shared.map((line) => line.run));
    expect(plan.guestRuns.map(guestInvoiceLineAmountCents)).toEqual([6000, 4000]);
  });

  it("refuses a booking holding a night whose price is not known (#3170)", () => {
    const unpriced = guest({ nights: [{ stayDate: day("2026-07-03"), priceCents: 3000 }, { stayDate: day("2026-07-04"), priceCents: null }] });
    expect(planBookingInvoiceLines({ ...input(), guests: [unpriced] })).toEqual({ kind: "UNPRICED_NIGHT" });
  });

  it("refuses lines that do not come to the booking's price, rather than printing a balancing line", () => {
    expect(planBookingInvoiceLines({ ...input(), finalPriceCents: 8500 })).toEqual({ kind: "LINES_DO_NOT_ADD_UP" });
  });

  it("prints one line per promo code, in the booker's order, at each code's own amount (INV-MONEY-040)", () => {
    const plan = planBookingInvoiceLines({
      ...input(),
      finalPriceCents: 7500,
      promoAdjustmentCents: -1500,
      promoRedemptions: [redemption("r2", 2, "SECOND", -500), redemption("r1", 1, "FIRST", -1000)],
    });
    expect(plan.kind === "LINES" && plan.promoLines).toEqual([
      { description: "Promo adjustment - FIRST", amountCents: -1000 },
      { description: "Promo adjustment - SECOND", amountCents: -500 },
    ]);
  });

  it("falls back to the page's one combined row, naming every code, when the codes do not add up", () => {
    const plan = planBookingInvoiceLines({
      ...input(),
      finalPriceCents: 7500,
      promoAdjustmentCents: -1500,
      promoRedemptions: [redemption("r1", 1, "FIRST", -1000), redemption("r2", 2, "SECOND", -100)],
    });
    expect(plan.kind === "LINES" && plan.promoLines).toEqual([
      { description: "Promo adjustment - FIRST, SECOND", amountCents: -1500 },
    ]);
  });

  it("names a single code, and a work party's discount by its work party, never its internal code", () => {
    const one = planBookingInvoiceLines({
      ...input(),
      finalPriceCents: 8000,
      promoAdjustmentCents: -1000,
      promoRedemptions: [redemption("r1", 1, "SKI10", -1000)],
    });
    expect(one.kind === "LINES" && one.promoLines).toEqual([{ description: "Promo adjustment - SKI10", amountCents: -1000 }]);
    const workParty = planBookingInvoiceLines({
      ...input(),
      finalPriceCents: 8000,
      promoAdjustmentCents: -1000,
      promoRedemptions: [redemption("r1", 1, "WP-INTERNAL-7", -1000, { internal: true, workPartyEvent: { name: "Spring working bee" } })],
    });
    expect(workParty.kind === "LINES" && workParty.promoLines).toEqual([
      { description: "Working bee discount (Spring working bee)", amountCents: -1000 },
    ]);
  });
});

describe("buildBookingInvoiceData: the document's words and figures", () => {
  it("is titled Invoice, from the club's legal name and address, with the lodge as the place of stay", () => {
    const data = buildBookingInvoiceData(input());
    expect(data.title).toBe("Invoice");
    expect(data.supplier).toEqual({ name: "Alpine Sports Club Incorporated", addressLines: ["PO Box 7", "Ohakune 4625"] });
    expect(data.placeOfStay).toBe("Summit Lodge");
    expect(data.bookingReference).toBe("CKBOOKIN");
    expect(data.stay).toMatchObject({ nights: 3, guests: 1 });
    expect(data.lines).toEqual([
      { kind: "GUEST", guest: "Aroha Smith", category: "Adult · Member", nights: 3, ratePerNightCents: 3000, amountCents: 9000 },
    ]);
  });

  it("bills the recorded change fee on its own line and totals the booking's worth", () => {
    const data = buildBookingInvoiceData(input({ summary: summary({ changeFeeCents: 2500, balanceCents: 11500 }) }));
    expect(data.lines.at(-1)).toEqual({ kind: "FEE", description: "Late notice booking change fee", amountCents: 2500 });
    expect(data.totalCents).toBe(11500);
  });

  it("shows account credit on its own line, then paid and the balance, from the summary the page shows", () => {
    const data = buildBookingInvoiceData(input({ summary: summary({ creditAppliedCents: 2000, paidCents: 4000, balanceCents: 3000 }) }));
    expect(data.accountRows).toEqual([
      { label: "Account credit applied", cents: 2000, emphasis: false },
      { label: "Paid, less refunds and credits returned", cents: 4000, emphasis: false },
      { label: "Still to pay", cents: 3000, emphasis: true },
    ]);
  });

  it("says when a balance falls due on a booking awaiting review", () => {
    const data = buildBookingInvoiceData(input({ notYetApproved: true, summary: summary({ balanceWhen: "AFTER_REVIEW" }) }));
    expect(data.notYetApproved).toBe(true);
    expect(data.accountRows.at(-1)).toEqual({ label: "Due once reviewed", cents: 9000, emphasis: true });
  });

  it("refuses rather than build from lines it cannot print", () => {
    expect(() => buildBookingInvoiceData(input({ finalPriceCents: 8000 }))).toThrow(BookingInvoiceNotAvailableError);
    expect(() => buildBookingInvoiceData(input({ summary: summary({ totalCents: 9100 }) }))).toThrow(BookingInvoiceNotAvailableError);
  });
});

describe("renderBookingInvoicePdf", () => {
  const pdfText = (buffer: Buffer) => buffer.toString("latin1");

  it("prints the title, supplier, place of stay, lines and the account rows, in the club's currency", () => {
    const data = buildBookingInvoiceData(
      input({ billToName: "Hilltop School", summary: summary({ creditAppliedCents: 2000, paidCents: 4000, balanceCents: 3000 }) }),
    );
    const content = pdfText(renderBookingInvoicePdf(data, FORMAT));
    expect(content.startsWith("%PDF-")).toBe(true);
    for (const expected of [
      "(Invoice)",
      "Alpine Sports Club Incorporated",
      "PO Box 7",
      "Ohakune 4625",
      "Place of stay: Summit Lodge",
      "Hilltop School",
      "Booking reference:",
      "Total \\(NZD\\)", // PDF strings escape brackets
      "Account credit applied",
      "Paid, less refunds and credits returned",
      "Still to pay",
      "Thank you for your booking",
    ]) {
      expect(content).toContain(expected);
    }
  });

  it("prints no GST wording, no invoice number, no issuer contact line and no payment box (owner decisions 2 and 4)", () => {
    const content = pdfText(renderBookingInvoicePdf(buildBookingInvoiceData(input()), FORMAT));
    expect(content).not.toMatch(/GST/i);
    expect(content).not.toMatch(/\btax\b/i);
    expect(content).not.toContain("Invoice number");
    expect(content).not.toContain("Booking Officer");
    expect(content).not.toMatch(/direct credit|Account number|bank/i);
    expect(content).not.toContain(BOOKING_INVOICE_NOT_YET_APPROVED.toUpperCase());
  });

  it("marks a booking awaiting review Not yet approved, prominently and in every page's footer", () => {
    const guests = Array.from({ length: 45 }, (_, i) => guest({ firstName: `Guest${i}` }));
    const data = buildBookingInvoiceData(
      input({ guests, finalPriceCents: 45 * 9000, notYetApproved: true, summary: summary({ totalCents: 45 * 9000 }) }),
    );
    const content = pdfText(renderBookingInvoicePdf(data, FORMAT));
    const pages = (content.match(/\/Type \/Page\b/g) ?? []).length;
    expect(pages).toBeGreaterThan(1);
    expect(content).toContain("NOT YET APPROVED");
    expect(content).toContain("nothing is payable until it does");
    expect((content.match(/Invoice . Not yet approved/g) ?? []).length).toBe(pages);
    // The table header repeats on every page too.
    expect((content.match(/\(Rate \/ night\)/g) ?? []).length).toBe(pages);
  });

  it("draws a negative amount in sv-SE with a hyphen-minus, never a ?", () => {
    const sv = { currencyCode: "EUR", locale: "sv-SE" };
    const amount = pdfMoney(-123_450, sv);
    expect(amount).not.toContain("?");
    expect(amount.startsWith("-")).toBe(true);
    expect(amount).toContain("€");
    for (const locale of ["nb-NO", "fi-FI"]) expect(pdfMoney(-100, { currencyCode: "EUR", locale })).not.toContain("?");
  });

  it("falls back to the currency code for a symbol Helvetica cannot draw", () => {
    expect(pdfMoney(123_450, { currencyCode: "PLN", locale: "pl-PL" })).toMatch(/PLN/);
    for (const [currencyCode, locale] of [["INR", "en-IN"], ["TRY", "tr-TR"], ["KRW", "ko-KR"], ["RUB", "ru-RU"]]) {
      const amount = pdfMoney(-123_450, { currencyCode: currencyCode!, locale: locale! });
      expect(amount).toContain(currencyCode);
      expect(amount).not.toContain("?");
    }
    // A drawable symbol is kept.
    expect(pdfMoney(123_450, FORMAT)).toBe("$1,234.50");
  });

  it("prints a PLN invoice with codes, and a sv-SE one with no ? anywhere in its amounts", () => {
    for (const format of [{ currencyCode: "PLN", locale: "pl-PL" }, { currencyCode: "EUR", locale: "sv-SE" }]) {
      const data = buildBookingInvoiceData(
        input({
          format,
          finalPriceCents: 8000,
          promoAdjustmentCents: -1000,
          promoRedemptions: [redemption("r1", 1, "SKI10", -1000)],
          summary: summary({ totalCents: 8000, balanceCents: 8000 }),
        }),
      );
      const content = pdfText(renderBookingInvoicePdf(data, format));
      // The negative promotion prints with a hyphen-minus, never a "?" (the
      // space before the symbol is drawn by its own PDF escape, so the digits are matched).
      expect(content).toContain("-10,00");
      expect(content).not.toContain("?10,00");
      expect(pdfMoney(-1000, format)).not.toContain("?");
      if (format.currencyCode === "PLN") expect(content).toContain("PLN");
    }
  });

  it("wraps a long address line within the supplier column", () => {
    const longLine = "Level 12, The Very Long Building Name, 123 Some Extremely Long Street Name Avenue, Ohakune";
    const data = buildBookingInvoiceData(input({ supplier: { name: "ASC", addressLines: [longLine] } }));
    const content = pdfText(renderBookingInvoicePdf(data, FORMAT));
    expect(content).not.toContain(longLine);
    expect(content).toContain("Level 12");
    expect(content).toContain("Ohakune");
  });

  it("shortens a long supplier name in the footer so it never reaches Page x of y, keeping the mark whole", () => {
    const name = "The Extraordinarily Long Incorporated Society Name Of An Alpine Sports And Mountaineering Club";
    const data = buildBookingInvoiceData(input({ supplier: { name, addressLines: [] }, notYetApproved: true }));
    const content = pdfText(renderBookingInvoicePdf(data, FORMAT));
    expect(content).toMatch(/\.\.\. . Invoice . Not yet approved/);
    expect(content).toContain("Page 1 of 1");
  });

  it("folds letters outside Latin-1 so a name prints instead of garbage", () => {
    expect(pdfSafeText("Ngāti Whātua")).toBe("Ngati Whatua");
    expect(pdfSafeText("Zoë")).toBe("Zoë");
  });
});

describe("resolveClubInvoiceSupplier and the address lines", () => {
  it("falls back to the club name, and prints no address while none is set", () => {
    expect(resolveClubInvoiceSupplier(null, "Alpine Sports Club")).toEqual({ name: "Alpine Sports Club", addressLines: [] });
    expect(resolveClubInvoiceSupplier({ legalName: "  ", postalAddress: null }, "Alpine Sports Club").name).toBe("Alpine Sports Club");
  });

  it("uses the legal name and one printed line per address line", () => {
    expect(resolveClubInvoiceSupplier({ legalName: " ASC Inc ", postalAddress: "PO Box 7\r\n\nOhakune" }, "ASC")).toEqual({
      name: "ASC Inc",
      addressLines: ["PO Box 7", "Ohakune"],
    });
    expect(postalAddressLines(" a \n\n b ")).toEqual(["a", "b"]);
    expect(storedPostalAddress(" \n ")).toBeNull();
  });
});

describe("generatedBookingInvoiceOnOffer: who is offered the app's document, and for which bookings", () => {
  const owner = { canSeeOwnerCredit: true, nonOwnerAdminViewer: false };
  const offerable = (overrides: Record<string, unknown> = {}) => ({
    ...input(),
    status: "CONFIRMED",
    organiserSettled: false,
    parentBookingId: null,
    payment: { source: "INTERNET_BANKING", xeroInvoiceId: null, xeroInvoiceNumber: null, transactions: [] as unknown[] },
    groupBookingAsOrganiser: null,
    ...overrides,
  });
  const offer = (booking = offerable(), xeroModuleOn = false, viewer = owner) =>
    generatedBookingInvoiceOnOffer({ viewer, booking, xeroModuleOn });

  it("offers it with the Xero module off, and never with it on (owner decision 1)", () => {
    expect(offer()).toEqual({ kind: "GENERATED", notYetApproved: false });
    expect(offer(offerable(), true)).toBeNull();
  });

  it("never offers both documents for one booking: with Xero on the Xero rule alone decides", () => {
    const withXeroInvoice = offerable({ payment: { source: "STRIPE", xeroInvoiceId: "x-1", xeroInvoiceNumber: "INV-1", transactions: [] } });
    expect(primaryXeroInvoiceOnOffer({ viewer: owner, booking: withXeroInvoice, xeroModuleOn: false })).toBeNull();
    expect(offer(withXeroInvoice, true)).toBeNull();
    // With Xero off, a booking holding a Xero invoice is pointed at the club, not given a second one.
    expect(offer(withXeroInvoice, false)).toMatchObject({ kind: "ASK_CLUB", reason: "XERO_DOCUMENTS" });
  });

  it("offers it only to the owner-credit audience", () => {
    expect(offer(offerable(), false, { canSeeOwnerCredit: false, nonOwnerAdminViewer: false })).toBeNull();
  });

  it("marks a booking awaiting review, and offers paid, completed and pending-payment bookings unmarked", () => {
    expect(offer(offerable({ status: "AWAITING_REVIEW" }))).toEqual({ kind: "GENERATED", notYetApproved: true });
    for (const status of ["PAYMENT_PENDING", "PAID", "COMPLETED"]) {
      expect(offer(offerable({ status }))).toEqual({ kind: "GENERATED", notYetApproved: false });
    }
  });

  it("offers nothing on a cancelled, bumped, draft, pending, waitlisted or offered booking", () => {
    for (const status of ["CANCELLED", "BUMPED", "DRAFT", "PENDING", "WAITLISTED", "WAITLIST_OFFERED"]) {
      expect(offer(offerable({ status }))).toBeNull();
    }
  });

  it("offers nothing on a place the organiser pays for, but does offer the organiser's own booking", () => {
    expect(offer(offerable({ organiserSettled: true, parentBookingId: "organiser-booking" }))).toBeNull();
    expect(offer(offerable({ groupBookingAsOrganiser: { paymentMode: "ORGANISER_PAYS" } }))).toEqual({ kind: "GENERATED", notYetApproved: false });
  });

  it("points a booking with an extra charge asked, or a Xero invoice from when Xero was on, at the club", () => {
    const payment = { source: "STRIPE", xeroInvoiceId: null, xeroInvoiceNumber: null, transactions: [{}] };
    expect(offer(offerable({ payment }))).toEqual({ kind: "ASK_CLUB", staffViewer: false, reason: "EXTRA_CHARGE" });
    expect(offer(offerable({ payment: { ...payment, transactions: [], xeroInvoiceId: "x-1" } }))).toEqual({
      kind: "ASK_CLUB",
      staffViewer: false,
      reason: "XERO_DOCUMENTS",
    });
    expect(offer(offerable({ payment }), false, { canSeeOwnerCredit: true, nonOwnerAdminViewer: true })).toMatchObject({ staffViewer: true });
  });

  it("offers nothing on a booking with an unpriced night, or lines that do not add up", () => {
    expect(offer(offerable({ guests: [guest({ nights: [{ stayDate: day("2026-07-03"), priceCents: null }] })] }))).toBeNull();
    expect(offer(offerable({ finalPriceCents: 1 }))).toBeNull();
  });
});
