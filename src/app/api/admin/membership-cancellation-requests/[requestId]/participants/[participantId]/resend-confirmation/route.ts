import { NextRequest, NextResponse } from "next/server";
import { membershipCancellationParticipantParamsSchema } from "@/lib/admin-membership-api/requests";
import { MEMBERSHIP_CANCELLATION_REQUEST_RESULT_CONNECTION_SHAPE } from "@/lib/connection-shapes/membership-requests";
import logger from "@/lib/logger";
import { connectionJson } from "@/lib/mcp-connection-request";
import {
  MembershipCancellationRequestError,
  reissueParticipantConfirmationToken,
} from "@/lib/membership-cancellation-requests";
import { getClientIp } from "@/lib/rate-limit";
import { requireAdmin } from "@/lib/session-guards";

export async function POST(
  request: NextRequest,
  {
    params,
  }: { params: Promise<{ requestId: string; participantId: string }> },
) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  const session = guard.session;
  const parsedParams = membershipCancellationParticipantParamsSchema.safeParse(await params);
  if (!parsedParams.success) {
    // The service's own answer for an id that names no participant.
    return NextResponse.json(
      { error: "Membership cancellation participant not found" },
      { status: 404 },
    );
  }
  const { requestId, participantId } = parsedParams.data;

  try {
    const result = await reissueParticipantConfirmationToken({
      requestId,
      participantId,
      adminMemberId: session.user.id,
      ipAddress: getClientIp(request),
    });
    return connectionJson(request, result, MEMBERSHIP_CANCELLATION_REQUEST_RESULT_CONNECTION_SHAPE);
  } catch (err) {
    if (err instanceof MembershipCancellationRequestError) {
      return NextResponse.json(
        { error: err.message },
        { status: err.statusCode },
      );
    }

    logger.error(
      { err, requestId, participantId },
      "Failed to reissue membership cancellation confirmation token",
    );
    return NextResponse.json(
      { error: "Failed to reissue confirmation token" },
      { status: 500 },
    );
  }
}
