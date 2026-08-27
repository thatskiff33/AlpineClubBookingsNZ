import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  clearLodgePinFailures,
  getLodgePinLockout,
  recordLodgePinFailure,
  verifyHutLeaderPinForAssignment,
} from "@/lib/lodge-pin-session";
import { applyRateLimit, getClientIp, rateLimiters } from "@/lib/rate-limit";
import { createAuditLog, getAuditRequestContext } from "@/lib/audit";
import { getSanitizedLodgeInstructions } from "@/lib/lodge-instructions";
import { clubTodayDateOnlyInstant } from "@/lib/club-time/server";

/**
 * Remote, PIN-gated lodge-instructions preview (#1642).
 *
 * PUBLIC by design — no login session. Non-login hut leaders (e.g. school
 * teachers) receive an assignment email whose instructions link carries their
 * assignment id (a non-enumerable cuid); this endpoint verifies that id + their
 * 6-digit PIN and returns ONLY the sanitised instruction documents for that
 * assignment's lodge. The assignment id disambiguates the lodge (PINs are not
 * globally unique) and confines brute force to a single PIN; IP lockout +
 * the auth-sensitive rate limiter throttle guessing, mirroring the kiosk PIN
 * login. Nothing but the instruction documents is ever returned.
 */
const bodySchema = z.object({
  assignmentId: z.string().min(1).max(128),
  pin: z.string().regex(/^\d{6}$/),
});

function rateLimitResponse(message: string, retryAfter: number) {
  return NextResponse.json(
    { error: message },
    { status: 429, headers: { "Retry-After": String(retryAfter) } }
  );
}

export async function POST(req: NextRequest) {
  const ip = getClientIp(req);
  const auditRequest = getAuditRequestContext(req);

  const lockout = getLodgePinLockout(ip);
  if (lockout.locked) {
    await createAuditLog({
      action: "lodge.instructions.pin.blocked",
      details: "Remote lodge-instructions PIN blocked by IP lockout",
      category: "security",
      severity: "important",
      outcome: "blocked",
      summary: "Lodge instructions PIN blocked",
      metadata: { retryAfter: lockout.retryAfter, reason: "ip-lockout" },
      ipAddress: auditRequest?.ipAddress,
      requestId: auditRequest?.id,
      userAgent: auditRequest?.userAgent,
      retentionClass: "sensitive_access",
    });
    return rateLimitResponse(
      "Too many failed PIN attempts. Please try again later.",
      lockout.retryAfter
    );
  }

  const limited = await applyRateLimit(rateLimiters.lodgePinLogin, req);
  if (limited) {
    return limited;
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "A valid assignment link and a 6-digit PIN are required." },
      { status: 400 }
    );
  }

  // #3123 — a current-or-upcoming assignment is judged against the CLUB's day,
  // from its persisted zone, not the container's.
  const assignment = await verifyHutLeaderPinForAssignment(
    parsed.data.assignmentId,
    parsed.data.pin,
    await clubTodayDateOnlyInstant()
  );

  if (!assignment) {
    const failure = recordLodgePinFailure(ip);
    await createAuditLog({
      action: failure.locked
        ? "lodge.instructions.pin.locked"
        : "lodge.instructions.pin.failed",
      details: failure.locked
        ? "Remote lodge-instructions PIN failed and triggered lockout"
        : "Remote lodge-instructions PIN failed",
      category: "security",
      severity: failure.locked ? "important" : "info",
      outcome: "failure",
      summary: failure.locked
        ? "Lodge instructions PIN locked"
        : "Lodge instructions PIN failed",
      metadata: {
        failureCount: failure.count,
        locked: failure.locked,
        retryAfter: failure.retryAfter,
      },
      ipAddress: auditRequest?.ipAddress,
      requestId: auditRequest?.id,
      userAgent: auditRequest?.userAgent,
      retentionClass: "sensitive_access",
    });
    if (failure.locked) {
      return rateLimitResponse(
        "Too many failed PIN attempts. Please try again later.",
        failure.retryAfter
      );
    }
    // Uniform response whether the id or the PIN was wrong — never reveal which.
    return NextResponse.json(
      { error: "That assignment link and PIN don't match." },
      { status: 401 }
    );
  }

  clearLodgePinFailures(ip);
  await createAuditLog({
    action: "lodge.instructions.pin.succeeded",
    details: "Remote lodge-instructions PIN verified",
    category: "security",
    severity: "info",
    outcome: "success",
    summary: "Lodge instructions PIN verified",
    memberId: assignment.memberId,
    subjectMemberId: assignment.memberId,
    entityType: "HutLeaderAssignment",
    entityId: assignment.id,
    metadata: { assignmentId: assignment.id, lodgeId: assignment.lodgeId },
    ipAddress: auditRequest?.ipAddress,
    requestId: auditRequest?.id,
    userAgent: auditRequest?.userAgent,
    retentionClass: "sensitive_access",
  });

  const documents = await getSanitizedLodgeInstructions({
    lodgeId: assignment.lodgeId,
  });
  return NextResponse.json({ documents });
}
