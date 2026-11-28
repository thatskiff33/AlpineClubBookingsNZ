import { NextRequest, NextResponse } from "next/server";
import { actorIsFullAdmin } from "@/lib/admin-account-guards";
import { memberUnarchiveSchema } from "@/lib/admin-membership-api/requests";
import { parseJsonRequestBody } from "@/lib/api-json";
import logger from "@/lib/logger";
import { MemberLifecycleActionError } from "@/lib/member-lifecycle-actions";
import {
  UNARCHIVE_FULL_ADMIN_ONLY_MESSAGE,
  unarchiveMember,
} from "@/lib/member-unarchive";
import { prisma } from "@/lib/prisma";
import { getClientIp } from "@/lib/rate-limit";
import { requireAdmin } from "@/lib/session-guards";

/** #5540: a Full Admin clears a member's archive in one step, with a reason. */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  const actorMemberId = guard.session.user.id;

  // Full-Admin-only gate (the service re-checks inside its transaction).
  if (!(await actorIsFullAdmin(prisma, actorMemberId))) {
    return NextResponse.json(
      { error: UNARCHIVE_FULL_ADMIN_ONLY_MESSAGE },
      { status: 403 },
    );
  }

  const jsonBody = await parseJsonRequestBody(request);
  if (!jsonBody.ok) return jsonBody.response;
  const body = memberUnarchiveSchema.safeParse(jsonBody.body);
  if (!body.success) {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const { id } = await params;

  try {
    const result = await unarchiveMember({
      memberId: id,
      actorMemberId,
      reason: body.data.reason,
      ipAddress: getClientIp(request),
    });
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof MemberLifecycleActionError) {
      return NextResponse.json(
        { error: err.message },
        { status: err.statusCode },
      );
    }

    logger.error({ err, memberId: id }, "Failed to unarchive member");
    return NextResponse.json(
      { error: "Failed to unarchive member" },
      { status: 500 },
    );
  }
}
