import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { auth } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { getClientIp } from "@/lib/rate-limit";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { cancelModificationExceptionRequest } from "@/lib/booking-exception-request-service";
import { transactionContendedResponse } from "@/lib/transaction-contended-response";

const patchSchema = z.object({ action: z.literal("cancel") });

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; requestId: string }> },
) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }
  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) return inactiveResponse;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Only { action: \"cancel\" } is supported here" },
      { status: 400 },
    );
  }

  const { id: bookingId, requestId } = await params;

  // Guarded single transition REQUESTED -> CANCELLED, scoped to the member's own
  // POLICY_EXCEPTION request. A lost claim runs NO side effect: plain 409, no
  // audit-success, no notification. Scoped to POLICY_EXCEPTION so it can never
  // touch a locked-period change request sharing the table, and to `bookingId`
  // so the request must actually belong to the booking in the URL — otherwise
  // the success-path audit below (which records the URL's bookingId verbatim)
  // could mislabel a cancel of a request that belongs to a different booking.
  let cancelled: Awaited<ReturnType<typeof cancelModificationExceptionRequest>>;
  try {
    cancelled = await cancelModificationExceptionRequest({
      id: requestId,
      bookingId,
      requestedByMemberId: session.user.id,
    });
  } catch (err) {
    // The claim is one lock(1) transaction (INV-LOCK-005).
    const contended = transactionContendedResponse(
      err,
      "Exception request cancel contended for the lock(1) budget",
      { context: { bookingId, requestId } },
    );
    if (contended) return contended;
    throw err;
  }

  if (!cancelled) {
    return NextResponse.json(
      { error: "This request is no longer open and cannot be cancelled" },
      { status: 409 },
    );
  }

  logAudit({
    action: "booking-policy-exception-request.cancel",
    memberId: session.user.id,
    targetId: bookingId,
    subjectMemberId: session.user.id,
    entityType: "BookingChangeRequest",
    entityId: requestId,
    category: "booking",
    outcome: "success",
    summary: "Modification policy exception request cancelled by member",
    metadata: { source: "MODIFICATION", bookingId, requestId },
    ipAddress: getClientIp(req),
  });

  return NextResponse.json({ id: requestId, status: "CANCELLED" });
}
