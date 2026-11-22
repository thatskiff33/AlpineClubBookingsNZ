import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { hasAdminAreaAccess } from "@/lib/admin-permissions";
import { parseJsonRequestBody } from "@/lib/api-json";
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
  })
  .strict();

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

  const jsonBody = await parseJsonRequestBody(request, {
    error: "Invalid JSON",
  });
  if (!jsonBody.ok) return jsonBody.response;
  const body = jsonBody.body;

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

  // #2543. A save that does not name a mode must PRESERVE the stored one, so
  // saving any other field on this panel cannot move the club's booking policy.
  // Routed through `normalizeMembershipLockoutSettings` rather than reading
  // `before.mode` raw so the closed vocabulary is enforced in exactly one place,
  // and so a missing row resolves to the same default the rest of the app sees.
  const mode = parsed.data.mode ?? normalizeMembershipLockoutSettings(before).mode;

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
    updatedByMemberId: session.user.id,
  };

  const record = await prisma.membershipLockoutSettings.upsert({
    where: { id: MEMBERSHIP_LOCKOUT_SETTINGS_ID },
    create: { id: MEMBERSHIP_LOCKOUT_SETTINGS_ID, ...data },
    update: data,
  });

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
      metadata: { previousSettings: before, newSettings: data },
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
