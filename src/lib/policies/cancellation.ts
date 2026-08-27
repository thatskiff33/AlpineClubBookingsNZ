import { normalizeCancellationRule, type CancellationRuleLike } from "../cancellation-rules";
import {
  calendarDateOfDateOnlyInstant,
  countClubNights,
  type CalendarDate,
} from "@/lib/club-time";

export type CancellationRule = CancellationRuleLike;

/**
 * Determine which cancellation tier applies for a given number of days before check-in.
 * Returns the matching tier's refund percentage and days threshold.
 *
 * Policy rules are sorted by daysBeforeStay descending.
 * The first rule where daysUntilCheckIn >= daysBeforeStay applies.
 */
export function getRefundTier(
  daysUntilCheckIn: number,
  policyRules: CancellationRule[]
): {
  refundPercentage: number;
  creditRefundPercentage: number;
  fixedFeeCents: number;
  creditFixedFeeCents: number;
  daysBeforeStay: number;
} {
  if (policyRules.length === 0) {
    return {
      refundPercentage: 0,
      creditRefundPercentage: 0,
      fixedFeeCents: 0,
      creditFixedFeeCents: 0,
      daysBeforeStay: 0,
    };
  }

  const sortedRules = [...policyRules].sort(
    (a, b) => b.daysBeforeStay - a.daysBeforeStay
  );

  for (const rule of sortedRules) {
    if (daysUntilCheckIn >= rule.daysBeforeStay) {
      return normalizeCancellationRule(rule);
    }
  }

  return {
    refundPercentage: 0,
    creditRefundPercentage: 0,
    fixedFeeCents: 0,
    creditFixedFeeCents: 0,
    daysBeforeStay: 0,
  };
}

/**
 * Calculate refund amount based on cancellation policy.
 *
 * Example policy:
 *   [{days: 14, refund: 100}, {days: 7, refund: 50}, {days: 0, refund: 0}]
 *
 * - Cancel 15 days before -> 100% refund
 * - Cancel 10 days before -> 50% refund
 * - Cancel 3 days before -> 0% refund
 */
export function calculateRefundAmount(
  paidAmountCents: number,
  daysUntilCheckIn: number,
  policyRules: CancellationRule[],
  refundMethod: "card" | "credit" = "card"
): { refundAmountCents: number; refundPercentage: number } {
  const tier = getRefundTier(daysUntilCheckIn, policyRules);
  const refundPercentage =
    refundMethod === "credit"
      ? tier.creditRefundPercentage
      : tier.refundPercentage;
  const fixedFeeCents =
    refundMethod === "credit"
      ? tier.creditFixedFeeCents
      : tier.fixedFeeCents;
  const refundAmountCents = Math.max(
    0,
    Math.round((paidAmountCents * refundPercentage) / 100) - fixedFeeCents
  );
  return { refundAmountCents, refundPercentage };
}

/**
 * Refund amount for the slice a member originally paid with account credit, tiered by the
 * SAME cancellation tier as the card slice (#1164 / decision D7). The fixed cancellation fee is
 * charged once per cancellation, card-first: only the portion of the tier's fixedFeeCents the card
 * slice's gross did not absorb is taken from the credit slice, so a credit-only booking still pays
 * the fee and a mixed booking is not double-charged.
 */
export function calculateAppliedCreditRestore(
  creditAppliedCents: number,
  cardRefundableBaseCents: number,
  daysUntilCheckIn: number,
  policyRules: CancellationRule[]
): { creditRestoredCents: number; creditRestorePercentage: number } {
  if (creditAppliedCents <= 0) {
    return { creditRestoredCents: 0, creditRestorePercentage: 0 };
  }
  const tier = getRefundTier(daysUntilCheckIn, policyRules);
  const pct = tier.refundPercentage; // same tier as card
  const cardGross = Math.round((Math.max(0, cardRefundableBaseCents) * pct) / 100);
  const feeRemainder = Math.max(0, tier.fixedFeeCents - cardGross); // fee once, card-first
  const creditGross = Math.round((creditAppliedCents * pct) / 100);
  return {
    creditRestoredCents: Math.max(0, creditGross - feeRemainder),
    creditRestorePercentage: pct,
  };
}

/**
 * Calculate both card and credit refund amounts for a cancel preview.
 */
export function calculateDualRefundAmounts(
  paidAmountCents: number,
  daysUntilCheckIn: number,
  policyRules: CancellationRule[]
): {
  cardRefundAmountCents: number;
  cardRefundPercentage: number;
  creditRefundAmountCents: number;
  creditRefundPercentage: number;
} {
  const tier = getRefundTier(daysUntilCheckIn, policyRules);
  return {
    cardRefundAmountCents: Math.max(
      0,
      Math.round((paidAmountCents * tier.refundPercentage) / 100) - tier.fixedFeeCents
    ),
    cardRefundPercentage: tier.refundPercentage,
    creditRefundAmountCents: Math.max(
      0,
      Math.round((paidAmountCents * tier.creditRefundPercentage) / 100) - tier.creditFixedFeeCents
    ),
    creditRefundPercentage: tier.creditRefundPercentage,
  };
}

/**
 * Whole lodge days from the club's today to `checkIn` — the refund-tier
 * boundary.
 *
 * BOTH OPERANDS ARE CALENDAR DAYS, AND NEITHER TAKES A TIMEZONE. That is the
 * whole content of this function, and getting it wrong was a live off-by-one on
 * money (#3123).
 *
 *  - `checkIn` is a stored `@db.Date` lodge night (`prisma/schema.prisma:1662`),
 *    so it is DECODED from the column's UTC-midnight encoding
 *    (`calendarDateOfDateOnlyInstant`, `INV-DATE-019`'s first exact boundary with
 *    `INV-DATE-026`).
 *  - `todayAtClub` is the club's own calendar day, resolved by the caller from
 *    the persisted `ClubTimeSettings.timeZone` (`INV-CONFIG-002`).
 *
 * ## The two defects this signature removes
 *
 * It used to be `daysUntilDate(checkIn, now: Date = new Date())` and to project
 * BOTH operands through `APP_TIME_ZONE`. Measured with the container on
 * `America/Denver`, a stored check-in of 1 August against 30 June returned
 * **31** where the answer is **32**: the projection moved the stored night back
 * a day and the real instant not at all, so the errors did not cancel — they
 * subtracted. Every club behind Greenwich was tiered one day short of its own
 * published cancellation policy, which moves money. Decoding the stored day
 * closed that half.
 *
 * The other half was the `now` operand, and it is closed by the TYPE. An instant
 * has no calendar day until a zone is chosen, so accepting a `Date` here meant
 * the function had to choose one, and the only zone a sync, pure,
 * transaction-bound function can reach is the container's. `CalendarDate` makes
 * an instant unrepresentable in this position: the caller must have already
 * asked the club what day it is. The same remedy `member-age.ts` took for the
 * other operand of the same class of comparison (#3082).
 *
 * ## Why it is a REQUIRED parameter and not an `await` in here
 *
 * `INV-LOCK-004` names the club timezone as one of only two reads that cannot
 * take a transaction client. Ten call sites reach this function across seven
 * money modules and four of them are inside an open interactive transaction
 * holding `pg_advisory_xact_lock(1)` and the per-lodge capacity key
 * (`INV-LOCK-001`, `INV-LOCK-002`) — `booking-cancel.ts`,
 * `booking-date-modification-service.ts`, `booking-modify-plan.ts` and
 * `booking-modify-settlement.ts`'s callers. A `clubTimeSettings.findUnique` in
 * here would take a second pooled connection under those locks and escape the
 * transaction's own client. Every caller therefore resolves ONE club day before
 * it opens its transaction and threads it in. See
 * `docs/CONCURRENCY_AND_LOCKING.md` -> "Which client reads the club's timezone".
 *
 * ## The arithmetic
 *
 * `countClubNights` is exact integer calendar arithmetic, so a DST transition
 * inside the range cannot make the answer 30.958 days. The previous form divided
 * elapsed milliseconds by 86_400_000, which was safe only because both operands
 * were pinned to UTC midnight — `docs/CLUB_TIME_KERNEL.md` records what that
 * arithmetic does the moment an operand becomes club-local, and #3100 is what it
 * cost. The deliberate "partial days do NOT reach a higher tier" intent is
 * preserved: neither operand carries a time of day at all now, so there are no
 * partial days to floor.
 */
export function daysUntilDate(
  checkIn: Date,
  todayAtClub: CalendarDate,
): number {
  return countClubNights(todayAtClub, calendarDateOfDateOnlyInstant(checkIn));
}
