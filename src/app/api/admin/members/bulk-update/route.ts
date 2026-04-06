import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import logger from "@/lib/logger";

const bulkUpdateSchema = z.object({
  ids: z.array(z.string()).min(1, "At least one member ID is required").max(100),
  action: z.enum(["deactivate", "reactivate", "set-role"]),
  role: z.enum(["MEMBER", "ADMIN"]).optional(),
}).refine(
  (data) => data.action !== "set-role" || data.role !== undefined,
  { message: "Role is required for set-role action", path: ["role"] }
);

/**
 * POST /api/admin/members/bulk-update
 * Bulk update members (deactivate, reactivate, or change role).
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

  const parsed = bulkUpdateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", details: parsed.error.flatten().fieldErrors },
      { status: 422 }
    );
  }

  const { ids, action, role } = parsed.data;
  const currentUserId = session.user.id;

  // Self-protection checks
  if (action === "deactivate" && ids.includes(currentUserId)) {
    return NextResponse.json(
      { error: "You cannot deactivate your own account" },
      { status: 400 }
    );
  }

  if (action === "set-role" && role === "MEMBER" && ids.includes(currentUserId)) {
    return NextResponse.json(
      { error: "You cannot demote your own admin account" },
      { status: 400 }
    );
  }

  try {
    // Find existing members
    const existingMembers = await prisma.member.findMany({
      where: { id: { in: ids } },
      select: { id: true, firstName: true, lastName: true, email: true },
    });

    const existingIds = new Set(existingMembers.map((m) => m.id));
    const notFound = ids.filter((id) => !existingIds.has(id)).length;

    // Build update data based on action
    let updateData: Record<string, unknown>;
    switch (action) {
      case "deactivate":
        updateData = { active: false };
        break;
      case "reactivate":
        updateData = { active: true };
        break;
      case "set-role":
        updateData = { role: role! };
        break;
      default:
        return NextResponse.json({ error: "Invalid action" }, { status: 400 });
    }

    // Filter out current user for self-protection
    const idsToUpdate = [...existingIds].filter((id) => {
      if (action === "deactivate" && id === currentUserId) return false;
      if (action === "set-role" && role === "MEMBER" && id === currentUserId) return false;
      return true;
    });

    // Perform update in transaction
    const result = await prisma.$transaction(async (tx) => {
      const updateResult = await tx.member.updateMany({
        where: { id: { in: idsToUpdate } },
        data: updateData,
      });
      // Cascade deactivation to dependents
      if (action === "deactivate") {
        await tx.member.updateMany({
          where: { parentMemberId: { in: idsToUpdate } },
          data: { active: false },
        });
      }
      return updateResult;
    });

    // Audit log for each affected member
    for (const member of existingMembers) {
      if (idsToUpdate.includes(member.id)) {
        logAudit({
          action: `member.bulk-${action}`,
          memberId: currentUserId,
          targetId: member.id,
          details: `Bulk ${action}: ${member.firstName} ${member.lastName} (${member.email})${action === "set-role" ? ` -> ${role}` : ""}`,
        });
      }
    }

    return NextResponse.json({
      updated: result.count,
      notFound,
    });
  } catch (error) {
    logger.error({ err: error }, "Failed to bulk update members");
    return NextResponse.json({ error: "Failed to bulk update members" }, { status: 500 });
  }
}
