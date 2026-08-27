import type { AgeTier, PrismaClient } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import {
  getAgeTierSettings,
  type AgeTierSettingData,
} from "@/lib/age-tier";
import { refreshFinancialYearConfig } from "@/lib/financial-year-server";
import {
  loadMembershipLockoutSettings,
  loadMembershipLockoutSettingsStrict,
  type SubscriptionLockoutMode,
} from "@/lib/membership-lockout-settings";
import {
  loadEffectiveModuleFlags,
  loadEffectiveModuleFlagsStrict,
} from "@/lib/module-settings";
import { requiresPaidSubscriptionForAgeTier as requiresPaidSubscriptionForAgeTierRule } from "@/lib/policies/subscription";

/** The two relations the strict mode read needs; a transaction client satisfies it. */
export type StrictLockoutModeDb = Pick<
  PrismaClient,
  "clubModuleSettings" | "membershipLockoutSettings"
>;

export function requiresPaidSubscriptionForAgeTier(
  ageTier: AgeTier | null | undefined,
  settings: AgeTierSettingData[]
): boolean {
  return requiresPaidSubscriptionForAgeTierRule(ageTier, settings);
}

export async function requiresPaidSubscriptionForAgeTierFromSettings(
  ageTier: AgeTier | null | undefined
): Promise<boolean> {
  const settings = await getAgeTierSettings();
  return requiresPaidSubscriptionForAgeTier(ageTier, settings);
}

/**
 * The club's effective subscription-lockout policy for booking (#2543).
 *
 * Membership subscriptions are invoiced and reconciled through Xero, so the
 * policy resolves to `NO_BLOCK` whenever the Xero module is effectively off —
 * members could never reach PAID, and neither refusing them nor repricing them
 * would be honest. Otherwise it is exactly the admin's stored three-way mode.
 *
 * This call also reseeds the financial-year cache for the current instance, so
 * the synchronous season helpers stay correct on every gated booking request.
 *
 * SINGLE SOURCE. Every consumer — the booking gates, the pricing reprice, the
 * paid-up-adult requirement and the hosting bridge — reads the mode through
 * this function, so no path can decide the club is in a different regime than
 * its neighbour and produce the "priced as a member here, refused there"
 * inconsistency #2543 exists to remove.
 */
export async function resolveSubscriptionLockoutMode(): Promise<SubscriptionLockoutMode> {
  const policy = await readSubscriptionLockoutPolicy();
  if (policy.xeroModuleEnabled) {
    // Reseed the in-process financial-year cache (cheap; uses cached Xero value).
    //
    // BEFORE THE MODE IS CONSULTED, and gated on the Xero module rather than on
    // the resolved mode. Pre-#2543 this reseed ran on exactly one condition — the
    // Xero module is on — and gating it on `mode !== "NO_BLOCK"` instead silently
    // narrowed it, because a club that has deliberately switched the lockout off
    // resolves to `NO_BLOCK` through the legacy `enabled` fallback with the Xero
    // module still on. Every request-path reseeder in the tree routes through
    // this function (the five booking write paths, `findUnpaidMemberGuests` and
    // the member notice builder), so narrowing it left such a club with no
    // request-path reseed at all: after a container restart, the season helpers
    // and `computeAgeTier` would resolve against the March default instead of the
    // club's real year-end month, and the rate resolved for a booking can differ
    // from the correct one. Restored to the pre-#2543 condition.
    await refreshFinancialYearConfig();
  }
  return policy.mode;
}

/**
 * The stored policy plus the one fact `resolveSubscriptionLockoutMode` needs that
 * the mode alone cannot carry: whether the Xero module is on.
 *
 * `NO_BLOCK` is returned both for "Xero is off" and for "the club chose
 * NO_BLOCK", so a caller reading only the mode cannot tell them apart — which is
 * precisely the conflation that broke the financial-year reseed above.
 */
async function readSubscriptionLockoutPolicy(): Promise<{
  xeroModuleEnabled: boolean;
  mode: SubscriptionLockoutMode;
}> {
  const flags = await loadEffectiveModuleFlags();
  if (!flags.xeroIntegration) {
    return { xeroModuleEnabled: false, mode: "NO_BLOCK" };
  }
  return {
    xeroModuleEnabled: true,
    mode: (await loadMembershipLockoutSettings()).mode,
  };
}

/**
 * The same answer WITHOUT reseeding the financial-year cache.
 *
 * For callers that already hold the season year they are asking about — above
 * all the pricing gate in `membership-type-policy.ts`, which is handed
 * `seasonYear` by whoever called it. The distinction is not micro-optimisation:
 * `refreshFinancialYearConfig` can reach Xero for the organisation's accounting
 * year when no admin override is set, and the pricing gate runs INSIDE booking
 * transactions that hold the per-lodge capacity lock. A provider call in there
 * is the one thing the booking rules forbid outright, so the in-transaction
 * reader must not be able to make one.
 *
 * THIS IS THE FALLBACK, NOT THE PREFERRED READ. A caller inside a booking
 * transaction should be HANDED the mode its request already resolved (see
 * `resolveGuestRateMembershipTypes`'s `subscriptionLockoutMode`), for two
 * reasons: two independent reads in one request can disagree if an admin saves
 * the panel mid-request, and each read here checks out a second pool connection
 * underneath the per-lodge capacity lock, which is the pool-starvation shape
 * `docs/CONCURRENCY_AND_LOCKING.md` forbids.
 */
export async function peekSubscriptionLockoutMode(): Promise<SubscriptionLockoutMode> {
  return (await readSubscriptionLockoutPolicy()).mode;
}

/**
 * THE SAME MODE, WITH NO SWALLOWED FAILURE ANYWHERE UNDER IT — for evidence.
 *
 * `peekSubscriptionLockoutMode` reads through two functions that each turn a
 * database failure into a safe-looking default: `loadEffectiveModuleFlags` returns
 * "every optional module off", and `loadPersistedMembershipLockoutSettings` returns
 * null for any error at all. Composed, a single transient failure on a cold cache
 * yields `NO_BLOCK` — "the club does not block unfinancial members" — which is a
 * confident answer about the club's policy that nobody observed.
 *
 * For AI Diagnostics that is the difference between an explanation and a fabricated
 * one: the lockout mode is the qualifier on every subscription finding the pack
 * makes. This composes the STRICT readers instead, so a failure propagates and the
 * tool reports `evidence_unavailable` (`INV-LOCKOUT-009`..`INV-LOCKOUT-011`).
 *
 * It does NOT reseed the financial-year cache, exactly as the peek does not: a
 * read-only evidence path must not change what other requests in this process
 * compute, and the reseed can reach Xero.
 */
export async function peekSubscriptionLockoutModeStrict(
  /**
   * A caller inside a bounded read-only transaction MUST pass it, so both rows are
   * read under that transaction's snapshot and its statement timeout rather than on
   * a second connection outside both.
   */
  db: StrictLockoutModeDb = prisma,
): Promise<SubscriptionLockoutMode> {
  const flags = await loadEffectiveModuleFlagsStrict(db);
  if (!flags.xeroIntegration) return "NO_BLOCK";
  return (await loadMembershipLockoutSettingsStrict(db)).mode;
}

/**
 * Whether the season subscription gate applies at all.
 *
 * TRUE for both enforcing modes — HARD_BLOCK and NON_MEMBER_PRICING — because
 * both need the same underlying fact ("this member owes a paid subscription for
 * the season"); they differ only in what they DO with it. Keeping this predicate
 * mode-blind is what lets `requiresPaidSubscriptionForMemberForBooking` stay the
 * one gate both regimes are computed from.
 */
export async function isSubscriptionEnforcementActive(): Promise<boolean> {
  return (await resolveSubscriptionLockoutMode()) !== "NO_BLOCK";
}

/**
 * Booking-time subscription gate: the age-tier rule applies only while the
 * Xero module is effectively enabled. Booking-time policy check sites use
 * this instead of the raw age-tier rule so the Xero-off bypass is consistent.
 */
export async function requiresPaidSubscriptionForBooking(
  ageTier: AgeTier | null | undefined
): Promise<boolean> {
  if (!(await isSubscriptionEnforcementActive())) {
    return false;
  }
  return requiresPaidSubscriptionForAgeTierFromSettings(ageTier);
}
