import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { BookingStatus } from "@prisma/client";
import {
  ADMIN_ADJUSTMENT_IDEMPOTENCY_CONFLICT,
  assertMatchingIdempotentAdjustmentRequest,
  calculateAppliedCreditAmount,
  calculateAppliedCreditRestore,
  calculateBookingCreditApplication,
  calculateCancellationPreview,
  calculateChangeFee,
  calculateDualRefundAmounts,
  calculateRefundAmount,
  calculateRestoredCreditAmount,
  getRefundTier,
  validateCreditApplicationAgainstBalance,
  validateNegativeAdjustmentAgainstBalance,
  type CancellationRule,
} from "@/lib/policies";
import { normalizeCancellationRule } from "@/lib/cancellation-rules";
import {
  addCalendarDays,
  dateOnlyInstantOf,
  requireCalendarDate,
} from "@/lib/club-time";

/**
 * Property-based tests (fast-check) for the refund, change-fee, and
 * member-credit money math (issue #1131, epic #1125). Core invariants:
 * a refund plus the retained amount always equals what was paid, fees and
 * percentages can never produce negative cents, and credit application /
 * restoration conserve value exactly.
 */

const ruleArb: fc.Arbitrary<CancellationRule> = fc.record(
  {
    daysBeforeStay: fc.integer({ min: 0, max: 90 }),
    refundPercentage: fc.integer({ min: 0, max: 100 }),
    creditRefundPercentage: fc.integer({ min: 0, max: 100 }),
    fixedFeeCents: fc.integer({ min: 0, max: 10_000 }),
    creditFixedFeeCents: fc.integer({ min: 0, max: 10_000 }),
  },
  { requiredKeys: ["daysBeforeStay", "refundPercentage"] }
);

const rulesArb = fc.array(ruleArb, { minLength: 0, maxLength: 6 });
const daysArb = fc.integer({ min: -10, max: 120 });
const paidArb = fc.integer({ min: 0, max: 1_000_000 });

describe("getRefundTier properties", () => {
  it("selects the strictest applicable rule (largest daysBeforeStay <= days) or the zero tier", () => {
    fc.assert(
      fc.property(rulesArb, daysArb, (rules, days) => {
        const tier = getRefundTier(days, rules);
        const applicable = rules.filter((r) => days >= r.daysBeforeStay);

        if (rules.length === 0 || applicable.length === 0) {
          expect(tier).toEqual({
            refundPercentage: 0,
            creditRefundPercentage: 0,
            fixedFeeCents: 0,
            creditFixedFeeCents: 0,
            daysBeforeStay: 0,
          });
          return;
        }

        const maxDays = Math.max(...applicable.map((r) => r.daysBeforeStay));
        expect(tier.daysBeforeStay).toBe(maxDays);
        const candidates = applicable
          .filter((r) => r.daysBeforeStay === maxDays)
          .map(normalizeCancellationRule);
        expect(candidates).toContainEqual(tier);
      })
    );
  });
});

describe("calculateRefundAmount properties", () => {
  it("refund + retained always equals the paid amount, both non-negative", () => {
    fc.assert(
      fc.property(
        paidArb,
        daysArb,
        rulesArb,
        fc.constantFrom("card", "credit") as fc.Arbitrary<"card" | "credit">,
        (paid, days, rules, method) => {
          const { refundAmountCents } = calculateRefundAmount(
            paid,
            days,
            rules,
            method
          );
          const retained = paid - refundAmountCents;

          expect(Number.isInteger(refundAmountCents)).toBe(true);
          expect(refundAmountCents).toBeGreaterThanOrEqual(0);
          expect(refundAmountCents).toBeLessThanOrEqual(paid);
          expect(retained).toBeGreaterThanOrEqual(0);
          expect(refundAmountCents + retained).toBe(paid);
        }
      )
    );
  });

  it("a higher fixed fee never increases the refund", () => {
    fc.assert(
      fc.property(
        paidArb,
        daysArb,
        fc.integer({ min: 0, max: 100 }),
        fc.integer({ min: 0, max: 10_000 }),
        fc.integer({ min: 0, max: 10_000 }),
        (paid, days, pct, feeA, feeB) => {
          const [lowFee, highFee] = feeA <= feeB ? [feeA, feeB] : [feeB, feeA];
          const rule = (fee: number): CancellationRule => ({
            daysBeforeStay: 0,
            refundPercentage: pct,
            fixedFeeCents: fee,
          });
          const low = calculateRefundAmount(paid, days, [rule(lowFee)]);
          const high = calculateRefundAmount(paid, days, [rule(highFee)]);
          expect(high.refundAmountCents).toBeLessThanOrEqual(
            low.refundAmountCents
          );
        }
      )
    );
  });

  it("calculateDualRefundAmounts agrees with calculateRefundAmount per method", () => {
    fc.assert(
      fc.property(paidArb, daysArb, rulesArb, (paid, days, rules) => {
        const dual = calculateDualRefundAmounts(paid, days, rules);
        const card = calculateRefundAmount(paid, days, rules, "card");
        const credit = calculateRefundAmount(paid, days, rules, "credit");

        expect(dual.cardRefundAmountCents).toBe(card.refundAmountCents);
        expect(dual.cardRefundPercentage).toBe(card.refundPercentage);
        expect(dual.creditRefundAmountCents).toBe(credit.refundAmountCents);
        expect(dual.creditRefundPercentage).toBe(credit.refundPercentage);
      })
    );
  });
});

describe("calculateChangeFee properties", () => {
  it("is zero when moving to a same-or-stricter tier and never exceeds the booking price", () => {
    fc.assert(
      fc.property(daysArb, daysArb, paidArb, rulesArb, (from, to, price, rules) => {
        const result = calculateChangeFee({
          daysUntilOriginalCheckIn: from,
          daysUntilNewCheckIn: to,
          originalFinalPriceCents: price,
          policyRules: rules,
        });

        expect(Number.isInteger(result.feeCents)).toBe(true);
        expect(result.feeCents).toBeGreaterThanOrEqual(0);
        expect(result.feeCents).toBeLessThanOrEqual(price);
        if (result.toTierRefundPct <= result.fromTierRefundPct) {
          expect(result.feeCents).toBe(0);
        } else {
          expect(result.feeCents).toBe(
            Math.round(
              ((result.toTierRefundPct - result.fromTierRefundPct) / 100) * price
            )
          );
        }
      })
    );
  });

  it("charges nothing when the check-in distance is unchanged", () => {
    fc.assert(
      fc.property(daysArb, paidArb, rulesArb, (days, price, rules) => {
        const result = calculateChangeFee({
          daysUntilOriginalCheckIn: days,
          daysUntilNewCheckIn: days,
          originalFinalPriceCents: price,
          policyRules: rules,
        });
        expect(result.feeCents).toBe(0);
      })
    );
  });
});

describe("calculateBookingCreditApplication properties", () => {
  it("conserves value: applied credit + effective price equals the booking price", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -1_000, max: 100_000 }),
        fc.integer({ min: 0, max: 100_000 }),
        fc.integer({ min: 0, max: 100_000 }),
        fc.constantFrom(
          BookingStatus.PAYMENT_PENDING,
          BookingStatus.PENDING,
          BookingStatus.AWAITING_REVIEW
        ),
        (requested, balance, price, status) => {
          const call = () =>
            calculateBookingCreditApplication({
              requestedCreditCents: requested,
              creditBalanceCents: balance,
              finalPriceCents: price,
              status,
            });

          const inactive =
            requested <= 0 || status !== BookingStatus.PAYMENT_PENDING;
          if (inactive) {
            expect(call()).toEqual({
              creditAppliedCents: 0,
              effectivePriceCents: price,
            });
            return;
          }

          if (requested > balance || requested > price) {
            expect(call).toThrow();
            return;
          }

          const result = call();
          expect(result.creditAppliedCents).toBe(requested);
          expect(result.effectivePriceCents).toBeGreaterThanOrEqual(0);
          expect(result.creditAppliedCents + result.effectivePriceCents).toBe(
            price
          );
        }
      )
    );
  });
});

describe("calculateAppliedCreditRestore properties", () => {
  it("restores between 0 and the full applied credit for any policy (#1164)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 200_000 }),
        fc.integer({ min: 0, max: 500_000 }),
        fc.integer({ min: 0, max: 90 }),
        rulesArb,
        (creditApplied, cardBase, days, rules) => {
          const { creditRestoredCents } = calculateAppliedCreditRestore(
            creditApplied,
            cardBase,
            days,
            rules
          );
          expect(creditRestoredCents).toBeGreaterThanOrEqual(0);
          expect(creditRestoredCents).toBeLessThanOrEqual(creditApplied);
        }
      )
    );
  });
});

describe("calculateCancellationPreview properties", () => {
  it("never promises more than was paid and tiers restored credit within [0, applied]", () => {
    fc.assert(
      fc.property(
        fc.record({
          amountCents: fc.integer({ min: 0, max: 500_000 }),
          refundedAmountCents: fc.integer({ min: 0, max: 200_000 }),
          changeFeeCents: fc.integer({ min: 0, max: 50_000 }),
          creditAppliedCents: fc.option(fc.integer({ min: 0, max: 100_000 }), {
            nil: null,
          }),
        }),
        fc.integer({ min: 0, max: 500_000 }),
        fc.integer({ min: 0, max: 60 }),
        rulesArb,
        (payment, finalPriceCents, daysAhead, rules) => {
          fc.pre(payment.refundedAmountCents <= payment.amountCents);
          // #3123 — the club's day is a `CalendarDate` now, and the check-in is
          // built as the UTC-midnight `@db.Date` encoding it really is rather
          // than as `new Date(2026, 5, 1 + n)`, which was HOST-local midnight
          // and therefore a different day on either side of Greenwich.
          const todayAtClub = requireCalendarDate("2026-06-01");
          const checkIn = dateOnlyInstantOf(
            addCalendarDays(todayAtClub, daysAhead),
          );
          const preview = calculateCancellationPreview({
            payment,
            finalPriceCents,
            checkIn,
            policyRules: rules,
            todayAtClub,
          });

          const paid = payment.amountCents - payment.refundedAmountCents;
          expect(preview.totalPaidCents).toBe(paid);
          expect(preview.refundAmountCents).toBeGreaterThanOrEqual(0);
          expect(preview.refundAmountCents).toBeLessThanOrEqual(Math.max(paid, 0));
          expect(preview.refundAmountCents + preview.keptAmountCents).toBe(paid);
          expect(preview.creditRefundAmountCents).toBeGreaterThanOrEqual(0);
          // #1164: the applied-credit slice is now tiered (not the 100% mirror),
          // so the safe invariant is 0 <= restored <= creditApplied.
          const applied = payment.creditAppliedCents || 0;
          expect(preview.creditRestoredCents).toBeGreaterThanOrEqual(0);
          expect(preview.creditRestoredCents).toBeLessThanOrEqual(applied);
        }
      )
    );
  });
});

describe("member credit policy properties", () => {
  it("restoring applied credits returns exactly what was applied", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: 100_000 }), {
          minLength: 0,
          maxLength: 10,
        }),
        (amounts) => {
          const appliedEntries = amounts.map((amountCents) => ({
            amountCents: calculateAppliedCreditAmount(amountCents),
          }));
          for (const entry of appliedEntries) {
            expect(entry.amountCents).toBeLessThan(0);
          }
          const restored = calculateRestoredCreditAmount(appliedEntries);
          expect(restored).toBe(amounts.reduce((s, a) => s + a, 0));
          // Conservation: the ledger nets to zero after apply + restore.
          const net =
            appliedEntries.reduce((s, e) => s + e.amountCents, 0) + restored;
          expect(net).toBe(0);
        }
      )
    );
  });

  it("credit application validation rejects exactly the overdraw cases", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -1_000, max: 100_000 }),
        fc.integer({ min: 0, max: 100_000 }),
        (amount, balance) => {
          const call = () =>
            validateCreditApplicationAgainstBalance(amount, balance);
          if (amount <= 0 || balance < amount) {
            expect(call).toThrow();
          } else {
            expect(call).not.toThrow();
          }
        }
      )
    );
  });

  it("negative adjustments are rejected exactly when they would overdraw the balance", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -100_000, max: 100_000 }),
        fc.integer({ min: 0, max: 100_000 }),
        (amount, balance) => {
          const call = () =>
            validateNegativeAdjustmentAgainstBalance(amount, balance);
          if (amount < 0 && balance + amount < 0) {
            expect(call).toThrow();
          } else {
            expect(call).not.toThrow();
          }
        }
      )
    );
  });

  it("idempotent adjustment replay matches only on identical requests", () => {
    const requestArb = fc.record({
      memberId: fc.constantFrom("m1", "m2"),
      amountCents: fc.integer({ min: -500, max: 500 }),
      description: fc.constantFrom("desc-a", "desc-b"),
      requestedById: fc.constantFrom("admin-1", "admin-2"),
    });
    fc.assert(
      fc.property(requestArb, requestArb, (request, expected) => {
        const identical =
          request.memberId === expected.memberId &&
          request.amountCents === expected.amountCents &&
          request.description === expected.description &&
          request.requestedById === expected.requestedById;
        const call = () =>
          assertMatchingIdempotentAdjustmentRequest(request, expected);
        if (identical) {
          expect(call).not.toThrow();
        } else {
          expect(call).toThrow(ADMIN_ADJUSTMENT_IDEMPOTENCY_CONFLICT);
        }
      })
    );
  });
});
