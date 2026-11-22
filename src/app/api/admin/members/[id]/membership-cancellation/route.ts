import { NextRequest, NextResponse } from "next/server";
import type { z } from "zod";
import { adminMembershipCancellationRequestSchema } from "@/lib/admin-membership-api/requests";
import { MEMBERSHIP_CANCELLATION_REQUEST_RESULT_CONNECTION_SHAPE } from "@/lib/connection-shapes/membership-requests";
import { connectionJson } from "@/lib/mcp-connection-request";
import logger from "@/lib/logger";
import {
  createAdminMembershipCancellationRequest,
  MembershipCancellationRequestError,
} from "@/lib/membership-cancellation-requests";
import { getClientIp } from "@/lib/rate-limit";
import { requireAdmin } from "@/lib/session-guards";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  const session = guard.session;
  let body: z.infer<typeof adminMembershipCancellationRequestSchema>;
  try {
    body = adminMembershipCancellationRequestSchema.parse(await request.json());
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const { id } = await params;

  try {
    const result = await createAdminMembershipCancellationRequest({
      targetMemberId: id,
      adminMemberId: session.user.id,
      reason: body.reason,
      ipAddress: getClientIp(request),
    });

    return connectionJson(request, result, MEMBERSHIP_CANCELLATION_REQUEST_RESULT_CONNECTION_SHAPE, {
      status: 201,
    });
  } catch (err) {
    if (err instanceof MembershipCancellationRequestError) {
      return NextResponse.json(
        { error: err.message },
        { status: err.statusCode },
      );
    }

    logger.error(
      { err, memberId: id },
      "Failed to create admin membership cancellation request",
    );
    return NextResponse.json(
      { error: "Failed to create membership cancellation request" },
      { status: 500 },
    );
  }
}
