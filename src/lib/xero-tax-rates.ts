import { TaxRate } from "xero-node";
import { percentToBasisPoints } from "@/lib/club-tax-settings";
import logger from "@/lib/logger";
import { callXeroApi, getAuthenticatedXeroClient } from "@/lib/xero-api-client";
import { isXeroMockActive } from "@/lib/xero-mock-endpoint";
import type { XeroTaxRateOption } from "@/lib/xero-tax-rate-options";

/**
 * THE CONNECTED XERO ORGANISATION'S TAX RATES (#4632). One reader of
 * `getTaxRates`, and the one test of whether a club tax period's Xero code can
 * be used: the writer refuses a period that fails it
 * (`club-tax-settings-write.ts`), and the Xero health checks flag the period in
 * force when it starts failing (`xero-tax-health.ts`).
 *
 * Read OUTSIDE any transaction (`INV-LOCK-004`): a provider call is never made
 * under a database transaction. Cached in-process for a short while, because
 * the admin card and the health page read it on every render; the writer always
 * reads fresh, so a save is judged on what Xero says now. What a rate may be
 * used for is `xero-tax-rate-options.ts`, which the card shares.
 */

const CACHE_TTL_MS = 15 * 60 * 1000;
let cached: { rates: XeroTaxRateOption[]; fetchedAt: number } | null = null;

function rateOf(rate: TaxRate): XeroTaxRateOption | null {
  if (!rate.taxType) return null;
  const percent = rate.effectiveRate ?? rate.displayTaxRate;
  return {
    taxType: rate.taxType,
    name: rate.name ?? rate.taxType,
    rateBasisPoints: percentToBasisPoints(percent),
    active: rate.status === TaxRate.StatusEnum.ACTIVE,
    revenue: rate.canApplyToRevenue === true,
  };
}

/**
 * Every tax rate in the connected organisation. Throws when Xero cannot be read
 * (not connected, rate-limited, down): a caller decides what an unknown answer
 * means, and the writer refuses rather than guess.
 */
export async function readXeroTaxRates(options: { fresh?: boolean } = {}): Promise<XeroTaxRateOption[]> {
  if (!options.fresh && cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached.rates;
  // The E2E mock harness serves no tax rates; production-inert.
  if (isXeroMockActive()) throw new Error("The Xero mock harness serves no tax rates.");
  const { xero, tenantId } = await getAuthenticatedXeroClient();
  const response = await callXeroApi(() => xero.accountingApi.getTaxRates(tenantId), {
    operation: "getTaxRates",
    resourceType: "TAX_RATE",
    workflow: "clubTaxTreatment",
    context: "xero-tax-rates readXeroTaxRates",
    // A settings read: one attempt, and it never arms the breaker invoicing relies on.
    maxRetries: 0,
    maxTransientRetries: 0,
    armTransientBreaker: false,
  });
  const rates = (response.body.taxRates ?? [])
    .map(rateOf)
    .filter((rate): rate is XeroTaxRateOption => rate !== null)
    .sort((a, b) => a.taxType.localeCompare(b.taxType));
  cached = { rates, fetchedAt: Date.now() };
  return rates;
}

/** The same read, or null with the failure logged: for a screen or a health check that degrades. */
export async function readXeroTaxRatesOrNull(): Promise<XeroTaxRateOption[] | null> {
  try {
    return await readXeroTaxRates();
  } catch (error) {
    logger.warn({ err: error }, "Could not read the Xero organisation's tax rates (#4632)");
    return null;
  }
}

export function resetXeroTaxRatesCacheForTests(): void {
  cached = null;
}
