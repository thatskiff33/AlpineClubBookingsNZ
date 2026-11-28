import { NextRequest, NextResponse } from "next/server";
import { parseOptionalJsonRequestBody } from "@/lib/api-json";
import { emailFailureReviewSchema } from "@/lib/admin-support-api/messages";
import { EMAIL_FAILURE_REVIEWED_CONNECTION_SHAPE } from "@/lib/connection-shapes/support-messages";
import { connectionJson } from "@/lib/mcp-connection-request";
import {
  EmailFailureReviewError,
  markExhaustedEmailFailureReviewed,
} from "@/lib/email-failure-review";
import { requireAdmin } from "@/lib/session-guards";
import logger from "@/lib/logger";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = await requireAdmin({
    permission: { area: "support", level: "edit" },
  });
  if (!guard.ok) return guard.response;
  const session = guard.session;
  const jsonBody = await parseOptionalJsonRequestBody(request, { whenAbsent: {} });
  if (!jsonBody.ok) return jsonBody.response;
  const body = jsonBody.body;
  const parsed = emailFailureReviewSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid review payload", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const { id } = await params;

  try {
    const result = await markExhaustedEmailFailureReviewed(id, {
      reviewedByMemberId: session.user.id,
      reason: parsed.data.reason,
    });

    return connectionJson(request, result, EMAIL_FAILURE_REVIEWED_CONNECTION_SHAPE);
  } catch (error) {
    if (error instanceof EmailFailureReviewError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }

    logger.error({ err: error, emailLogId: id }, "Failed to review exhausted email failure");
    return NextResponse.json(
      { error: "Failed to review exhausted email failure" },
      { status: 500 }
    );
  }
}
