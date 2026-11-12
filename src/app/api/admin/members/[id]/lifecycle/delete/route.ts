import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  createMemberDeleteRequest,
  MemberLifecycleActionError,
} from "@/lib/member-lifecycle-actions";
import logger from "@/lib/logger";
import { getClientIp } from "@/lib/rate-limit";
import { requireAdmin } from "@/lib/session-guards";
import { requireRecentAuth } from "@/lib/require-recent-auth";

const deleteRequestSchema = z.object({
  reason: z.string().trim().min(1).max(1000),
});

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  const session = guard.session;
  let body: z.infer<typeof deleteRequestSchema>;
  const recent = await requireRecentAuth();
  if (!recent.ok) return recent.response;
  try {
    body = deleteRequestSchema.parse(await request.json());
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const { id } = await params;

  try {
    const result = await createMemberDeleteRequest({
      memberId: id,
      requestedByMemberId: session.user.id,
      reason: body.reason,
      ipAddress: getClientIp(request),
    });

    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof MemberLifecycleActionError) {
      return NextResponse.json(
        { error: err.message, details: err.details },
        { status: err.statusCode },
      );
    }

    logger.error({ err, memberId: id }, "Failed to create member delete request");
    return NextResponse.json(
      { error: "Failed to create member delete request" },
      { status: 500 },
    );
  }
}
