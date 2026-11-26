import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/session-guards";
import { resetHiddenFamilySuggestions } from "@/lib/family-suggestions";
import { logAudit } from "@/lib/audit";
import logger from "@/lib/logger";
import { connectionJson } from "@/lib/mcp-connection-request";
import { FAMILY_SUGGESTIONS_RESET_CONNECTION_SHAPE } from "@/lib/connection-shapes/membership-family-groups";

/**
 * POST /api/admin/family-suggestions/reset
 * Clears all globally hidden family suggestions.
 */
export async function POST(request: Request) {
  const guard = await requireAdmin({
    permission: { area: "membership", level: "edit" },
  });
  if (!guard.ok) return guard.response;

  try {
    const result = await resetHiddenFamilySuggestions();

    logAudit({
      action: "FAMILY_SUGGESTIONS_RESET",
      memberId: guard.session.user.id,
      entityType: "HiddenFamilySuggestion",
      category: "admin",
      outcome: "success",
      summary: "Hidden family suggestions reset",
      metadata: {
        deletedCount: result.count,
      },
    });

    return connectionJson(
      request,
      { message: "Hidden family suggestions reset.", deletedCount: result.count },
      FAMILY_SUGGESTIONS_RESET_CONNECTION_SHAPE,
    );
  } catch (err) {
    logger.error({ err }, "Failed to reset hidden family suggestions");
    return NextResponse.json(
      { error: "Failed to reset hidden family suggestions" },
      { status: 500 }
    );
  }
}
