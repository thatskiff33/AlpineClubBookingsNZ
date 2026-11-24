import { NextRequest, NextResponse } from "next/server";
import {
  BookingRequestError,
  withdrawMemberWholeLodgeRequest,
} from "@/lib/booking-request";
import {
  applyRateLimit,
  checkRateLimit,
  rateLimitedResponse,
  rateLimiters,
} from "@/lib/rate-limit";
import { requireActiveSession } from "@/lib/session-guards";
import logger from "@/lib/logger";
import { WHOLE_LODGE_REQUEST_WITHDRAWN_CONNECTION_SHAPE } from "@/lib/connection-shapes-groups";
import { connectionJson } from "@/lib/mcp-connection-request";
import {
  WHOLE_LODGE_REQUEST_WITHDRAWN,
  wholeLodgeRequestIdParamsSchema,
} from "@/lib/member-whole-lodge-request-schema";

/*
 * Member withdraws their own pending whole-lodge request (#2263, D3).
 *
 * BOUNDARY: member. Session-authenticated, deliberately token-free (unlike the
 * public quote-token cancel, whose caller has no account). Not registered in
 * `explicitPublicApiRoutes` — see the sibling submit route for why that would be
 * exactly the wrong mechanism; the per-method rationale is in
 * `mixedMethodApiRoutes`.
 *
 * Authorisation is not a read-then-write: the owner check is part of the
 * status-guarded claim inside `withdrawMemberWholeLodgeRequest`, so there is no
 * window between "is this mine?" and "cancel it", and someone else's request id
 * behaves exactly like an id that does not exist.
 *
 * Also the AI app action `withdraw_whole_lodge_request` (ALP-797).
 */

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = await requireActiveSession();
  if (!guard.ok) return guard.response;
  const memberId = guard.session.user.id;

  const ipLimited = await applyRateLimit(
    rateLimiters.memberWholeLodgeWithdraw,
    request
  );
  if (ipLimited) return ipLimited;
  const memberLimit = await checkRateLimit(
    rateLimiters.memberWholeLodgeWithdraw,
    `member:${memberId}`
  );
  if (!memberLimit.success) return rateLimitedResponse(memberLimit);

  const parsedParams = wholeLodgeRequestIdParamsSchema.safeParse(await params);
  if (!parsedParams.success) {
    return NextResponse.json({ error: "Invalid request id" }, { status: 400 });
  }
  const { id } = parsedParams.data;

  try {
    await withdrawMemberWholeLodgeRequest({ requestId: id, memberId });
    return connectionJson(request, WHOLE_LODGE_REQUEST_WITHDRAWN, WHOLE_LODGE_REQUEST_WITHDRAWN_CONNECTION_SHAPE);
  } catch (err) {
    if (err instanceof BookingRequestError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }

    logger.error(
      { err, bookingRequestId: id },
      "Unexpected error withdrawing a member whole-lodge request"
    );
    return NextResponse.json(
      { error: "Unable to withdraw this request right now" },
      { status: 500 }
    );
  }
}
