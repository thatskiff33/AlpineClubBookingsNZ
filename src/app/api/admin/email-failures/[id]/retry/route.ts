import { NextRequest, NextResponse } from "next/server";
import {
  EmailFailureReviewError,
  requeueExhaustedEmailFailure,
} from "@/lib/email-failure-review";
import { requireAdmin } from "@/lib/session-guards";
import logger from "@/lib/logger";

/**
 * **Try again** on an exhausted email failure (#4963). Hands the row back to the
 * email retry cron; nothing is sent from here, so the cron's authority,
 * suppression, "No emails" and environment checks still decide the send.
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = await requireAdmin({
    permission: { area: "support", level: "edit" },
  });
  if (!guard.ok) return guard.response;
  const session = guard.session;
  const { id } = await params;

  try {
    const result = await requeueExhaustedEmailFailure(id, {
      requestedByMemberId: session.user.id,
    });

    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof EmailFailureReviewError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }

    logger.error({ err: error, emailLogId: id }, "Failed to requeue exhausted email failure");
    return NextResponse.json(
      { error: "Failed to requeue exhausted email failure" },
      { status: 500 }
    );
  }
}
