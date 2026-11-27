import { NextRequest, NextResponse } from "next/server";
import { parseJsonRequestBody } from "@/lib/api-json";
import { getAuditRequestContext } from "@/lib/audit";
import { bulkSaveSubscriptionCategory } from "@/lib/bulk-subscription-category-assignments";
import { requireAdmin } from "@/lib/session-guards";
import { bulkSubscriptionCategorySaveSchema } from "./schema";

/** #5248: set or clear the subscription category of many members for one season. */
export async function POST(request: NextRequest) {
  const guard = await requireAdmin({
    permission: { area: "membership", level: "edit" },
  });
  if (!guard.ok) return guard.response;

  const read = await parseJsonRequestBody(request);

  if (!read.ok) return read.response;

  const body = read.body;

  const parsed = bulkSubscriptionCategorySaveSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const result = await bulkSaveSubscriptionCategory({
    ids: parsed.data.ids,
    seasonYear: parsed.data.seasonYear,
    subscriptionCategoryId: parsed.data.subscriptionCategoryId,
    adminMemberId: guard.session.user.id,
    reason: parsed.data.reason,
    previewTokens: parsed.data.previewTokens,
    request: getAuditRequestContext(request),
  });

  return NextResponse.json(result.body, result.init);
}
