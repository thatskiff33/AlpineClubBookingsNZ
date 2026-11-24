import type { ClubTaxTreatment } from "../../club-tax-settings";
import { MAX_INTEGER_CENTS } from "../../money-input";

/** A charge's frozen split: integer cents, gross = net + tax, and the code it was taxed under. */
export interface MemberMoneyTaxSplit {
  grossCents: number;
  netCents: number;
  taxCents: number;
  taxCode: string;
}

/**
 * The tax inside a GST-inclusive gross amount, in integer cents only
 * (`INV-MONEY-001`, `INV-MONEY-003`): tax = round-half-up(gross × rate /
 * (10000 + rate)), net = gross − tax. BigInt keeps every step exact, so no
 * product is ever rounded through a double. An unregistered club has no split:
 * `null`, so the leg records no tax fields and the batch no GST leg.
 */
export function splitTaxInclusiveGross(grossCents: number, treatment: ClubTaxTreatment): MemberMoneyTaxSplit | null {
  if (!Number.isSafeInteger(grossCents) || grossCents < 0 || grossCents > MAX_INTEGER_CENTS) {
    throw new Error(`A gross amount must be integer cents from 0 to ${MAX_INTEGER_CENTS}; got ${grossCents}.`);
  }
  if (!treatment.registered) return null;
  const rate = BigInt(treatment.rateBasisPoints);
  const divisor = 10_000n + rate;
  // round-half-up(a / b) for a, b >= 0 is floor((2a + b) / 2b).
  const taxCents = Number((2n * BigInt(grossCents) * rate + divisor) / (2n * divisor));
  return { grossCents, netCents: grossCents - taxCents, taxCents, taxCode: treatment.taxCode };
}

/** Each line's share of a component's tax, in line order, or why there is none. */
export type MemberMoneyLineTaxAllocation = { lineTaxCents: number[] } | { problem: string };

/**
 * Share one component's journal tax across the invoice lines that bill it
 * (#5208, owner decision 18 Nov 2026, Option A: the journal's GST is the figure
 * of record). Each line's exact share is tax × line gross / component gross,
 * signed, so a promo line takes negative tax. Every share is floored and the
 * cents left over go one each to the largest remainders, the earliest line
 * first on a tie, so the shares sum to the component's tax exactly and each is
 * within a cent of its exact share. BigInt throughout (`INV-MONEY-003`).
 *
 * A problem, never a throw, when the inputs cannot be shared: tax below zero or
 * above the lines' gross, or a value that is not integer cents.
 */
export function allocateTaxAcrossLines(componentTaxCents: number, lineGrossCents: readonly number[]): MemberMoneyLineTaxAllocation {
  if (!Number.isSafeInteger(componentTaxCents) || !lineGrossCents.every(Number.isSafeInteger)) {
    return { problem: "a tax or line amount is not integer cents" };
  }
  const tax = BigInt(componentTaxCents);
  const gross = lineGrossCents.reduce((sum, cents) => sum + BigInt(cents), 0n);
  if (tax < 0n) return { problem: "the component's tax is below zero" };
  if (tax > gross) return { problem: "the component's tax is more than its lines' gross" };
  if (gross === 0n) return { lineTaxCents: lineGrossCents.map(() => 0) };
  const shares = lineGrossCents.map((cents, index) => {
    const scaled = tax * BigInt(cents);
    // Floor division for a signed numerator over a positive gross.
    let floor = scaled / gross;
    if (scaled % gross < 0n) floor -= 1n;
    return { index, floor, remainder: scaled - floor * gross };
  });
  let left = tax - shares.reduce((sum, share) => sum + share.floor, 0n);
  const byRemainder = [...shares].sort((a, b) =>
    a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1);
  for (const share of byRemainder) {
    if (left === 0n) break;
    share.floor += 1n;
    left -= 1n;
  }
  return { lineTaxCents: shares.map((share) => Number(share.floor)) };
}
