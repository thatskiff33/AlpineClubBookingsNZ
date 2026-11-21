import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { hasAdminAreaAccess } from "@/lib/admin-permissions";
import {
  buildStructuredAuditLogCreateArgs,
  getAuditRequestContext,
} from "@/lib/audit";
import {
  getFinancialYearResolution,
  refreshFinancialYearConfig,
} from "@/lib/financial-year-server";
import {
  MEMBERSHIP_LOCKOUT_SETTINGS_ID,
  SUBSCRIPTION_LOCKOUT_MODES,
  loadPersistedMembershipLockoutSettings,
  normalizeMembershipLockoutSettings,
} from "@/lib/membership-lockout-settings";
import {
  getNonSubscriptionFeeItemCodes,
  getSubscriptionItemCodes,
} from "@/lib/xero-mappings";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/session-guards";
import { clubTimeZone } from "@/lib/club-time/server";
import { clubSeasonYear } from "@/lib/financial-year";
import { clearStaleNotRequiredRows } from "@/lib/member-subscription-defaults";
import {
  SUBSCRIPTION_LIABILITY_AGE_SOURCES,
  SUBSCRIPTION_REQUIRED_TYPE_AGE_RULES,
  hasChosenLiabilityRule,
  isChoosableLiabilityAgeSource,
  type SubscriptionLiabilitySettings,
} from "@/lib/policies/subscription";
import { lockSubscriptionBillingSeason } from "@/lib/subscription-billing-season-lock";

const settingsSchema = z
  .object({
    /**
     * #2543 — the three-way lockout policy replaced the old `enabled` boolean,
     * which no longer exists as a column (#2561).
     *
     * Deliberately still `.strict()`, so an old client that sends the boolean is
     * REFUSED rather than silently ignored. A silent ignore is the dangerous
     * direction here — an admin would see their "turn the lockout off" click
     * succeed while the club carried on hard-blocking members.
     */
    mode: z.enum(SUBSCRIPTION_LOCKOUT_MODES).optional(),
    financialYearEndMonthOverride: z
      .number()
      .int()
      .min(1)
      .max(12)
      .nullable()
      .optional(),
    textFallbackEnabled: z.boolean().optional(),
    useFeeScheduleItemCodes: z.boolean().optional(),
    /**
     * #5190 — the club's subscription-liability rule, two answers chosen
     * together. Omitted, the stored pair is preserved. See
     * `liabilityChoiceError` for what a save may and may not do with them.
     */
    requiredTypeAgeRule: z.enum(SUBSCRIPTION_REQUIRED_TYPE_AGE_RULES).optional(),
    liabilityAgeSource: z.enum(SUBSCRIPTION_LIABILITY_AGE_SOURCES).optional(),
  })
  .strict();

type SettingsInput = z.infer<typeof settingsSchema>;

/**
 * Why a save's liability answers are refused, or null when they may be saved
 * (#5190, `INV-CONFIG-008`). The pair is one decision, so it is sent whole: a
 * half-choice would leave the club on a rule nobody chose. A club cannot be
 * moved back to `NOT_CHOSEN` — that state exists only so an upgrade changes
 * nobody silently — though a club still on it may save it unchanged.
 * `CURRENT_AGE` waits for part-season invoices (#5190's third pull request), so
 * it is refused until then.
 */
function liabilityChoiceError(
  input: SettingsInput,
  stored: SubscriptionLiabilitySettings,
): string | null {
  const { requiredTypeAgeRule, liabilityAgeSource } = input;
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
 * Compute the fee-schedule detection preview (#2109): the resolved item-code set
 * paid detection would match under look-through, plus the subset of those codes
 * that also identify a non-subscription fee (hut/joining/promo) — an overlap
 * that would let an unpaid fee invoice masquerade as a subscription in the
 * widened set, surfaced as a settings warning.
 */
async function buildFeeScheduleItemCodePreview(): Promise<{
  feeScheduleItemCodes: string[];
  overlappingCodes: string[];
}> {
  const [feeScheduleItemCodes, nonSubscriptionCodes] = await Promise.all([
    getSubscriptionItemCodes(),
    getNonSubscriptionFeeItemCodes(),
  ]);
  const nonSubscriptionSet = new Set(nonSubscriptionCodes);
  const overlappingCodes = feeScheduleItemCodes.filter((code) =>
    nonSubscriptionSet.has(code)
  );
  return { feeScheduleItemCodes, overlappingCodes };
}

/**
 * The fee-schedule code lists are finance-domain data — they enumerate Xero
 * item codes — so the preview is gated on finance VIEW (#2109 FIX-4b). A
 * membership-only admin receives the settings WITHOUT the code lists; the panel
 * hides the finance detection card for them and defaults the absent fields to
 * `[]`, so omitting the keys is safe.
 */
async function buildFeeScheduleItemCodePreviewForViewer(
  user: Parameters<typeof hasAdminAreaAccess>[0]
): Promise<{ feeScheduleItemCodes: string[]; overlappingCodes: string[] } | null> {
  if (!hasAdminAreaAccess(user, { area: "finance", level: "view" })) {
    return null;
  }
  return buildFeeScheduleItemCodePreview();
}

export async function GET() {
  const guard = await requireAdmin({
    permission: { area: "membership", level: "view" },
  });
  if (!guard.ok) return guard.response;

  const persisted = await loadPersistedMembershipLockoutSettings();
  const financialYear = await getFinancialYearResolution();
  const preview = await buildFeeScheduleItemCodePreviewForViewer(
    guard.session.user
  );
  return NextResponse.json({
    settings: normalizeMembershipLockoutSettings(persisted),
    financialYear,
    persisted,
    ...(preview ?? {}),
  });
}

export async function PUT(request: NextRequest) {
  const guard = await requireAdmin({
    permission: { area: "membership", level: "edit" },
  });
  if (!guard.ok) return guard.response;
  const session = guard.session;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = settingsSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const before = await prisma.membershipLockoutSettings.findUnique({
    where: { id: MEMBERSHIP_LOCKOUT_SETTINGS_ID },
  });
  const stored = normalizeMembershipLockoutSettings(before);
  const liabilityError = liabilityChoiceError(parsed.data, stored);
  if (liabilityError) {
    return NextResponse.json({ error: liabilityError }, { status: 400 });
  }

  // #2543. A save that does not name a mode must PRESERVE the stored one, so
  // saving any other field on this panel cannot move the club's booking policy.
  // Routed through `normalizeMembershipLockoutSettings` rather than reading
  // `before.mode` raw so the closed vocabulary is enforced in exactly one place,
  // and so a missing row resolves to the same default the rest of the app sees.
  const mode = parsed.data.mode ?? stored.mode;

  // #5190: the liability pair is written only when the save makes a choice.
  // Omitted (or an unchanged NOT_CHOSEN), the columns are left out of the write
  // altogether rather than re-written from the read above, so a save racing an
  // opt-in can never put the club back on NOT_CHOSEN.
  const { requiredTypeAgeRule, liabilityAgeSource } = parsed.data;
  const liabilityChoice =
    requiredTypeAgeRule !== undefined &&
    liabilityAgeSource !== undefined &&
    hasChosenLiabilityRule({ requiredTypeAgeRule, liabilityAgeSource })
      ? { requiredTypeAgeRule, liabilityAgeSource }
      : null;

  const data = {
    mode,
    financialYearEndMonthOverride:
      parsed.data.financialYearEndMonthOverride !== undefined
        ? parsed.data.financialYearEndMonthOverride
        : (before?.financialYearEndMonthOverride ?? null),
    textFallbackEnabled:
      parsed.data.textFallbackEnabled ?? before?.textFallbackEnabled ?? true,
    useFeeScheduleItemCodes:
      parsed.data.useFeeScheduleItemCodes ??
      before?.useFeeScheduleItemCodes ??
      false,
    ...liabilityChoice,
    updatedByMemberId: session.user.id,
  };
  const liabilityAfterSave: SubscriptionLiabilitySettings = liabilityChoice ?? stored;
  const upsertSettings = {
    where: { id: MEMBERSHIP_LOCKOUT_SETTINGS_ID },
    create: { id: MEMBERSHIP_LOCKOUT_SETTINGS_ID, ...data },
    update: data,
  };

  // #5190: a save that leaves the club on a chosen liability rule also clears
  // the season's stale NOT_REQUIRED rows, in ONE transaction under the billing
  // season key (season lock -> settings -> clear-up), so a billing confirm sees
  // the rule and the rows from before the save or after it, never half of each.
  // The season is resolved before the transaction opens.
  let clearedStaleRows: number | null = null;
  let record;
  if (hasChosenLiabilityRule(liabilityAfterSave)) {
    const seasonYear = clubSeasonYear(await clubTimeZone());
    const saved = await prisma.$transaction(async (tx) => {
      await lockSubscriptionBillingSeason(tx, seasonYear);
      const upserted = await tx.membershipLockoutSettings.upsert(upsertSettings);
      const { clearedCount } = await clearStaleNotRequiredRows(tx, seasonYear);
      return { upserted, clearedCount };
    });
    record = saved.upserted;
    clearedStaleRows = saved.clearedCount;
  } else {
    record = await prisma.membershipLockoutSettings.upsert(upsertSettings);
  }

  // Reseed the financial-year cache so the change takes effect immediately on
  // this instance.
  await refreshFinancialYearConfig();

  await prisma.auditLog.create(
    buildStructuredAuditLogCreateArgs({
      action: "MEMBERSHIP_LOCKOUT_SETTINGS_UPDATED",
      actor: { memberId: session.user.id },
      entity: {
        type: "MembershipLockoutSettings",
        id: MEMBERSHIP_LOCKOUT_SETTINGS_ID,
      },
      category: "admin",
      severity: "important",
      outcome: "success",
      summary: "Membership booking lockout settings updated",
      metadata: {
        previousSettings: before,
        newSettings: data,
        ...(clearedStaleRows === null ? {} : { clearedStaleNotRequiredRows: clearedStaleRows }),
      },
      request: getAuditRequestContext(request),
    })
  );

  const financialYear = await getFinancialYearResolution();
  const preview = await buildFeeScheduleItemCodePreviewForViewer(
    session.user
  );
  return NextResponse.json({
    settings: normalizeMembershipLockoutSettings(record),
    financialYear,
    persisted: record,
    ...(preview ?? {}),
  });
}
