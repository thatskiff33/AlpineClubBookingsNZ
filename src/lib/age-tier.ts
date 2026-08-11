import type { AgeTier } from "@prisma/client";
import { getSeasonYear } from "./utils";
import {
  AGE_TIER_DEFAULTS,
  cloneAgeTierSettings,
  computeAgeTierWithSettings,
  getSeasonStartDate,
  normalizeAgeTierSettings,
  type AgeTierSettingData,
} from "./policies/age-tier";

export {
  AGE_TIER_DEFAULTS,
  // test seam
  computeAge,
  computeAgeTierWithSettings,
  getSeasonStartDate,
  normalizeAgeTierSettings,
  validateAgeTierPartition,
} from "./policies/age-tier";
export type { AgeTierSettingData } from "./policies/age-tier";
// AgeTierPartitionRow and AgeTierPartitionResult used to be re-exported here
// too, but every consumer (config-transfer/categories/age-tier.ts,
// induction-baseline.ts) already imports them straight from
// ./policies/age-tier, the module that actually declares them — knip 6.29+
// correctly flagged those two re-export specifiers as dead (#2502).

let _cachedSettings: AgeTierSettingData[] | null = null;
let _cacheExpiry = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/** Invalidate the in-memory settings cache (call after PUT /api/admin/age-tier-settings). */
export function invalidateAgeTierCache(): void {
  _cachedSettings = null;
  _cacheExpiry = 0;
}

/**
 * The columns the age-tier rule consumes. Blue/green runtime-prep (#2130): name
 * ONLY these, so a deployed client cannot SELECT a column a contract migration is
 * about to drop. Shared by the cached reader and the strict one below so the two
 * cannot come to read different columns.
 */
const AGE_TIER_SETTING_SELECT = {
  tier: true,
  minAge: true,
  maxAge: true,
  label: true,
  subscriptionRequiredForBooking: true,
  familyGroupRequestCreateMemberAllowed: true,
  sortOrder: true,
} as const;

/**
 * THE SAME SETTINGS, WITHOUT THE FALLBACK — for evidence, not for product paths.
 *
 * `getAgeTierSettings` below swallows any database failure and returns
 * `AGE_TIER_DEFAULTS`. That is right for a product path: a booking screen with the
 * default tiers is better than a booking screen with an error, and the defaults are
 * the club's own documented starting point.
 *
 * IT IS WRONG FOR AN EVIDENCE PATH, and the failure is quiet in the worst way. AI
 * Diagnostics reports whether a member's tier owes a season subscription. On a cold
 * cache and a transient database failure, the swallow hands it the DEFAULT rule and
 * nothing marks the answer as unobserved — so a club that has configured its tiers
 * differently gets a confident, wrong, directly actionable finding
 * ("subscription_unpaid" against a member whose tier the club exempts), with an
 * observed-at timestamp that makes it look freshly measured. `#2376`'s result
 * contract has a state for exactly this (`evidence_unavailable`) and the owner's
 * decision requires missing evidence to be reported as missing.
 *
 * SO THE TWO CASES ARE SEPARATED, which is the whole point of this function:
 *
 *  - The read FAILED → this rejects, and the caller reports evidence unavailable.
 *  - The table is genuinely EMPTY → the club has configured no tiers, the platform's
 *    documented defaults are what actually govern it, and those are returned. That
 *    is an observation, not a fallback.
 *
 * IT DOES NOT TOUCH THE SHARED CACHE, in either direction. Not reading it keeps a
 * stale five-minute-old row from being reported as freshly observed; not writing it
 * keeps a diagnostics read from changing what every other request in the process
 * computes, which is the same rule that stops this pack reseeding the
 * financial-year cache.
 */
export async function getAgeTierSettingsStrict(
  /**
   * A caller inside a bounded read-only transaction MUST pass it, so the read sits
   * under that transaction's snapshot and statement timeout.
   */
  db?: { ageTierSetting: { findMany: typeof import("./prisma").prisma.ageTierSetting.findMany } },
): Promise<AgeTierSettingData[]> {
  const client = db ?? (await import("./prisma")).prisma;
  const rows = await client.ageTierSetting.findMany({
    orderBy: { sortOrder: "asc" },
    select: AGE_TIER_SETTING_SELECT,
  });
  const normalized = normalizeAgeTierSettings(
    rows.map((r) => ({
      tier: r.tier,
      minAge: r.minAge,
      maxAge: r.maxAge,
      label: r.label,
      subscriptionRequiredForBooking: r.subscriptionRequiredForBooking ?? true,
      familyGroupRequestCreateMemberAllowed:
        r.familyGroupRequestCreateMemberAllowed ?? false,
      sortOrder: r.sortOrder,
    })),
  );
  return normalized.length > 0
    ? normalized
    : cloneAgeTierSettings(AGE_TIER_DEFAULTS);
}

/**
 * Fetch age tier settings from DB with 5-minute in-memory cache.
 * Falls back to hardcoded defaults if DB is unavailable.
 *
 * An EVIDENCE caller must use `getAgeTierSettingsStrict` above instead: this
 * function cannot tell a caller whether the settings it returned were observed.
 */
export async function getAgeTierSettings(): Promise<AgeTierSettingData[]> {
  const now = Date.now();
  if (_cachedSettings && now < _cacheExpiry) {
    return _cachedSettings;
  }

  try {
    // Dynamic import to avoid circular deps and allow test mocking
    const { prisma } = await import("./prisma");
    // Blue/green runtime-prep (#2130): name ONLY the columns consumed below.
    // This stopped the deployed client SELECTing AgeTierSetting.xeroContactGroupId
    // / xeroContactGroupName one release BEFORE the #2130 STEP 2 contract
    // migration dropped them; keep the select narrow regardless. The
    // returned AgeTierSettingData carries exactly these fields, so every
    // downstream consumer (computeAgeTier and the admin settings round-trip) is
    // unchanged.
    const rows = await prisma.ageTierSetting.findMany({
      orderBy: { sortOrder: "asc" },
      select: AGE_TIER_SETTING_SELECT,
    });
    const normalized = normalizeAgeTierSettings(
      rows.map((r) => ({
        tier: r.tier,
        minAge: r.minAge,
        maxAge: r.maxAge,
        label: r.label,
        subscriptionRequiredForBooking: r.subscriptionRequiredForBooking ?? true,
        familyGroupRequestCreateMemberAllowed:
          r.familyGroupRequestCreateMemberAllowed ?? false,
        sortOrder: r.sortOrder,
      }))
    );
    if (normalized.length > 0) {
      _cachedSettings = normalized;
      _cacheExpiry = now + CACHE_TTL_MS;
      return _cachedSettings;
    }
  } catch {
    // DB unavailable - fall through to defaults
  }

  return cloneAgeTierSettings(AGE_TIER_DEFAULTS);
}

/**
 * Compute age tier for a date of birth.
 *
 * referenceDate defaults to April 1 of the current season year (the TAC
 * reference point for age classification). Reads boundaries from DB with a
 * 5-minute cache; falls back to hardcoded defaults if DB is unavailable.
 */
export async function computeAgeTier(
  dateOfBirth: Date,
  referenceDate?: Date
): Promise<AgeTier> {
  const ref = referenceDate ?? getSeasonStartDate(getSeasonYear());
  const settings = await getAgeTierSettings();
  return computeAgeTierWithSettings(dateOfBirth, ref, settings);
}

// test seam
// Re-export from canonical location for backwards compatibility
export { getSeasonYear as computeSeasonYear } from "./utils";
