import {
  isChoosableLiabilityAgeSource,
  isSubscriptionLiabilityAgeSource,
  isSubscriptionRequiredTypeAgeRule,
} from "@/lib/policies/subscription";

/**
 * The `membership-lockout-settings` singleton's bundle-format rules, kept beside
 * its spec in `club-settings.ts` (which explains each): a pre-#2543 bundle's
 * `enabled` key, and the #5190 subscription-liability pair.
 */

/** The spec's `reconcile` hook: both bundle-format rules, in order. */
export function reconcileMembershipLockoutBundle(
  incoming: Record<string, unknown>,
): Record<string, unknown> {
  return reconcileLiabilityPair(reconcileLockoutMode(incoming));
}

/**
 * `liabilityAgeSource`'s validator. `CURRENT_AGE` needs part-season invoices,
 * which have not shipped, so a bundle naming it fails the dry-run exactly as the
 * admin route refuses it. A validator owns the whole check, so the enum test is
 * here too.
 */
export function validateLiabilityAgeSource(value: unknown): string | null {
  if (!isSubscriptionLiabilityAgeSource(value)) {
    return `${JSON.stringify(value)} is not a valid SubscriptionLiabilityAgeSource`;
  }
  return value === "NOT_CHOSEN" || isChoosableLiabilityAgeSource(value)
    ? null
    : `${value} cannot be chosen yet: it needs part-season invoices (#5190)`;
}

/** `mode` from a pre-#2543 bundle's `enabled` key (#2543/#2561); see the spec. */
function reconcileLockoutMode(
  incoming: Record<string, unknown>,
): Record<string, unknown> {
  const stated = "mode" in incoming && incoming.mode !== null;
  if (stated) {
    return incoming;
  }
  if (typeof incoming.enabled === "boolean") {
    return {
      ...incoming,
      mode: incoming.enabled ? "HARD_BLOCK" : "NO_BLOCK",
    };
  }
  // `mode` is absent or null with nothing to derive from. Absent means "this
  // bundle says nothing about the policy", which merge mode honours by leaving
  // the target's own mode alone; a present null is a broken file, and
  // `constraints.mode.required` above fails the dry-run on it.
  return incoming;
}

/** The #5190 liability pair travels whole and chosen, or not at all; see the spec. */
function reconcileLiabilityPair(
  incoming: Record<string, unknown>,
): Record<string, unknown> {
  const rule = incoming.requiredTypeAgeRule;
  const source = incoming.liabilityAgeSource;
  // Anything the loop must refuse (null, a non-string, an unknown value) stays.
  if (
    ("requiredTypeAgeRule" in incoming && !isSubscriptionRequiredTypeAgeRule(rule)) ||
    ("liabilityAgeSource" in incoming && !isSubscriptionLiabilityAgeSource(source))
  ) {
    return incoming;
  }
  if (
    isSubscriptionRequiredTypeAgeRule(rule) && rule !== "NOT_CHOSEN" &&
    isSubscriptionLiabilityAgeSource(source) && source !== "NOT_CHOSEN"
  ) {
    return incoming;
  }
  const rest = { ...incoming };
  delete rest.requiredTypeAgeRule;
  delete rest.liabilityAgeSource;
  return rest;
}
