import { TaxRate } from "xero-node";
import { percentToBasisPoints } from "@/lib/club-tax-settings";
import logger from "@/lib/logger";
import { callXeroApi, getAuthenticatedXeroClient } from "@/lib/xero-api-client";
import { readXeroConnection } from "@/lib/xero-connection";
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
 *
 * THE CACHE BELONGS TO ONE XERO ORGANISATION (#5209). It records the tenant it
 * was read from, and a cached read checks the connection first: after a
 * reconnect to another organisation the old organisation's rates are a miss,
 * never an answer about the new one.
 */

const CACHE_TTL_MS = 15 * 60 * 1000;
let cached: { rates: XeroTaxRateOption[]; fetchedAt: number; tenantId: string } | null = null;

/** The cached rates, when they are recent and were read from the organisation connected now. */
async function cachedRatesForConnectedTenant(): Promise<XeroTaxRateOption[] | null> {
  if (!cached || Date.now() - cached.fetchedAt >= CACHE_TTL_MS) return null;
  const entry = cached;
  let connectedTenantId: string | null;
  try {
    connectedTenantId = (await readXeroConnection())?.tenantId ?? null;
  } catch {
    return null; // Unknown organisation: read Xero again rather than trust the cache.
  }
  return connectedTenantId === entry.tenantId ? entry.rates : null;
}
/**
 * The degrading reader's last failure. For a minute after one it answers null
 * without asking Xero again, so a health poll during an outage (or under the
 * mock harness, which serves no rates) neither adds API calls nor a warning per
 * poll. The writer's fresh read never consults it.
 */
const FAILURE_TTL_MS = 60 * 1000;
let failedAt: number | null = null;

function rateOf(rate: TaxRate): XeroTaxRateOption | null {
  if (!rate.taxType) return null;
  const percent = rate.effectiveRate ?? rate.displayTaxRate;
  return {
    taxType: rate.taxType,
    name: rate.name ?? rate.taxType,
    rateBasisPoints: percentToBasisPoints(percent),
    active: rate.status === TaxRate.StatusEnum.ACTIVE,
    revenue: rate.canApplyToRevenue === true,
    expenses: rate.canApplyToExpenses === true,
  };
}

/**
 * Every tax rate in the connected organisation. Throws when Xero cannot be read
 * (not connected, rate-limited, down): a caller decides what an unknown answer
 * means, and the writer refuses rather than guess.
 */
export async function readXeroTaxRates(options: { fresh?: boolean } = {}): Promise<XeroTaxRateOption[]> {
  if (!options.fresh) {
    const hit = await cachedRatesForConnectedTenant();
    if (hit) return hit;
  }
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
  cached = { rates, fetchedAt: Date.now(), tenantId };
  return rates;
}

/** The same read, or null with the failure logged: for a screen or a health check that degrades. */
export async function readXeroTaxRatesOrNull(): Promise<XeroTaxRateOption[] | null> {
  if (failedAt !== null && Date.now() - failedAt < FAILURE_TTL_MS) return null;
  try {
    const rates = await readXeroTaxRates();
    failedAt = null;
    return rates;
  } catch (error) {
    failedAt = Date.now();
    logger.warn({ err: error }, "Could not read the Xero organisation's tax rates (#4632)");
    return null;
  }
}

export function resetXeroTaxRatesCacheForTests(): void {
  cached = null;
  failedAt = null;
}
