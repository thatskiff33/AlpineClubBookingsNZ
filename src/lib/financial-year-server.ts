/**
 * Server-side resolution of the membership financial year-end month.
 *
 * Resolves the effective month in this order:
 *   1. admin override (MembershipLockoutSettings.financialYearEndMonthOverride)
 *   2. the connected Xero organisation's accounting financial year
 *   3. March (the default)
 *
 * The resolved value is written into the synchronous cache in
 * `financial-year.ts` so the season helpers stay synchronous. This module is
 * server-only (it touches Prisma and Xero), so it must never be imported into
 * client bundles.
 */

import type { PrismaClient } from "@prisma/client";
import { cache } from "react";
import { isConnectedTenant, readXeroConnection } from "@/lib/xero-connection";

import type { ClubClock, ClubTimeZone } from "@/lib/club-time";
import {
  DEFAULT_FINANCIAL_YEAR_END_MONTH,
  clubSeasonYear,
  getFinancialYearEndMonth,
  setFinancialYearEndMonth,
} from "@/lib/financial-year";
import logger from "@/lib/logger";
import {
  loadMembershipLockoutSettings,
  MEMBERSHIP_LOCKOUT_SETTINGS_ID,
  normalizeMembershipLockoutSettings,
} from "@/lib/membership-lockout-settings";
import { prisma } from "@/lib/prisma";
import { getXeroFinancialYearEndMonth } from "@/lib/xero-organisation";

/**
 * Resolve the effective year-end month, update the in-process cache, and return
 * it. Safe to call on every gated request: it reseeds the cache for this
 * instance so the synchronous helpers are correct.
 */
export async function refreshFinancialYearConfig(): Promise<number> {
  const month = await resolveFinancialYearEndMonth();
  setFinancialYearEndMonth(month);
  return month;
}

/**
 * The club's year-end month for THIS render pass, for a server component that
 * hands it to the browser (#5259) or names a season itself.
 *
 * React `cache()` for the reason `club-time/server.ts` gives for the zone:
 * request-scoped, so the admin layout and a page beneath it resolve once
 * between them, and the next request reads a changed override with nothing to
 * invalidate. Outside a render pass it is the uncached refresh. It still
 * reseeds the process cache, as every request-path resolution does.
 */
export const clubFinancialYearEndMonth = cache(refreshFinancialYearConfig);

/**
 * How long the admin layout waits for the year-end before drawing with the
 * last value this process resolved (#5259 review). A cold Xero year-end cache
 * makes the resolution a live read, which can queue behind another process's
 * token-refresh lease for minutes; every admin page would queue with it.
 */
export const LAYOUT_YEAR_END_WAIT_MS = 2_000;

const TIMED_OUT = Symbol("year-end wait timed out");

/**
 * {@link clubFinancialYearEndMonth} for the ADMIN LAYOUT, bounded to `waitMs`.
 *
 * Past the bound, or on a rejection, it returns `getFinancialYearEndMonth()`:
 * the last month any resolution in this process seeded (March before the first).
 * The stored resolution adds nothing here: an override never reaches Xero, so it
 * cannot be what is slow, and with none set a connected club's month is not
 * stored. The resolution keeps running and reseeds the process cache when it
 * lands, so the next page draws with it. Routes keep the unbounded read: they
 * decide money, and must not decide it on a stale month.
 */
export async function clubFinancialYearEndMonthForLayout(
  waitMs: number = LAYOUT_YEAR_END_WAIT_MS,
): Promise<number> {
  const live = clubFinancialYearEndMonth();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), waitMs);
  });
  try {
    const month = await Promise.race([live, timeout]);
    if (month !== TIMED_OUT) return month;
    // Keep the abandoned read from surfacing as an unhandled rejection.
    live.catch(() => undefined);
    const fallback = getFinancialYearEndMonth();
    logger.warn(
      { waitMs, fallbackMonth: fallback },
      "Financial year-end resolution exceeded the admin layout's wait; using this process's last resolved month",
    );
    return fallback;
  } catch (err) {
    const fallback = getFinancialYearEndMonth();
    logger.warn(
      { err, fallbackMonth: fallback },
      "Financial year-end resolution failed for the admin layout; using this process's last resolved month",
    );
    return fallback;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The club's current season year, from its zone AND its resolved year-end: the
 * server-side answer to the admin screens' `useClubSeason().currentSeasonYear()`,
 * so a route defaulting a season cannot pick a different one from its screen.
 */
export async function clubCurrentSeasonYear(
  zone: ClubTimeZone,
  clock?: ClubClock,
): Promise<number> {
  return clubSeasonYear(zone, clock, await clubFinancialYearEndMonth());
}

/**
 * Resolve the effective year-end month without touching the cache. Returns the
 * pieces needed by the admin UI as well.
 */
async function resolveFinancialYearEndMonth(): Promise<number> {
  const { effectiveMonth } = await getFinancialYearResolution();
  return effectiveMonth;
}

export interface FinancialYearResolution {
  /** The override set by the admin, or null when following Xero. */
  overrideMonth: number | null;
  /** The connected Xero organisation's year-end month, or null. */
  xeroMonth: number | null;
  /** The resolved month actually in effect (1-12). */
  effectiveMonth: number;
}

/**
 * The two relations the provider-free resolution reads, as a structural type so a
 * `Prisma.TransactionClient` satisfies it.
 *
 * A caller that has opened a bounded read-only transaction MUST pass it: reading
 * these two rows on the global client instead would put them outside that
 * transaction's snapshot and outside its statement timeout, which is the whole
 * boundary such a caller opened the transaction to get.
 */
export type StoredFinancialYearDb = Pick<
  PrismaClient,
  "membershipLockoutSettings" | "xeroConnection"
>;

export type StoredFinancialYearResolution =
  | {
      ok: true;
      effectiveMonth: number;
      source: "override" | "default_without_xero";
    }
  | { ok: false; reason: "connected_xero_month_not_stored" };

/**
 * Provider-free resolution for read-only diagnostics.
 *
 * A stored override is authoritative. With no override, March is authoritative
 * only when persisted state proves there is no connected Xero tenant. The
 * organisation month is not persisted locally, so a connected tenant must be
 * reported as unavailable rather than guessed from the cold process cache or
 * fetched from Xero. Only the connection's non-secret facts are read
 * (`readXeroConnection`, #3806); no credential crosses this boundary.
 */
export async function getStoredFinancialYearResolution(
  db: StoredFinancialYearDb = prisma,
): Promise<StoredFinancialYearResolution> {
  // Read this row STRICTLY. `loadMembershipLockoutSettings` intentionally treats
  // every database error as a migration-era missing table and returns defaults;
  // that is acceptable for the product fallback but not for evidence. A rejected
  // read must propagate so Diagnostics reports `evidence_unavailable` rather than
  // claiming the March default was observed.
  const persisted = await db.membershipLockoutSettings.findUnique({
    where: { id: MEMBERSHIP_LOCKOUT_SETTINGS_ID },
    select: {
      mode: true,
      financialYearEndMonthOverride: true,
      textFallbackEnabled: true,
      useFeeScheduleItemCodes: true,
    },
  });
  // A genuinely absent singleton row still has the product's documented defaults.
  // Keep the canonical normalizer so malformed persisted values fail closed in the
  // same direction as every membership path.
  const settings = normalizeMembershipLockoutSettings(persisted);
  const overrideMonth = settings.financialYearEndMonthOverride;
  if (overrideMonth !== null) {
    return { ok: true, effectiveMonth: overrideMonth, source: "override" };
  }

  const connectedTenant = isConnectedTenant(await readXeroConnection(db));
  return connectedTenant
    ? { ok: false, reason: "connected_xero_month_not_stored" }
    : {
        ok: true,
        effectiveMonth: DEFAULT_FINANCIAL_YEAR_END_MONTH,
        source: "default_without_xero",
      };
}

export async function getFinancialYearResolution(): Promise<FinancialYearResolution> {
  const settings = await loadMembershipLockoutSettings();
  const overrideMonth = settings.financialYearEndMonthOverride;
  const xeroMonth =
    overrideMonth == null ? await getXeroFinancialYearEndMonth() : null;
  const effectiveMonth =
    overrideMonth ?? xeroMonth ?? DEFAULT_FINANCIAL_YEAR_END_MONTH;
  return { overrideMonth, xeroMonth, effectiveMonth };
}
