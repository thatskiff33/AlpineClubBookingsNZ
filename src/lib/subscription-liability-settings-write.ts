import type { Prisma, PrismaClient } from "@prisma/client";

import logger from "@/lib/logger";
import { isSingletonUpsertContention } from "@/lib/prisma-errors";

import {
  hasAdminAreaAccess,
  type AdminAccessRequirement,
} from "@/lib/admin-permissions";

import {
  clearStaleNotRequiredRows,
  type StaleNotRequiredClearUp,
} from "@/lib/member-subscription-defaults";
import { MEMBERSHIP_LOCKOUT_SETTINGS_ID } from "@/lib/membership-lockout-settings";
import {
  hasChosenLiabilityRule,
  isChoosableLiabilityAgeSource,
  type SubscriptionLiabilitySettings,
} from "@/lib/policies/subscription";
import {
  SUBSCRIPTION_BILLING_SEASON_WAITER_TIMEOUT_MS,
  lockSubscriptionBillingSeason,
} from "@/lib/subscription-billing-season-lock";

/** The liability answers a settings save may name; either may be omitted. */
type RequestedLiability = Partial<SubscriptionLiabilitySettings>;

/**
 * Why a save's liability answers are refused, or null when they may be saved
 * (#5190, `INV-CONFIG-009`). The pair is one decision, so it is sent whole: a
 * half-choice would leave the club on a rule nobody chose. A club cannot be
 * moved back to `NOT_CHOSEN` — that state exists only so an upgrade changes
 * nobody silently — though a club still on it may save it unchanged.
 * `CURRENT_AGE` waits for part-season invoices (#5190's third pull request), so
 * it is refused until then.
 */
function liabilityChoiceError(
  requested: RequestedLiability,
  stored: SubscriptionLiabilitySettings,
): string | null {
  const { requiredTypeAgeRule, liabilityAgeSource } = requested;
  if (requiredTypeAgeRule === undefined && liabilityAgeSource === undefined) {
    return null;
  }
  if (requiredTypeAgeRule === undefined || liabilityAgeSource === undefined) {
    return "Choose both subscription liability answers together.";
  }
  const unchangedNotChosen =
    requiredTypeAgeRule === "NOT_CHOSEN" &&
    liabilityAgeSource === "NOT_CHOSEN" &&
    !hasChosenLiabilityRule(stored);
  if (unchangedNotChosen) {
    return null;
  }
  if (requiredTypeAgeRule === "NOT_CHOSEN" || liabilityAgeSource === "NOT_CHOSEN") {
    return "Choose both subscription liability answers; a chosen rule cannot be returned to not chosen.";
  }
  if (!isChoosableLiabilityAgeSource(liabilityAgeSource)) {
    return "Age today cannot be chosen yet: it needs part-season subscription invoices.";
  }
  return null;
}

/**
 * Who may choose the liability rule (#5190, owner decision 23 Nov 2026,
 * https://github.com/thatskiff33/AlpineClubBookingsNZ/issues/5190#issuecomment-7088835754):
 * membership edit AND finance edit, because the choice changes who the billing
 * run invoices. Other lockout settings keep membership edit alone.
 */
const LIABILITY_RULE_CHOICE_PERMISSIONS = [
  { area: "membership", level: "edit" },
  { area: "finance", level: "edit" },
] as const satisfies readonly AdminAccessRequirement[];

/** Whether `user` holds every {@link LIABILITY_RULE_CHOICE_PERMISSIONS}. */
function mayChooseLiabilityRule(
  user: Parameters<typeof hasAdminAreaAccess>[0],
): boolean {
  return LIABILITY_RULE_CHOICE_PERMISSIONS.every((requirement) =>
    hasAdminAreaAccess(user, requirement),
  );
}

/**
 * Whether a save names a liability answer that differs from the stored one,
 * valid or not, so the permission check fails closed before
 * {@link liabilityChoiceError} judges it. An unchanged echo of the stored pair
 * is not a change.
 */
function namesLiabilityRuleChange(
  requested: RequestedLiability,
  stored: SubscriptionLiabilitySettings,
): boolean {
  return (
    (requested.requiredTypeAgeRule !== undefined &&
      requested.requiredTypeAgeRule !== stored.requiredTypeAgeRule) ||
    (requested.liabilityAgeSource !== undefined &&
      requested.liabilityAgeSource !== stored.liabilityAgeSource)
  );
}

/**
 * Why the settings `PUT` refuses a save's liability answers, as the status and
 * message to answer with, or null when they may be saved: a rule change by a
 * caller without {@link LIABILITY_RULE_CHOICE_PERMISSIONS} (403, checked first
 * so it fails closed), then {@link liabilityChoiceError} (400).
 */
export function liabilityChoiceRefusal(
  requested: RequestedLiability,
  stored: SubscriptionLiabilitySettings,
  user: Parameters<typeof hasAdminAreaAccess>[0],
): { status: 400 | 403; error: string } | null {
  if (namesLiabilityRuleChange(requested, stored) && !mayChooseLiabilityRule(user)) {
    return {
      status: 403,
      error:
        "Choosing the subscription liability rule needs both Membership edit and Finance edit access.",
    };
  }
  const error = liabilityChoiceError(requested, stored);
  return error === null ? null : { status: 400, error };
}

/**
 * The pair a save writes, or null to leave both columns out of the write. Only a
 * real change to a chosen rule is written: omitted, an unchanged `NOT_CHOSEN`,
 * or an echo of the `stored` pair, the columns are not re-written from an
 * earlier read. So a save racing an opt-in can never put the club back on
 * `NOT_CHOSEN`, and a save whose permission check passed only because it
 * echoed `stored` (a membership-only admin) can never write back a rule that a
 * membership and finance admin changed after that read (#5190 review; owner
 * decision 23 Nov 2026). Call after {@link liabilityChoiceRefusal}, with the
 * same `stored`.
 */
export function liabilityChoiceToWrite(
  requested: RequestedLiability,
  stored: SubscriptionLiabilitySettings,
): SubscriptionLiabilitySettings | null {
  const { requiredTypeAgeRule, liabilityAgeSource } = requested;
  return requiredTypeAgeRule !== undefined &&
    liabilityAgeSource !== undefined &&
    namesLiabilityRuleChange(requested, stored) &&
    hasChosenLiabilityRule({ requiredTypeAgeRule, liabilityAgeSource })
    ? { requiredTypeAgeRule, liabilityAgeSource }
    : null;
}

/**
 * Upsert the lockout settings row. A save that leaves the club on a chosen
 * liability rule also clears the season's stale `NOT_REQUIRED` rows, in ONE
 * transaction under the billing season key (season lock -> settings ->
 * clear-up, which takes the liability-rule key itself), so a billing confirm
 * sees the rule and the rows from before the save or after it, never half of
 * each, and a seasonal-assignment reconcile runs wholly before or after the
 * clear-up. The caller resolves the club's
 * `seasonYear` before the transaction opens. `clearedStaleRows` is null when no
 * clear-up ran.
 */
export async function saveLockoutSettings(
  db: PrismaClient,
  input: {
    /** Plain column values, valid for both the create and the update. */
    data: Omit<Prisma.MembershipLockoutSettingsUncheckedCreateInput, "id">;
    liabilityAfterSave: SubscriptionLiabilitySettings;
    seasonYear: number;
  },
) {
  const upsert = {
    where: { id: MEMBERSHIP_LOCKOUT_SETTINGS_ID },
    create: { id: MEMBERSHIP_LOCKOUT_SETTINGS_ID, ...input.data },
    update: input.data,
  };
  if (!hasChosenLiabilityRule(input.liabilityAfterSave)) {
    return {
      record: await db.membershipLockoutSettings.upsert(upsert),
      clearedStaleRows: null as StaleNotRequiredClearUp | null,
    };
  }
  const { seasonYear } = input;
  return db.$transaction(async (tx) => {
    await lockSubscriptionBillingSeason(tx, seasonYear);
    // No liability-rule key here (#5190 review): the upsert may wait on the
    // settings row behind a config import's transaction, and holding the rule
    // key through that wait would queue every reconcile (a `lock(1)` holder)
    // behind it. The clear-up takes the rule key exclusive itself, before it
    // reads the rule this upsert wrote.
    const record = await tx.membershipLockoutSettings.upsert(upsert);
    const clearedStaleRows: StaleNotRequiredClearUp | null =
      await clearStaleNotRequiredRows(tx, seasonYear);
    return { record, clearedStaleRows };
  }, {
    // The season key may be held by a billing confirm for its whole budget.
    timeout: SUBSCRIPTION_BILLING_SEASON_WAITER_TIMEOUT_MS,
  });
}

/**
 * {@link saveLockoutSettings}, answering lock contention with null so the
 * route can say "busy, try again" (503) instead of a 500. Anything else throws.
 */
export async function saveLockoutSettingsUnlessBusy(
  db: PrismaClient,
  input: Parameters<typeof saveLockoutSettings>[1],
): Promise<Awaited<ReturnType<typeof saveLockoutSettings>> | null> {
  try {
    return await saveLockoutSettings(db, input);
  } catch (error) {
    // P2002 counts as contention for this writer: the save writes the
    // constant-id settings row (whose create arm loses to a concurrent save's
    // create) and, in its transaction, only status updates to season rows,
    // which no unique constraint covers. P2028/P2034: the transaction waited
    // out its budget on the season key or the settings row, or deadlocked. In
    // every case nothing was committed, so the caller may simply retry.
    if (!isSingletonUpsertContention(error)) throw error;
    logger.warn({ err: error }, "Membership lockout settings save hit write contention");
    return null;
  }
}
