import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  HUT_LEADER_PIN_SESSION_COOKIE,
  clearLodgePinFailures,
  createLodgePinSessionWithVersion,
  findActiveHutLeaderAssignmentByPin,
  getLodgePinLockout,
  recordLodgePinFailure,
} from "@/lib/lodge-pin-session";
import {
  applyRateLimit,
  getClientIp,
  rateLimiters,
} from "@/lib/rate-limit";
import { createAuditLog, getAuditRequestContext } from "@/lib/audit";

const bodySchema = z.object({
  pin: z.string().regex(/^\d{6}$/),
});

function rateLimitResponse(message: string, retryAfter: number) {
  return NextResponse.json(
    { error: message },
    {
      status: 429,
      headers: {
        "Retry-After": String(retryAfter),
      },
    }
  );
}

export async function POST(req: NextRequest) {
  const ip = getClientIp(req);
  const auditRequest = getAuditRequestContext(req);
  const lockout = getLodgePinLockout(ip);
  if (lockout.locked) {
    await createAuditLog({
      action: "lodge.pin.login.blocked",
      details: "Lodge PIN login blocked by IP lockout",
      category: "security",
      severity: "important",
      outcome: "blocked",
      summary: "Lodge PIN login blocked",
      metadata: {
        retryAfter: lockout.retryAfter,
        reason: "ip-lockout",
      },
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

  const limited = applyRateLimit(rateLimiters.lodgePinLogin, req);
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
      { error: "PIN must be 6 digits" },
      { status: 400 }
    );
  }

  const assignment = await findActiveHutLeaderAssignmentByPin(parsed.data.pin);
  if (!assignment) {
    const failure = recordLodgePinFailure(ip);
    await createAuditLog({
      action: failure.locked
        ? "lodge.pin.login.locked"
        : "lodge.pin.login.failed",
      details: failure.locked
        ? "Lodge PIN login failed and triggered lockout"
        : "Lodge PIN login failed",
      category: "security",
      severity: failure.locked ? "important" : "info",
      outcome: "failure",
      summary: failure.locked
        ? "Lodge PIN login locked"
        : "Lodge PIN login failed",
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

    return NextResponse.json({ error: "Invalid PIN" }, { status: 401 });
  }

  clearLodgePinFailures(ip);

  await createAuditLog({
    action: "lodge.pin.login.succeeded",
    memberId: assignment.memberId,
    targetId: assignment.memberId,
    subjectMemberId: assignment.memberId,
    entityType: "Member",
    entityId: assignment.memberId,
    category: "lodge",
    severity: "important",
    outcome: "success",
    summary: "Lodge PIN login succeeded",
    details: "Hut leader signed in with lodge PIN",
    metadata: {
      assignmentId: assignment.id,
    },
    ipAddress: auditRequest?.ipAddress,
    requestId: auditRequest?.id,
    userAgent: auditRequest?.userAgent,
    retentionClass: "sensitive_access",
  });

  const session = createLodgePinSessionWithVersion(
    assignment.id,
    assignment.memberId,
    assignment.hutLeaderPin
  );
  const response = NextResponse.json({
    success: true,
    tier: "hut-leader",
    memberName: `${assignment.member.firstName} ${assignment.member.lastName}`,
  });

  response.cookies.set({
    name: HUT_LEADER_PIN_SESSION_COOKIE,
    value: session.value,
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    expires: session.expiresAt,
    maxAge: session.maxAge,
    path: "/",
  });

  return response;
}
