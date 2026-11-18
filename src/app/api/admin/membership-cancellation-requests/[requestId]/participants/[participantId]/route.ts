import { NextRequest, NextResponse } from "next/server";
import { hostingCoverageParticipantRetryResponse } from "@/lib/adult-member-hosting-retry-response";
import { z } from "zod";
import {
  MembershipCancellationAdminError,
  reviewMembershipCancellationParticipant,
} from "@/lib/membership-cancellation-admin";
import logger from "@/lib/logger";
import { getClientIp } from "@/lib/rate-limit";
import { requireAdmin } from "@/lib/session-guards";
import { transactionContendedResponse } from "@/lib/transaction-contended-response";

const reviewSchema = z.object({
  action: z.enum(["approve", "reject"]),
  note: z.string().max(1000).optional(),
  // #1787: admin per-action email choice. Absent/undefined = notify (default),
  // false = suppress the member outcome email. A non-boolean fails the parse
  // below → 400 (requireAdmin already gates this to admins).
  notifyMember: z.boolean().optional(),
});

export async function POST(
  request: NextRequest,
  {
    params,
  }: { params: Promise<{ requestId: string; participantId: string }> },
) {
  const guard = await requireAdmin({
    permission: { area: "membership", level: "edit" },
  });
  if (!guard.ok) return guard.response;
  const session = guard.session;
  let body: z.infer<typeof reviewSchema>;
  try {
    body = reviewSchema.parse(await request.json());
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const { requestId, participantId } = await params;

  try {
    const result = await reviewMembershipCancellationParticipant({
      requestId,
      participantId,
      action: body.action,
      adminMemberId: session.user.id,
      adminNote: body.note,
      ipAddress: getClientIp(request),
      notifyMember: body.notifyMember,
    });

    return NextResponse.json(result);
  } catch (err) {
    const hostingRetry = hostingCoverageParticipantRetryResponse(err);
    if (hostingRetry) return hostingRetry;
    if (err instanceof MembershipCancellationAdminError) {
      return NextResponse.json(
        { error: err.message, ...(err.details ?? {}) },
        { status: err.statusCode },
      );
    }

    const contended = transactionContendedResponse(
      err,
      "Membership cancellation participant review contended for a transaction budget",
      { context: { requestId, participantId } },
    );
    if (contended) return contended;
    logger.error(
      { err, requestId, participantId },
      "Failed to review membership cancellation participant",
    );
    return NextResponse.json(
      { error: "Failed to review membership cancellation participant" },
      { status: 500 },
    );
  }
}
