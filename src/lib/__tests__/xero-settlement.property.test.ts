import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { classifyXeroBookingEditSettlement } from "@/lib/xero-booking-edit-settlement";
import { buildInvoiceLineItems } from "@/lib/xero-booking-invoices";
import { lineTotalCents } from "@/lib/__tests__/helpers";

/**
 * Property-based tests (fast-check) for the Xero-side settlement money math
 * (issue #1131, epic #1125): the booking-edit settlement classifier must route
 * every possible delta to exactly one financial action whose integer-cent
 * amounts reconcile to the delta's net (#1356: supplementary-invoice
 * components stay signed and sum to the net; credit-note amounts stay
 * positive), and invoice line items must reconcile back to the cent ledger
 * they were built from.
 */

const classifyInputArb = fc.record({
  hasIssuedXeroInvoice: fc.boolean(),
  originalPaymentStatus: fc.constantFrom(
    "SUCCEEDED",
    "PARTIALLY_REFUNDED",
    "REFUNDED",
    "PENDING",
    "PROCESSING",
    "FAILED",
    null,
    undefined
  ),
  priceDiffCents: fc.integer({ min: -200_000, max: 200_000 }),
  changeFeeCents: fc.option(fc.integer({ min: 0, max: 50_000 }), {
    nil: undefined,
  }),
  datesChanged: fc.boolean(),
  guestIdentityChanged: fc.boolean(),
  createPrimaryInvoiceWhenMissing: fc.boolean(),
  requiresAdditionalStripePayment: fc.boolean(),
  additionalPaymentIntentId: fc.option(fc.constant("pi_test_123"), {
    nil: null,
  }),
  settlementMethod: fc.constantFrom("card", "credit", null) as fc.Arbitrary<
    "card" | "credit" | null
  >,
  settlementAmountCents: fc.option(fc.integer({ min: 0, max: 200_000 }), {
    nil: null,
  }),
  // #3993: whether the reduction went back through Stripe picks the document.
  refundedThroughStripe: fc.option(fc.boolean(), { nil: undefined }),
});

describe("classifyXeroBookingEditSettlement properties", () => {
  it("routes every delta to exactly one action whose amounts match the delta's sign", () => {
    fc.assert(
      fc.property(classifyInputArb, (input) => {
        const decision = classifyXeroBookingEditSettlement(input);
        const changeFee = input.changeFeeCents ?? 0;
        const expectedNet = input.hasIssuedXeroInvoice
          ? input.priceDiffCents + changeFee
          : 0;

        expect(decision.xeroNetAmountCents).toBe(expectedNet);

        if (!input.hasIssuedXeroInvoice) {
          expect(["primary-invoice", "none"]).toContain(
            decision.financialAction.type
          );
          expect(decision.financialAction.type).toBe(
            input.createPrimaryInvoiceWhenMissing ? "primary-invoice" : "none"
          );
          return;
        }

        if (expectedNet > 0) {
          expect(decision.financialAction.type).toBe("supplementary-invoice");
          if (decision.financialAction.type === "supplementary-invoice") {
            // #1356: the components pass through SIGNED — a mixed-sign edit
            // (negative price diff, larger fee) must keep its reduction so the
            // invoice components always sum to the net the member is charged.
            expect(decision.financialAction.priceDiffCents).toBe(
              input.priceDiffCents
            );
            expect(decision.financialAction.changeFeeCents).toBe(changeFee);
            expect(
              decision.financialAction.priceDiffCents +
                decision.financialAction.changeFeeCents
            ).toBe(expectedNet);
            // A payment is recorded only when a confirmed additional Stripe
            // intent exists to wait for.
            if (decision.financialAction.recordPayment) {
              expect(decision.financialAction.waitForPaymentIntentId).not.toBeNull();
              expect(input.requiresAdditionalStripePayment).toBe(true);
            }
          }
        } else if (expectedNet < 0) {
          const refund =
            input.settlementAmountCents ?? Math.abs(expectedNet);
          if (refund <= 0) {
            expect(decision.financialAction.type).toBe("none");
          } else if (input.settlementMethod === "credit") {
            expect(decision.financialAction.type).toBe(
              "modification-account-credit-note"
            );
            if (
              decision.financialAction.type === "modification-account-credit-note"
            ) {
              expect(decision.financialAction.refundAmountCents).toBe(refund);
              expect(decision.financialAction.refundAmountCents).toBeGreaterThan(0);
            }
          } else if (input.refundedThroughStripe === false) {
            // Not a Stripe refund (a bank hand-back or an invoice correction):
            // the modification note against the invoice.
            expect(decision.financialAction.type).toBe("modification-credit-note");
            if (decision.financialAction.type === "modification-credit-note") {
              expect(decision.financialAction.refundAmountCents).toBe(refund);
              expect(decision.financialAction.refundAmountCents).toBeGreaterThan(0);
            }
          } else {
            // #3993: a card refund is the payment's refund note, which the
            // card-paid invoice never has to take.
            expect(decision.financialAction.type).toBe("refund-credit-note");
            if (decision.financialAction.type === "refund-credit-note") {
              expect(decision.financialAction.refundAmountCents).toBe(refund);
              expect(decision.financialAction.refundAmountCents).toBeGreaterThan(0);
            }
          }
        } else {
          expect(decision.financialAction.type).toBe("none");
        }
      })
    );
  });

  it("never queues a primary-invoice update over locally captured or refunded money", () => {
    fc.assert(
      fc.property(classifyInputArb, (input) => {
        const decision = classifyXeroBookingEditSettlement(input);
        const narrationChanged =
          Boolean(input.datesChanged) || Boolean(input.guestIdentityChanged);
        const unsafe = ["SUCCEEDED", "PARTIALLY_REFUNDED", "REFUNDED"].includes(
          input.originalPaymentStatus ?? ""
        );

        if (!input.hasIssuedXeroInvoice || !narrationChanged) {
          expect(decision.primaryInvoiceUpdateAction.type).toBe("none");
        } else if (unsafe) {
          expect(decision.primaryInvoiceUpdateAction.type).toBe("skip");
        } else {
          expect(decision.primaryInvoiceUpdateAction.type).toBe("queue");
        }
      })
    );
  });
});

describe("buildInvoiceLineItems properties", () => {
  /**
   * Guests whose night rows are uniformly priced (per guest). Nights may be
   * non-contiguous, exercising the run-splitting logic; each resulting run is
   * still uniformly priced, so line totals must reconcile exactly.
   */
  const uniformGuestArb = fc.record({
    perNightCents: fc.integer({ min: 0, max: 20_000 }),
    // Day offsets inside one month; duplicates removed below.
    dayOffsets: fc.uniqueArray(fc.integer({ min: 0, max: 27 }), {
      minLength: 1,
      maxLength: 10,
    }),
    isMember: fc.boolean(),
  });

  it("uniformly-priced night sets reconcile exactly to the cent ledger", () => {
    fc.assert(
      fc.property(
        fc.array(uniformGuestArb, { minLength: 1, maxLength: 5 }),
        (rawGuests) => {
          const checkIn = new Date(2026, 5, 1);
          const checkOut = new Date(2026, 5, 29);
          const guests = rawGuests.map((raw, i) => {
            const nights = raw.dayOffsets
              .sort((a, b) => a - b)
              .map((offset) => ({
                stayDate: new Date(2026, 5, 1 + offset),
                priceCents: raw.perNightCents,
              }));
            return {
              firstName: `Guest${i}`,
              lastName: "Test",
              ageTier: "ADULT",
              isMember: raw.isMember,
              priceCents: nights.reduce((s, n) => s + n.priceCents, 0),
              nights,
            };
          });

          const lines = buildInvoiceLineItems(guests, checkIn, checkOut, 28);
          const expectedTotal = guests.reduce((s, g) => s + g.priceCents, 0);
          expect(lineTotalCents(lines)).toBe(expectedTotal);
          for (const line of lines) {
            expect(line.quantity ?? 0).toBeGreaterThanOrEqual(1);
            expect(line.unitAmount ?? 0).toBeGreaterThanOrEqual(0);
          }
        }
      )
    );
  });

  // Regression for #1163: a contiguous run with MIXED nightly prices used to
  // bill quantity x round(total/nights), which cannot represent the exact
  // total. The price-run splitter now emits one line per price block, so the
  // lines reconcile exactly.
  it("mixed-price contiguous runs reconcile exactly (#1163)", () => {
    const checkIn = new Date(2026, 5, 1);
    const checkOut = new Date(2026, 5, 4);
    const guests = [
      {
        firstName: "Mixed",
        lastName: "Rates",
        ageTier: "ADULT",
        isMember: true,
        priceCents: 8_000,
        nights: [
          { stayDate: new Date(2026, 5, 1), priceCents: 2_500 },
          { stayDate: new Date(2026, 5, 2), priceCents: 2_500 },
          { stayDate: new Date(2026, 5, 3), priceCents: 3_000 },
        ],
      },
    ];

    const lines = buildInvoiceLineItems(guests, checkIn, checkOut, 3);
    const total = lines.reduce(
      (sum, line) =>
        sum + Math.round((line.quantity ?? 0) * (line.unitAmount ?? 0) * 100),
      0
    );
    expect(total).toBe(8_000);
  });

  // #1163: an arbitrary vector of per-night prices must reconcile exactly on
  // BOTH the per-night path (explicit night rows) and the legacy path (a flat
  // priceCents with no night rows, split evenly across the nights). This fails
  // on the pre-#1163 round(total/n)*n maths whenever the prices are mixed or
  // the total is indivisible.
  it("arbitrary per-night price vectors reconcile exactly (both paths, #1163)", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 20_000 }), {
          minLength: 1,
          maxLength: 10,
        }),
        fc.boolean(),
        (nightPricesCents, isMember) => {
          const checkIn = new Date(Date.UTC(2026, 5, 1));
          const nights = nightPricesCents.length;
          const checkOut = new Date(checkIn.getTime() + nights * 24 * 60 * 60 * 1000);
          const total = nightPricesCents.reduce((s, c) => s + c, 0);

          // Per-night path: contiguous dates carrying the exact per-night prices.
          const perNightLines = buildInvoiceLineItems(
            [
              {
                firstName: "PerNight",
                lastName: "Test",
                ageTier: "ADULT",
                isMember,
                priceCents: total,
                nights: nightPricesCents.map((priceCents, i) => ({
                  stayDate: new Date(checkIn.getTime() + i * 24 * 60 * 60 * 1000),
                  priceCents,
                })),
              },
            ],
            checkIn,
            checkOut,
            nights
          );
          expect(lineTotalCents(perNightLines)).toBe(total);

          // Legacy path: no per-night rows, one flat priceCents split evenly.
          const legacyLines = buildInvoiceLineItems(
            [
              {
                firstName: "Legacy",
                lastName: "Test",
                ageTier: "ADULT",
                isMember,
                priceCents: total,
                nights: null,
              },
            ],
            checkIn,
            checkOut,
            nights
          );
          expect(lineTotalCents(legacyLines)).toBe(total);

          for (const line of [...perNightLines, ...legacyLines]) {
            expect(line.quantity ?? 0).toBeGreaterThanOrEqual(1);
            expect(line.unitAmount ?? 0).toBeGreaterThanOrEqual(0);
          }
        }
      )
    );
  });
});
