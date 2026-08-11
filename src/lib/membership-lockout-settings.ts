import type { PrismaClient } from "@prisma/client";

import { DEFAULT_MEMBERSHIP_LOCKOUT_SETTINGS } from "@/config/club-settings-defaults";
import { prisma } from "@/lib/prisma";

// Admin-configurable settings for the booking lockout that blocks members with
// an unpaid annual subscription. Single-row table (id = "default"), same
// pattern as membership-nomination-settings.ts.
export const MEMBERSHIP_LOCKOUT_SETTINGS_ID = "default";

/**
 * The three answers a club can give about a member whose season subscription is
 * required but unpaid (#2543). Mirrors the Prisma `SubscriptionLockoutMode`
 * enum without importing it, so the pure policy modules and the settings layer
 * can name one type.
 */
export type SubscriptionLockoutMode =
  | "NO_BLOCK"
  | "HARD_BLOCK"
  | "NON_MEMBER_PRICING";

export const SUBSCRIPTION_LOCKOUT_MODES = [
  "NO_BLOCK",
  "HARD_BLOCK",
  "NON_MEMBER_PRICING",
] as const satisfies readonly SubscriptionLockoutMode[];

export function isSubscriptionLockoutMode(
  value: unknown,
): value is SubscriptionLockoutMode {
  return (
    typeof value === "string" &&
    (SUBSCRIPTION_LOCKOUT_MODES as readonly string[]).includes(value)
  );
}

export interface MembershipLockoutSettings {
  /**
   * How an unpaid member is treated at booking time (#2543):
   *  - `NO_BLOCK` — no subscription gate at all;
   *  - `HARD_BLOCK` — refuse the booking (the pre-#2543 `enabled: true`);
   *  - `NON_MEMBER_PRICING` — allow it, price the unpaid member at non-member
   *    rates, and require a paid-up adult member on the booking.
   */
  mode: SubscriptionLockoutMode;
  /**
   * Membership financial year-end month (1-12), or null to follow the connected
   * Xero organisation's accounting financial year.
   */
  financialYearEndMonthOverride: number | null;
  /**
   * When true, an invoice whose reference/description text reads like a
   * membership subscription also counts during detection, in addition to the
   * configured account/item code.
   */
  textFallbackEnabled: boolean;
  /**
   * When true (#2109), paid detection matches ANY item code stamped on the fee
   * schedule (distinct `MembershipAnnualFeeComponent.xeroItemCode`) in addition
   * to the single configured subscription item code. Default false reproduces
   * the single-code behaviour byte-for-byte.
   */
  useFeeScheduleItemCodes: boolean;
}

export interface PersistedMembershipLockoutSettings {
  /**
   * The stored mode. NOT NULL in the database since #2561 backfilled it and
   * dropped the legacy boolean, so a null here means only one thing: no settings
   * row exists at all. Typed loosely (`string`) because config-transfer hands this
   * shape a value straight out of a bundle file, which may be hand-edited;
   * `coerceLockoutMode` refuses anything outside the closed vocabulary.
   */
  mode?: SubscriptionLockoutMode | string | null;
  financialYearEndMonthOverride: number | null;
  textFallbackEnabled: boolean | null;
  useFeeScheduleItemCodes: boolean | null;
  updatedByMemberId?: string | null;
  createdAt?: Date | string | null;
  updatedAt?: Date | string | null;
}

function getDefaultMembershipLockoutSettings(): MembershipLockoutSettings {
  return { ...DEFAULT_MEMBERSHIP_LOCKOUT_SETTINGS };
}

function coerceYearEndOverride(
  value: number | null | undefined,
): number | null {
  if (value == null || typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  const rounded = Math.round(value);
  return rounded >= 1 && rounded <= 12 ? rounded : null;
}

/**
 * Resolve the stored three-way mode (#2543).
 *
 * `mode` is MANDATORY in the database (#2561 backfilled it from the legacy
 * `enabled` boolean and dropped that column in the same release), so there is no
 * fallback ladder any more: a recognised value wins, and the default answers the
 * only two cases left.
 *
 *  1. a recognised `mode` — every settings row has one;
 *  2. otherwise the default, HARD_BLOCK. Reached when there is NO ROW at all (a
 *     fresh install before an admin has saved the panel), or when the value did
 *     not survive validation.
 *
 * An unrecognised `mode` string is NOT trusted — a config bundle is a file an
 * operator can hand-edit, and a fourth policy invented there would be read by
 * every booking gate. It falls back to HARD_BLOCK, which refuses rather than
 * relaxes, so a malformed value cannot quietly open the gate.
 */
function coerceLockoutMode(
  persisted: Partial<PersistedMembershipLockoutSettings> | null | undefined,
  fallback: SubscriptionLockoutMode,
): SubscriptionLockoutMode {
  if (isSubscriptionLockoutMode(persisted?.mode)) {
    return persisted.mode;
  }
  return fallback;
}

export function normalizeMembershipLockoutSettings(
  persisted?: Partial<PersistedMembershipLockoutSettings> | null,
): MembershipLockoutSettings {
  const defaults = getDefaultMembershipLockoutSettings();
  return {
    mode: coerceLockoutMode(persisted, defaults.mode),
    financialYearEndMonthOverride: coerceYearEndOverride(
      persisted?.financialYearEndMonthOverride,
    ),
    textFallbackEnabled:
      persisted?.textFallbackEnabled ?? defaults.textFallbackEnabled,
    useFeeScheduleItemCodes:
      persisted?.useFeeScheduleItemCodes ?? defaults.useFeeScheduleItemCodes,
  };
}

export async function loadPersistedMembershipLockoutSettings(): Promise<PersistedMembershipLockoutSettings | null> {
  try {
    return await prisma.membershipLockoutSettings.findUnique({
      where: { id: MEMBERSHIP_LOCKOUT_SETTINGS_ID },
    });
  } catch {
    // Table may not exist yet (migration not applied); fall back to defaults.
    return null;
  }
}

export async function loadMembershipLockoutSettings(): Promise<MembershipLockoutSettings> {
  return normalizeMembershipLockoutSettings(
    await loadPersistedMembershipLockoutSettings(),
  );
}

/**
 * THE SAME SETTINGS, WITHOUT THE FALLBACK — for evidence, not for product paths.
 *
 * `loadPersistedMembershipLockoutSettings` above treats EVERY database error as the
 * migration-era missing table and returns null, which the normalizer then turns into
 * the documented defaults. That is right for a product path during a deploy.
 *
 * IT IS WRONG FOR AN EVIDENCE PATH: the default mode is `HARD_BLOCK`'s opposite
 * number in whichever direction the club is not configured, and a diagnostic that
 * reports a club's lockout mode from a failed read has invented the most important
 * qualifier on its own answer. A rejected read propagates here so the caller can
 * report `evidence_unavailable`.
 *
 * A genuinely ABSENT singleton row still normalizes to the documented defaults,
 * which is what actually governs a club that has never saved the panel.
 */
export async function loadMembershipLockoutSettingsStrict(
  db: Pick<PrismaClient, "membershipLockoutSettings"> = prisma,
): Promise<MembershipLockoutSettings> {
  return normalizeMembershipLockoutSettings(
    await db.membershipLockoutSettings.findUnique({
      where: { id: MEMBERSHIP_LOCKOUT_SETTINGS_ID },
    }),
  );
}
