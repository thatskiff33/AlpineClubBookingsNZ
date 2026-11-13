import type { ClubTaxPeriod } from "@/lib/club-tax-settings";

/**
 * What a Xero tax rate may carry (#4632): the one test of whether a club tax
 * period's Xero code can be used, and the picker's list of usable rates. Pure,
 * with no Xero client, so the "GST / tax treatment" card filters its picker by
 * the same rule the writer refuses by. The read is `xero-tax-rates.ts`.
 */
export interface XeroTaxRateOption {
  taxType: string;
  name: string;
  /** Xero's effective rate in whole basis points (15% is 1500), or null when Xero gave none. */
  rateBasisPoints: number | null;
  active: boolean;
  /** Whether Xero lets the rate sit on a revenue line. */
  revenue: boolean;
}

/** The rates a registered period may name at a rate: active, usable on revenue, and at that rate. */
export function usableXeroTaxRates(rates: readonly XeroTaxRateOption[], rateBasisPoints: number): XeroTaxRateOption[] {
  return rates.filter((rate) => rate.active && rate.revenue && rate.rateBasisPoints === rateBasisPoints);
}

/**
 * Why Xero cannot carry this period, in plain English, or null when it can. An
 * unregistered period names no code, so Xero has nothing to check; a registered
 * one must name a rate that is active, usable on revenue, and at the period's
 * own rate, so the rate the journal splits at and the code Xero splits under
 * can never disagree.
 */
export function xeroTaxCodeProblem(
  rates: readonly XeroTaxRateOption[],
  period: Pick<ClubTaxPeriod, "gstRegistered" | "taxRateBasisPoints" | "xeroTaxType">,
): string | null {
  if (!period.gstRegistered) return null;
  const code = period.xeroTaxType;
  const rate = rates.find((candidate) => candidate.taxType === code);
  if (!code || !rate) return `Xero has no tax rate with the code ${code ?? "(none)"}.`;
  if (!rate.active) return `Xero's tax rate ${code} (${rate.name}) is not active.`;
  if (!rate.revenue) return `Xero's tax rate ${code} (${rate.name}) cannot be used on revenue.`;
  if (rate.rateBasisPoints !== period.taxRateBasisPoints) {
    return `Xero's tax rate ${code} (${rate.name}) is ${formatBasisPoints(rate.rateBasisPoints)}, not ${formatBasisPoints(period.taxRateBasisPoints)}.`;
  }
  return null;
}

/** 1500 as "15%", 1250 as "12.5%". */
export function formatBasisPoints(basisPoints: number | null): string {
  if (basisPoints === null) return "an unknown rate";
  return `${(basisPoints / 100).toString()}%`;
}
