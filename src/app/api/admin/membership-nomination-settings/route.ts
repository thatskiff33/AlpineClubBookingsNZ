import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { parseJsonRequestBody } from "@/lib/api-json";
import {
  buildStructuredAuditLogCreateArgs,
  getAuditRequestContext,
} from "@/lib/audit";
import {
  MEMBERSHIP_NOMINATION_SETTINGS_ID,
  loadPersistedMembershipNominationSettings,
  normalizeMembershipNominationSettings,
} from "@/lib/membership-nomination-settings";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/session-guards";

const settingsSchema = z
  .object({
    gateEnabled: z.boolean().optional(),
    minimumMembershipMonths: z.number().int().min(0).max(600).optional(),
    minimumNights: z.number().int().min(0).max(3650).optional(),
    requiredSignOffs: z.number().int().min(1).max(10).optional(),
    gateEffectiveFrom: z.string().datetime().nullable().optional(),
  })
  .strict();

export async function GET() {
  const guard = await requireAdmin({
    permission: { area: "membership", level: "view" },
  });
  if (!guard.ok) return guard.response;

  const persisted = await loadPersistedMembershipNominationSettings();
  return NextResponse.json({
    settings: normalizeMembershipNominationSettings(persisted),
    persisted,
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

  const before = await prisma.membershipNominationSettings.findUnique({
    where: { id: MEMBERSHIP_NOMINATION_SETTINGS_ID },
  });

  const willEnable = parsed.data.gateEnabled ?? before?.gateEnabled ?? false;
  let effectiveFrom: Date | null;
  if (parsed.data.gateEffectiveFrom !== undefined) {
    effectiveFrom = parsed.data.gateEffectiveFrom
      ? new Date(parsed.data.gateEffectiveFrom)
      : null;
  } else {
    effectiveFrom = before?.gateEffectiveFrom ?? null;
  }
  // Default the grandfather cutoff to "now" the first time the gate is enabled,
  // so all current members are grandfathered.
  if (willEnable && !effectiveFrom) {
    effectiveFrom = new Date();
  }

  const data = {
    gateEnabled: parsed.data.gateEnabled ?? before?.gateEnabled ?? false,
    minimumMembershipMonths:
      parsed.data.minimumMembershipMonths ?? before?.minimumMembershipMonths ?? 12,
    minimumNights: parsed.data.minimumNights ?? before?.minimumNights ?? 6,
    requiredSignOffs:
      parsed.data.requiredSignOffs ?? before?.requiredSignOffs ?? 2,
    gateEffectiveFrom: effectiveFrom,
    updatedByMemberId: session.user.id,
  };

  const record = await prisma.membershipNominationSettings.upsert({
    where: { id: MEMBERSHIP_NOMINATION_SETTINGS_ID },
    create: { id: MEMBERSHIP_NOMINATION_SETTINGS_ID, ...data },
    update: data,
  });

  await prisma.auditLog.create(
    buildStructuredAuditLogCreateArgs({
      action: "MEMBERSHIP_NOMINATION_SETTINGS_UPDATED",
      actor: { memberId: session.user.id },
      entity: {
        type: "MembershipNominationSettings",
        id: MEMBERSHIP_NOMINATION_SETTINGS_ID,
      },
      category: "admin",
      severity: "important",
      outcome: "success",
      summary: "Membership nomination / induction settings updated",
      metadata: { previousSettings: before, newSettings: data },
      request: getAuditRequestContext(request),
    })
  );

  return NextResponse.json({
    settings: normalizeMembershipNominationSettings(record),
    persisted: record,
  });
}
