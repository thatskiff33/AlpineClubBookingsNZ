import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { parseJsonRequestBody } from "@/lib/api-json";
import { auth } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { getClientIp } from "@/lib/rate-limit";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { cancelNewBookingExceptionRequest } from "@/lib/booking-exception-request-service";

const patchSchema = z.object({ action: z.literal("cancel") });

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }
  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) return inactiveResponse;

  const jsonBody = await parseJsonRequestBody(req, { error: "Invalid JSON" });
  if (!jsonBody.ok) return jsonBody.response;
  const body = jsonBody.body;
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Only { action: \"cancel\" } is supported here" },
      { status: 400 },
    );
  }

  const { id } = await params;

  // Guarded single transition REQUESTED -> CANCELLED, scoped to the member's own
  // request. A lost claim (already approved/rejected/cancelled/superseded) runs
  // NO side effect: no audit-success, no notification, a plain 409.
  const cancelled = await cancelNewBookingExceptionRequest({
    id,
    requestedByMemberId: session.user.id,
  });

  if (!cancelled) {
    return NextResponse.json(
      { error: "This request is no longer open and cannot be cancelled" },
      { status: 409 },
    );
  }

  logAudit({
    action: "booking-policy-exception-request.cancel",
    memberId: session.user.id,
    targetId: id,
    subjectMemberId: session.user.id,
    entityType: "NewBookingPolicyExceptionRequest",
    entityId: id,
    category: "booking",
    outcome: "success",
    summary: "New-booking policy exception request cancelled by member",
    metadata: { source: "NEW_BOOKING", requestId: id },
    ipAddress: getClientIp(req),
  });

  return NextResponse.json({ id, status: "CANCELLED" });
}
