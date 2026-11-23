import { NextRequest, NextResponse } from "next/server";
import { parseJsonRequestBody } from "@/lib/api-json";
import { z } from "zod";
import {
  createMemberArchiveRequest,
  MemberLifecycleActionError,
} from "@/lib/member-lifecycle-actions";
import logger from "@/lib/logger";
import { getClientIp } from "@/lib/rate-limit";
import { requireAdmin } from "@/lib/session-guards";

const archiveRequestSchema = z.object({
  reason: z.string().trim().min(1).max(1000),
});

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  const session = guard.session;
  let body: z.infer<typeof archiveRequestSchema>;
  const jsonBody = await parseJsonRequestBody(request);
  if (!jsonBody.ok) return jsonBody.response;
  try {
    body = archiveRequestSchema.parse(jsonBody.body);
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

    return NextResponse.json(result);
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
