import { NextRequest, NextResponse } from "next/server";
import { parseJsonRequestBody } from "@/lib/api-json";
import { hostingCoverageParticipantRetryResponse } from "@/lib/adult-member-hosting-retry-response";
import { z } from "zod";
import {
  MemberLifecycleActionError,
  reviewMemberLifecycleActionRequest,
} from "@/lib/member-lifecycle-actions";
import logger from "@/lib/logger";
import { getClientIp } from "@/lib/rate-limit";
import { requireAdmin } from "@/lib/session-guards";
import {
  XERO_CONTACT_CREATE_BLOCKS_DELETION_CODE,
  XERO_CONTACT_OPERATION_RESOLVE_REMEDY,
  XeroContactCreateBlocksDeletionError,
} from "@/lib/xero-contact-create-recovery";

const reviewSchema = z.object({
  action: z.enum(["approve", "reject"]),
  note: z.string().max(1000).optional(),
  // #1788: absent/undefined = notify (default), false = suppress the member
  // email. Only honoured by ARCHIVE reviews; DELETE reviews ignore it (their
  // emails go to the requesting admin and always send). A non-boolean value
  // fails the parse below and returns 400.
  notifyMember: z.boolean().optional(),
});

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ requestId: string }> },
) {
  const guard = await requireAdmin({
    permission: { area: "membership", level: "edit" },
  });
  if (!guard.ok) return guard.response;
  const session = guard.session;
  let body: z.infer<typeof reviewSchema>;
  const jsonBody = await parseJsonRequestBody(request);
  if (!jsonBody.ok) return jsonBody.response;
  try {
    body = reviewSchema.parse(jsonBody.body);
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const { requestId } = await params;

  try {
    const result = await reviewMemberLifecycleActionRequest({
      requestId,
      reviewedByMemberId: session.user.id,
      action: body.action,
      reviewNote: body.note,
      ipAddress: getClientIp(request),
      notifyMember: body.notifyMember,
    });

    return NextResponse.json(result);
  } catch (err) {
    const hostingRetry = hostingCoverageParticipantRetryResponse(err);
    if (hostingRetry) return hostingRetry;
    if (err instanceof XeroContactCreateBlocksDeletionError) {
      return NextResponse.json(
        {
          error: err.message,
          code: XERO_CONTACT_CREATE_BLOCKS_DELETION_CODE,
          // #2623 T7: the operator needs to know WHICH operation refused and
          // where to clear it, not just that something Xero-shaped did.
          xeroOperationId: err.operationId,
          remedy: XERO_CONTACT_OPERATION_RESOLVE_REMEDY,
        },
        { status: err.statusCode },
      );
    }
    if (err instanceof MemberLifecycleActionError) {
      return NextResponse.json(
        { error: err.message, details: err.details },
        { status: err.statusCode },
      );
    }

    logger.error({ err, requestId }, "Failed to review member lifecycle action request");
    return NextResponse.json(
      { error: "Failed to review member lifecycle action request" },
      { status: 500 },
    );
  }
}
