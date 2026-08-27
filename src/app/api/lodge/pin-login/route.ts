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
import { auth } from "@/lib/auth";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { hasLodgeAccess } from "@/lib/access-roles";
import { getStaffLodgeBinding } from "@/lib/lodge-access";
import { clubTodayDateOnlyInstant } from "@/lib/club-time/server";
import { getDefaultLodgeId } from "@/lib/lodges";
import { prisma } from "@/lib/prisma";

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
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
  }

  if (!hasLodgeAccess(session.user)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

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
      { error: "PIN must be 6 digits" },
      { status: 400 }
    );
  }

  // The kiosk account's STAFF grant binds this device to one lodge; without a
  // grant the club's default lodge applies (single-lodge behaviour). A grant
  // at more than one lodge is ambiguous — deny rather than accept the default
  // lodge's hut-leader PINs on the wrong property (M5).
  const binding = await getStaffLodgeBinding(prisma, session.user.id);
  if (binding.kind === "ambiguous") {
    return NextResponse.json(
      {
        error:
          "This kiosk account is assigned to multiple lodges — an admin must fix the assignment.",
      },
      { status: 403 }
    );
  }
  const kioskLodgeId =
    binding.kind === "bound"
      ? binding.lodgeId
      : await getDefaultLodgeId(prisma);
  // #3123 — the club's PERSISTED zone decides which day this PIN is judged
  // against, not the container's. It used to be `undefined` here purely to
  // reach `kioskLodgeId` past a positional default, so the environment's day
  // was chosen by accident; the parameter is now required and this route
  // supplies it.
  const assignment = await findActiveHutLeaderAssignmentByPin(
    parsed.data.pin,
    await clubTodayDateOnlyInstant(),
    kioskLodgeId,
  );
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

  const pinSession = createLodgePinSessionWithVersion(
    assignment.id,
    assignment.memberId,
    assignment.hutLeaderPin,
    session.user.id
  );
  const response = NextResponse.json({
    success: true,
    tier: "hut-leader",
    memberName: `${assignment.member.firstName} ${assignment.member.lastName}`,
  });

  response.cookies.set({
    name: HUT_LEADER_PIN_SESSION_COOKIE,
    value: pinSession.value,
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    expires: pinSession.expiresAt,
    maxAge: pinSession.maxAge,
    path: "/",
  });

  return response;
}
