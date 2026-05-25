import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import logger from "@/lib/logger";
import {
  MembershipCancellationRequestError,
  reissueParticipantConfirmationToken,
} from "@/lib/membership-cancellation-requests";
import { getClientIp } from "@/lib/rate-limit";
import { requireActiveSessionUser } from "@/lib/session-guards";

export async function POST(
  request: NextRequest,
  {
    params,
  }: { params: Promise<{ requestId: string; participantId: string }> },
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
  }

  const { requestId, participantId } = await params;

  try {
    const result = await reissueParticipantConfirmationToken({
      requestId,
      participantId,
      adminMemberId: session.user.id,
      ipAddress: getClientIp(request),
    });
    return NextResponse.json(result);
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
