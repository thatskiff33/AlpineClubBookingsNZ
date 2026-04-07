import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { suggestFamilyGroups, createFamilyGroupFromSuggestion } from "@/lib/family-suggestions";
import { logAudit } from "@/lib/audit";
import logger from "@/lib/logger";

/**
 * GET /api/admin/family-suggestions
 * Returns suggested family groups based on ungrouped member analysis.
 */
export async function GET() {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

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
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

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
      memberId: session.user.id,
      targetId: result.groupId,
      details: JSON.stringify({ name, memberCount: result.memberCount, memberIds }),
    });

    return NextResponse.json(
      { message: `Family group "${name}" created with ${result.memberCount} members.`, groupId: result.groupId },
      { status: 201 }
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to create group";
    logger.error({ err, name, memberIds }, "Failed to create family group from suggestion");
    return NextResponse.json({ error: message }, { status: 422 });
  }
}
