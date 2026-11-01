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
