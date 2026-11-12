import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getAuditRequestContext } from "@/lib/audit";
import { saveSeasonalMembershipAssignment } from "@/lib/seasonal-membership-assignments";
import { requireAdmin } from "@/lib/session-guards";
import { dateOnlyStringSchema } from "@/lib/date-only-schema";

const paramsSchema = z.object({
  id: z.string().min(1),
});

const saveSchema = z
  .object({
    seasonYear: z.number().int().min(2020).max(2040),
    membershipTypeId: z.string().min(1),
    applyFrom: dateOnlyStringSchema
      .nullable()
      .optional(),
    reason: z.string().trim().min(1).max(1000),
    previewToken: z.string().min(1),
  })
  .strict();

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = await requireAdmin({
    permission: { area: "membership", level: "edit" },
  });
  if (!guard.ok) return guard.response;

  const parsedParams = paramsSchema.safeParse(await params);
  if (!parsedParams.success) {
    return NextResponse.json(
      { error: "Invalid route parameters", details: parsedParams.error.flatten() },
      { status: 400 },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsedBody = saveSchema.safeParse(body);
  if (!parsedBody.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsedBody.error.flatten() },
      { status: 400 },
    );
  }

  const result = await saveSeasonalMembershipAssignment({
    memberId: parsedParams.data.id,
    adminMemberId: guard.session.user.id,
    seasonYear: parsedBody.data.seasonYear,
    membershipTypeId: parsedBody.data.membershipTypeId,
    applyFrom: parsedBody.data.applyFrom ?? null,
    reason: parsedBody.data.reason,
    previewToken: parsedBody.data.previewToken,
    request: getAuditRequestContext(request),
  });

  return NextResponse.json(result.body, result.init);
}
