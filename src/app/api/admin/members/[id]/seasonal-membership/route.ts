import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getAuditRequestContext } from "@/lib/audit";
import { saveSeasonalMembershipAssignment } from "@/lib/seasonal-membership-assignments";
import { requireAdmin } from "@/lib/session-guards";

const paramsSchema = z.object({
  id: z.string().min(1),
});

const saveSchema = z
  .object({
    seasonYear: z.number().int().min(2020).max(2040),
    membershipTypeId: z.string().min(1),
    // Subscription-category decoupling: the independent billing axis. An
    // explicit null means "Individual" — unchanged per-type billing.
    // Omitted means "no opinion" — the lib preserves the member's current
    // category rather than clearing it (see saveSeasonalMembershipAssignment's
    // own doc comment); never coerce an omitted value to null here.
    subscriptionCategoryId: z.string().min(1).nullable().optional(),
    applyFrom: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
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
    // NOT `?? null`: an omitted field must stay `undefined` so the lib
    // preserves the member's current category, rather than being coerced into
    // the explicit-clear value a real `null` means.
    subscriptionCategoryId: parsedBody.data.subscriptionCategoryId,
    applyFrom: parsedBody.data.applyFrom ?? null,
    reason: parsedBody.data.reason,
    previewToken: parsedBody.data.previewToken,
    request: getAuditRequestContext(request),
  });

  return NextResponse.json(result.body, result.init);
}
