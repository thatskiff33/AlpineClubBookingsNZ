import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getAuditRequestContext } from "@/lib/audit";
import { bulkSaveSeasonalMembershipAssignments } from "@/lib/seasonal-membership-assignments";
import { requireAdmin } from "@/lib/session-guards";
import { dateOnlyStringSchema } from "@/lib/date-only-schema";

const saveSchema = z
  .object({
    ids: z
      .array(z.string().min(1))
      .min(1, "At least one member ID is required")
      .max(100),
    seasonYear: z.number().int().min(2020).max(2040),
    membershipTypeId: z.string().min(1),
    applyFrom: dateOnlyStringSchema
      .nullable()
      .optional(),
    reason: z.string().trim().min(1).max(1000),
    previewTokens: z.record(z.string().min(1), z.string().min(1)),
  })
  .strict();

export async function POST(request: NextRequest) {
  const guard = await requireAdmin({
    permission: { area: "membership", level: "edit" },
  });
  if (!guard.ok) return guard.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = saveSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const result = await bulkSaveSeasonalMembershipAssignments({
    ids: parsed.data.ids,
    seasonYear: parsed.data.seasonYear,
    membershipTypeId: parsed.data.membershipTypeId,
    applyFrom: parsed.data.applyFrom ?? null,
    adminMemberId: guard.session.user.id,
    reason: parsed.data.reason,
    previewTokens: parsed.data.previewTokens,
    request: getAuditRequestContext(request),
  });

  return NextResponse.json(result.body, result.init);
}
