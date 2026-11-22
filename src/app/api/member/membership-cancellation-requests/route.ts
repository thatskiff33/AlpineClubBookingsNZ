import { NextRequest, NextResponse } from "next/server";
import { parseJsonRequestBody } from "@/lib/api-json";
import { z } from "zod";
import { auth } from "@/lib/auth";
import {
  createMembershipCancellationRequest,
  getMembershipCancellationOverview,
  MembershipCancellationRequestError,
} from "@/lib/membership-cancellation-requests";
import { getClientIp, rateLimiters, checkRateLimit } from "@/lib/rate-limit";
import { requireActiveSessionUser } from "@/lib/session-guards";
import logger from "@/lib/logger";

const createRequestSchema = z.object({
  participantMemberIds: z.array(z.string().trim().min(1)).min(1).max(20),
  reason: z.string().max(1000).optional(),
  acknowledgedWarning: z.literal(true),
});

function errorResponse(error: unknown) {
  if (error instanceof MembershipCancellationRequestError) {
    return NextResponse.json(
      { error: error.message },
      { status: error.statusCode },
    );
  }

  logger.error({ err: error }, "Membership cancellation request API failed");
  return NextResponse.json(
    { error: "Membership cancellation request failed" },
    { status: 500 },
  );
}

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
  }

  try {
    return NextResponse.json(
      await getMembershipCancellationOverview(session.user.id),
    );
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
  }

  const rl = await checkRateLimit(
    rateLimiters.membershipCancellationRequest,
    session.user.id,
  );
  if (!rl.success) {
    const retryAfter = Math.ceil((rl.resetAt - Date.now()) / 1000);
    return NextResponse.json(
      { error: "Too many requests. Please try again later." },
      {
        status: 429,
        headers: { "Retry-After": String(retryAfter) },
      },
    );
  }

  let parsed: z.infer<typeof createRequestSchema>;
  const jsonBody = await parseJsonRequestBody(request);
  if (!jsonBody.ok) return jsonBody.response;
  try {
    parsed = createRequestSchema.parse(jsonBody.body);
  } catch {
    return NextResponse.json(
      { error: "Invalid cancellation request payload" },
      { status: 422 },
    );
  }

  try {
    const result = await createMembershipCancellationRequest({
      requesterMemberId: session.user.id,
      participantMemberIds: parsed.participantMemberIds,
      reason: parsed.reason,
      acknowledgedWarning: parsed.acknowledgedWarning,
      ipAddress: getClientIp(request),
    });

    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
