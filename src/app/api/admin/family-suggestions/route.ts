import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { parseJsonRequestBody } from "@/lib/api-json";
import { requireAdmin } from "@/lib/session-guards";
import {
  createFamilyGroupFromSuggestion,
  FamilySuggestionError,
  suggestFamilyGroups,
} from "@/lib/family-suggestions";
import { logAudit } from "@/lib/audit";
import logger from "@/lib/logger";

/**
 * GET /api/admin/family-suggestions
 * Returns suggested family groups based on ungrouped member analysis.
 */
export async function GET() {
  const guard = await requireAdmin({
    permission: { area: "membership", level: "view" },
  });
  if (!guard.ok) return guard.response;
  try {
    const result = await suggestFamilyGroups();
    return NextResponse.json(result);
  } catch (err) {
    logger.error({ err }, "Failed to generate family group suggestions");
    return NextResponse.json(
      { error: "Failed to generate suggestions" },
      { status: 500 }
    );
  }
}

const createGroupSchema = z.object({
  name: z.string().min(1, "Group name required").max(100),
  memberIds: z.array(z.string().min(1)).min(2, "At least 2 members required"),
});

/**
 * POST /api/admin/family-suggestions
 * Create a family group from a suggestion.
 */
export async function POST(req: NextRequest) {
  const guard = await requireAdmin({
    permission: { area: "membership", level: "edit" },
  });
  if (!guard.ok) return guard.response;
  const session = guard.session;
  const jsonBody = await parseJsonRequestBody(req, { error: "Invalid JSON" });
  if (!jsonBody.ok) return jsonBody.response;
  const body = jsonBody.body;

  const parsed = createGroupSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", details: parsed.error.flatten().fieldErrors },
      { status: 422 }
    );
  }

  const { name, memberIds } = parsed.data;

  try {
    const result = await createFamilyGroupFromSuggestion(name, memberIds);

    logAudit({
      action: "FAMILY_GROUP_CREATED_FROM_SUGGESTION",
      category: "family",
      memberId: session.user.id,
      targetId: result.groupId,
      entityType: "FamilyGroup",
      entityId: result.groupId,
      details: JSON.stringify({ name, memberCount: result.memberCount, memberIds }),
    });

    return NextResponse.json(
      { message: `Family group "${name}" created with ${result.memberCount} members.`, groupId: result.groupId },
      { status: 201 }
    );
  } catch (err) {
    // INV-PRIV-011 (#2683): the suggested group `name` is a family surname, so
    // it is logged as its length only — enough to tell a validation failure
    // from an empty or absurd value without naming the household. `memberIds`
    // are cuids, which identify the rows that failed. Nothing was created on
    // this path, so there is no audit row and nothing is lost by leaving the
    // name out: the admin sees it on screen in the request they just made.
    logger.error(
      { err, nameLength: name.length, memberIds },
      "Failed to create family group from suggestion"
    );
    if (err instanceof FamilySuggestionError) {
      return NextResponse.json({ error: err.message }, { status: 422 });
    }
    return NextResponse.json({ error: "Failed to create group" }, { status: 500 });
  }
}
