import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { updateSession } from "@/lib/auth";
import { LOGIN_THROTTLED_CODE } from "@/lib/login-throttle-policy";
import { prisma } from "@/lib/prisma";
import { applyRateLimit, rateLimiters } from "@/lib/rate-limit";
import {
  loadStepUpMember,
  markSessionReauthenticated,
  verifyStepUpProof,
  type StepUpProof,
} from "@/lib/recent-auth";
import { resolveStepUpMethods } from "@/lib/recent-auth-policy";
import { requireActiveSession } from "@/lib/session-guards";
import { proveSessionReauth, type ReauthMember } from "@/lib/session-reauth";

/**
 * "Confirm it's you" (#4616, `INV-AUTH-008`). GET says which step-up methods
 * the signed-in person may use; POST checks one and, when it passes, refreshes
 * the session's `lastAuthenticatedAt` through a single-use, server-minted
 * challenge. Only a fully signed-in session reaches either: active, login on,
 * no pending password change, two-factor verified (`requireActiveSession`).
 *
 * An emailed code and a recovery code are not a method here, so a request
 * naming either fails validation and nothing is checked or counted.
 */

const stepUpProofSchema: z.ZodType<StepUpProof> = z.discriminatedUnion("method", [
  z.object({ method: z.literal("TOTP"), code: z.string().trim().min(6).max(12) }).strict(),
  z.object({ method: z.literal("PASSWORD"), password: z.string().min(1).max(256) }).strict(),
]);

const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * An app enrolment with no stored secret offers no method (`INV-AUTH-008`
 * fails closed): the person is told why instead of being offered the password.
 */
function stepUpUnavailableResponse() {
  return NextResponse.json(
    {
      error:
        "Your authenticator app setup can't be checked, so it can't confirm it's you. Ask a club administrator for help.",
      code: "STEP_UP_UNAVAILABLE",
      methods: [],
    },
    { status: 409, headers: NO_STORE },
  );
}

export async function GET() {
  const guard = await requireActiveSession();
  if (!guard.ok) return guard.response;

  const member = await loadStepUpMember(guard.session.user.id);
  if (!member) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }
  const methods = resolveStepUpMethods(member);
  if (methods.length === 0) return stepUpUnavailableResponse();
  return NextResponse.json({ methods, factors: methods }, { headers: NO_STORE });
}

export async function POST(request: NextRequest) {
  const rateLimited = await applyRateLimit(rateLimiters.twoFactorVerify, request);
  if (rateLimited) return rateLimited;

  const guard = await requireActiveSession();
  if (!guard.ok) return guard.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON payload" }, { status: 400 });
  }
  if (isFactorProof(body)) {
    return postFactorProof(guard.session.user.id, body);
  }

  const parsed = stepUpProofSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  }

  const member = await loadStepUpMember(guard.session.user.id);
  if (!member) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  const outcome = await verifyStepUpProof(member, parsed.data);
  switch (outcome.kind) {
    case "verified":
      break;
    case "unavailable":
      return stepUpUnavailableResponse();
    case "method-not-allowed":
      return NextResponse.json(
        {
          error: outcome.methods.includes("TOTP")
            ? "Use your authenticator app to confirm it's you."
            : "Use your password to confirm it's you.",
          code: "STEP_UP_METHOD_NOT_ALLOWED",
          methods: outcome.methods,
        },
        { status: 409 },
      );
    case "locked":
      return NextResponse.json(
        {
          error: "Too many invalid two-factor attempts",
          lockedUntil: outcome.lockedUntil.toISOString(),
        },
        { status: 429 },
      );
    case "throttled":
      return NextResponse.json(
        {
          error: "Too many password attempts. Please wait a few minutes and try again.",
          code: LOGIN_THROTTLED_CODE,
        },
        { status: 429 },
      );
    case "invalid":
      return NextResponse.json(
        parsed.data.method === "TOTP"
          ? {
              error: "Invalid code",
              lockedUntil: outcome.lockedUntil?.toISOString() ?? null,
            }
          : { error: "Incorrect password" },
        { status: 400 },
      );
  }

  if (!(await markSessionReauthenticated(member.id))) {
    return NextResponse.json(
      { error: "We couldn't confirm it's you. Please try again." },
      { status: 500 },
    );
  }
  return NextResponse.json({ ok: true }, { headers: NO_STORE });
}

const MEMBER_SELECT = {
  id: true,
  email: true,
  passwordHash: true,
  active: true,
  twoFactorEnabled: true,
  twoFactorMethod: true,
  totpSecret: true,
  twoFactorFailedAttempts: true,
  twoFactorLockedUntil: true,
} as const;

const factorProofSchema = z.discriminatedUnion("factor", [
  z.object({ factor: z.literal("TOTP"), code: z.string().trim().min(1).max(32) }).strict(),
  z.object({ factor: z.literal("PASSWORD"), password: z.string().min(1).max(128) }).strict(),
  z.object({ factor: z.literal("PASSKEY"), assertion: z.unknown() }).strict(),
  z.object({ factor: z.literal("EMAIL"), code: z.string().trim().min(1).max(32) }).strict(),
  z.object({ factor: z.literal("RECOVERY"), code: z.string().trim().min(1).max(32) }).strict(),
]);

function isFactorProof(body: unknown): boolean {
  return typeof body === "object" && body !== null && "factor" in body;
}

/** The confirm dialog's `{ factor }` proof. The `{ method }` proof above is the foundation route. */
async function postFactorProof(memberId: string, body: unknown) {
  const parsed = factorProofSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const member = await prisma.member.findUnique({
    where: { id: memberId },
    select: MEMBER_SELECT,
  });
  if (!member?.active) {
    return NextResponse.json({ error: "Account is deactivated" }, { status: 403 });
  }
  const proof = parsed.data;
  const result = await proveSessionReauth({
    member: member as ReauthMember,
    factor: proof.factor,
    code: "code" in proof ? proof.code : undefined,
    password: "password" in proof ? proof.password : undefined,
    assertion: "assertion" in proof ? proof.assertion : undefined,
  });
  if (!result.ok) {
    return NextResponse.json(
      {
        error: result.error,
        ...(result.code ? { code: result.code } : {}),
        ...(result.lockedUntil ? { lockedUntil: result.lockedUntil } : {}),
      },
      { status: result.status },
    );
  }
  await updateSession({
    user: { reauthChallengeToken: result.challengeToken },
  } as unknown as Parameters<typeof updateSession>[0]);
  return NextResponse.json({ ok: true });
}
