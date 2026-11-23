import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { parseJsonRequestBody } from "@/lib/api-json";
import { requireAdmin } from "@/lib/session-guards";
import {
  FamilySuggestionError,
  hideFamilySuggestion,
} from "@/lib/family-suggestions";
import { logAudit } from "@/lib/audit";
import logger from "@/lib/logger";

const hideSuggestionSchema = z.object({
  memberIds: z.array(z.string().min(1)).min(2, "At least 2 members required"),
});

/**
 * POST /api/admin/family-suggestions/hide
 * Globally hide a suggested family group by its server-canonical member-id set.
 */
export async function POST(req: NextRequest) {
  const guard = await requireAdmin({
    permission: { area: "membership", level: "edit" },
  });
  if (!guard.ok) return guard.response;

  const jsonBody = await parseJsonRequestBody(req, { error: "Invalid JSON" });
  if (!jsonBody.ok) return jsonBody.response;
  const body = jsonBody.body;

  const parsed = hideSuggestionSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", details: parsed.error.flatten().fieldErrors },
      { status: 422 }
    );
  }

  try {
    const result = await hideFamilySuggestion(
      parsed.data.memberIds,
      guard.session.user.id
    );

    logAudit({
      action: "FAMILY_SUGGESTION_HIDDEN",
      memberId: guard.session.user.id,
      targetId: result.signature,
      entityType: "HiddenFamilySuggestion",
      entityId: result.signature,
      category: "admin",
      outcome: "success",
      summary: "Family suggestion permanently hidden",
      metadata: {
        signature: result.signature,
        memberIds: result.memberIds,
        memberCount: result.memberIds.length,
      },
    });

    return NextResponse.json({
      message: "Family suggestion hidden.",
      signature: result.signature,
    });
  } catch (err) {
    logger.error(
      { err, memberIds: parsed.data.memberIds },
      "Failed to hide family suggestion"
    );
    if (err instanceof FamilySuggestionError) {
      return NextResponse.json({ error: err.message }, { status: 422 });
    }
    return NextResponse.json(
      { error: "Failed to hide family suggestion" },
      { status: 500 }
    );
  }
}
