// The arithmetic and wording of one subscription charge: proration, the
// per-component cents and the Xero line description. Moved out of
// `membership-subscription-billing.ts` unchanged (#5190 PR 3, which also prices
// age-up parts from it), because that file is past its hard length ceiling
// (#4926). The old path still exports every name a caller used.
import type { MembershipFeeProrationRule } from "@prisma/client";
import { calendarDateOfDateOnlyInstant } from "@/lib/club-time";
import { formatAgeTierName } from "@/lib/age-tier-name";
import { getSeasonStartDate } from "@/lib/policies/age-tier";
import {
  getSeasonEndDate,
  prorateAnnualCents,
  remainingSeasonMonthsInclusive,
  type AgeUpEvent,
} from "@/lib/policies/subscription";
import { seasonYearsLabel } from "@/lib/season-label";

export class SubscriptionBillingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SubscriptionBillingError";
  }
}

/** The membership year's first and last days, as date-only instants. */
export function seasonBounds(seasonYear: number) {
  return { start: getSeasonStartDate(seasonYear), end: getSeasonEndDate(seasonYear) };
}

export function calculateMembershipCharge(input: {
  annualAmountCents: number;
  prorationRule: MembershipFeeProrationRule;
  seasonYear: number;
  decisionDate: Date;
}) {
  if (!Number.isSafeInteger(input.annualAmountCents) || input.annualAmountCents < 0) {
    throw new SubscriptionBillingError("Annual membership fee must be a non-negative integer number of cents.");
  }
  const { start, end } = seasonBounds(input.seasonYear);
  const decision = new Date(Date.UTC(
    input.decisionDate.getUTCFullYear(),
    input.decisionDate.getUTCMonth(),
    input.decisionDate.getUTCDate(),
  ));
  if (decision < start || decision > end) {
    throw new SubscriptionBillingError(`Decision date must fall within membership year ${input.seasonYear}.`);
  }
  if (input.prorationRule === "NONE") {
    return {
      amountCents: input.annualAmountCents,
      coveredMonths: 12,
      coverageStart: start,
      coverageEnd: end,
    };
  }
  // Whole months from the decision month to season end, both counted, and
  // half-up cent rounding: the one rule age-up parts share (`INV-MONEY-051`).
  const coveredMonths = remainingSeasonMonthsInclusive(input.seasonYear, calendarDateOfDateOnlyInstant(decision));
  return {
    amountCents: prorateAnnualCents(input.annualAmountCents, coveredMonths),
    coveredMonths,
    coverageStart: new Date(Date.UTC(decision.getUTCFullYear(), decision.getUTCMonth(), 1)),
    coverageEnd: end,
  };
}

// The single-line invoice description. A single-component fee (every existing fee
// post-backfill) reproduces this text — including the `(1 month)` vs `(N months)`
// pluralization. Multi-component fees append the component label to distinguish
// their lines.
//
// WHAT KEEPS AN EXISTING CHARGE'S LINE STABLE IS PERSISTENCE, NOT THIS LITERAL,
// and the comment that stood here said otherwise (#3116). It claimed a frozen
// string contract: a re-driven backfilled charge mints a byte-identical line
// BECAUSE this text never changes. That is not the mechanism.
// `MembershipSubscriptionChargeComponent.description` is a persisted column;
// this function WRITES it at plan time and the mint READS THE STORED COLUMN BACK
// (`xero-subscription-invoices.ts`, whose fallback branch is the one place that
// re-derives at send time). So changing this derivation changes newly-planned
// charges only.
//
// `yearEndMonth` IS REQUIRED and deliberately has no default, so an unstated
// year-end is a compile error rather than a silently wrong invoice line - see
// `season-label.ts` for why the default is wrong off a request path.
export function buildComponentLineDescription(input: {
  membershipTypeName: string;
  seasonYear: number;
  coveredMonths: number;
  label: string;
  isSoleComponent: boolean;
  yearEndMonth: number;
}) {
  return componentLineDescription({ ...input, lead: input.membershipTypeName + " membership" });
}

// The category-axis sibling: "subscription" replaces "membership" because a
// category charge is independent of any MembershipType. Both axes share one
// formatter (`componentLineDescription`) so the season label, month count and
// component suffix cannot drift between them (#4496 review, shared helpers).
export function buildCategoryComponentLineDescription(input: {
  subscriptionCategoryName: string;
  seasonYear: number;
  coveredMonths: number;
  label: string;
  isSoleComponent: boolean;
  yearEndMonth: number;
}) {
  return componentLineDescription({ ...input, lead: input.subscriptionCategoryName + " subscription" });
}

function componentLineDescription(input: {
  lead: string;
  seasonYear: number;
  coveredMonths: number;
  label: string;
  isSoleComponent: boolean;
  yearEndMonth: number;
}) {
  const base = `${input.lead} `
    + `${seasonYearsLabel(input.seasonYear, input.yearEndMonth)}`
    + ` (${input.coveredMonths} month${input.coveredMonths === 1 ? "" : "s"})`;
  return input.isSoleComponent ? base : `${base} — ${input.label}`;
}

// Per-component charged cents: same half-up cent rounding as the fee-level
// calculation, applied per line. Σ of per-component floors can diverge from the
// fee-level floor by up to (n−1) cents for a multi-component prorated fee — this
// is intended: the charge total is authoritative as Σ components so the invoice
// (one line per component) always foots to the charge amount (see
// docs/AUTHORITATIVE_FEES.md). A single-component fee is byte-identical.
export function componentChargedCents(amountCents: number, prorate: boolean, coveredMonths: number) {
  return prorate ? prorateAnnualCents(amountCents, coveredMonths) : amountCents;
}

/**
 * The Xero line of an age-up top-up or credit (#5190 PR 3): the membership
 * type's ordinary line for the months left, with the change named after it,
 * "Adult membership 2026-27 (3 months) — age group change, Youth to Adult".
 * A credit says "age group change credit". Frozen on the adjustment at confirm.
 */
export function buildAgeUpLineDescription(input: {
  membershipTypeName: string;
  seasonYear: number;
  yearEndMonth: number;
  part: Pick<AgeUpEvent, "fromTier" | "toTier"> & { coveredMonths: number };
  kind: "TOP_UP" | "CREDIT";
}): string {
  const change = `${formatAgeTierName(input.part.fromTier)} to ${formatAgeTierName(input.part.toTier)}`;
  return buildComponentLineDescription({
    membershipTypeName: input.membershipTypeName,
    seasonYear: input.seasonYear,
    coveredMonths: input.part.coveredMonths,
    label: input.kind === "TOP_UP" ? `age group change, ${change}` : `age group change credit, ${change}`,
    isSoleComponent: false,
    yearEndMonth: input.yearEndMonth,
  });
}
