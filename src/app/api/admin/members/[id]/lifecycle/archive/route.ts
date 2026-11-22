import { NextRequest, NextResponse } from "next/server";
import type { z } from "zod";
import { memberArchiveRequestSchema } from "@/lib/admin-membership-api/requests";
import { MEMBER_ARCHIVE_REQUESTED_CONNECTION_SHAPE } from "@/lib/connection-shapes/membership-requests";
import { connectionJson } from "@/lib/mcp-connection-request";
import {
  createMemberArchiveRequest,
  MemberLifecycleActionError,
} from "@/lib/member-lifecycle-actions";
import logger from "@/lib/logger";
import { getClientIp } from "@/lib/rate-limit";
import { requireAdmin } from "@/lib/session-guards";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  const session = guard.session;
  let body: z.infer<typeof memberArchiveRequestSchema>;
  try {
    body = memberArchiveRequestSchema.parse(await request.json());
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const { id } = await params;

  try {
    const result = await createMemberArchiveRequest({
      memberId: id,
      requestedByMemberId: session.user.id,
      reason: body.reason,
      ipAddress: getClientIp(request),
    });

    return connectionJson(request, result, MEMBER_ARCHIVE_REQUESTED_CONNECTION_SHAPE);
  } catch (err) {
    if (err instanceof MemberLifecycleActionError) {
      return NextResponse.json(
        { error: err.message },
        { status: err.statusCode },
      );
    }

    logger.error({ err, memberId: id }, "Failed to create member archive request");
    return NextResponse.json(
      { error: "Failed to create member archive request" },
      { status: 500 },
    );
  }
}
