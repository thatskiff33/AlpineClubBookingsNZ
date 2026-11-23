import { NextRequest, NextResponse } from "next/server";
import { parseJsonRequestBody } from "@/lib/api-json";
import { z } from "zod";
import { auth } from "@/lib/auth";
import {
  MembershipCancellationRequestError,
  respondToMembershipCancellationConfirmation,
} from "@/lib/membership-cancellation-requests";
import { checkRateLimit, getClientIp, rateLimiters } from "@/lib/rate-limit";
import { requireActiveSessionUser } from "@/lib/session-guards";
import logger from "@/lib/logger";
import { isActionTokenFormat } from "@/lib/action-tokens";

const confirmationSchema = z.object({
  token: z
    .string()
    .trim()
    .refine(isActionTokenFormat, "Cancellation confirmation token is invalid"),
  decision: z.enum(["confirm", "decline"]),
});

function errorResponse(error: unknown) {
  if (error instanceof MembershipCancellationRequestError) {
    return NextResponse.json(
      { error: error.message },
      { status: error.statusCode },
    );
  }

  logger.error(
    { err: error },
    "Membership cancellation confirmation API failed",
  );
  return NextResponse.json(
    { error: "Membership cancellation confirmation failed" },
    { status: 500 },
  );
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
    rateLimiters.membershipCancellationConfirmation,
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

  let parsed: z.infer<typeof confirmationSchema>;
  const jsonBody = await parseJsonRequestBody(request);
  if (!jsonBody.ok) return jsonBody.response;
  try {
    parsed = confirmationSchema.parse(jsonBody.body);
  } catch {
    return NextResponse.json(
      { error: "Invalid cancellation confirmation payload" },
      { status: 422 },
    );
  }

  try {
    return NextResponse.json(
      await respondToMembershipCancellationConfirmation({
        token: parsed.token,
        memberId: session.user.id,
        decision: parsed.decision,
        ipAddress: getClientIp(request),
      }),
    );
  } catch (error) {
    return errorResponse(error);
  }
}
