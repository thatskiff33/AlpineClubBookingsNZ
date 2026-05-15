import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import {
  EmailFailureReviewError,
  markExhaustedEmailFailureReviewed,
} from "@/lib/email-failure-review";
import { requireActiveSessionUser } from "@/lib/session-guards";
import logger from "@/lib/logger";

const reviewSchema = z.object({
  reason: z.string().max(500).optional(),
});

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
  }

  const body = await request.json().catch(() => ({}));
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
