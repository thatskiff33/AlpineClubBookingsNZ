import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  HUT_LEADER_PIN_SESSION_COOKIE,
  clearLodgePinFailures,
  createLodgePinSession,
  findActiveHutLeaderAssignmentByPin,
  getLodgePinLockout,
  recordLodgePinFailure,
} from "@/lib/lodge-pin-session";
import {
  applyRateLimit,
  getClientIp,
  rateLimiters,
} from "@/lib/rate-limit";

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
  const lockout = getLodgePinLockout(ip);
  if (lockout.locked) {
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
    if (failure.locked) {
      return rateLimitResponse(
        "Too many failed PIN attempts. Please try again later.",
        failure.retryAfter
      );
    }

    return NextResponse.json({ error: "Invalid PIN" }, { status: 401 });
  }

  clearLodgePinFailures(ip);

  const session = createLodgePinSession(assignment.id, assignment.memberId);
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
