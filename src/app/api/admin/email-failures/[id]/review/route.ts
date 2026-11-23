import { NextRequest, NextResponse } from "next/server";
import { parseOptionalJsonRequestBody } from "@/lib/api-json";
import { z } from "zod";
import {
  EmailFailureReviewError,
  markExhaustedEmailFailureReviewed,
} from "@/lib/email-failure-review";
import { requireAdmin } from "@/lib/session-guards";
import logger from "@/lib/logger";

const reviewSchema = z.object({
  reason: z.string().max(500).optional(),
});

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
  const parsed = reviewSchema.safeParse(body);
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

    return NextResponse.json(result);
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
