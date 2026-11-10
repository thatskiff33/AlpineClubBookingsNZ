import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { auth, updateSession } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { applyRateLimit, rateLimiters } from "@/lib/rate-limit";
import { requireActiveSessionUser } from "@/lib/session-guards";
import {
  proveSessionReauth,
  reauthFactorsFor,
  type ReauthMember,
} from "@/lib/session-reauth";

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

const proofSchema = z.discriminatedUnion("factor", [
  z.object({ factor: z.literal("TOTP"), code: z.string().trim().min(1).max(32) }).strict(),
  z
    .object({ factor: z.literal("PASSWORD"), password: z.string().min(1).max(128) })
    .strict(),
  z.object({ factor: z.literal("PASSKEY"), assertion: z.unknown() }).strict(),
  // Accepted here so the refusal is the step-up rule, not a shape error, and
  // the attempt still counts. Neither factor ever succeeds.
  z.object({ factor: z.literal("EMAIL"), code: z.string().trim().min(1).max(32) }).strict(),
  z
    .object({ factor: z.literal("RECOVERY"), code: z.string().trim().min(1).max(32) })
    .strict(),
]);

async function loadMember(memberId: string) {
  const session = await auth();
  if (!session?.user?.id || session.user.id !== memberId) {
    return {
      ok: false as const,
      response: NextResponse.json({ error: "Unauthorised" }, { status: 401 }),
    };
  }
  const member = await prisma.member.findUnique({
    where: { id: memberId },
    select: MEMBER_SELECT,
  });
  if (!member?.active) {
    return {
      ok: false as const,
      response: NextResponse.json({ error: "Account is deactivated" }, { status: 403 }),
    };
  }
  return { ok: true as const, member: member as ReauthMember };
}

export async function GET(request: NextRequest) {
  const rateLimited = await applyRateLimit(rateLimiters.twoFactorVerify, request);
  if (rateLimited) return rateLimited;

  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }
  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
  }
  const loaded = await loadMember(session.user.id);
  if (!loaded.ok) return loaded.response;

  return NextResponse.json({ factors: reauthFactorsFor(loaded.member) });
}

export async function POST(request: NextRequest) {
  const rateLimited = await applyRateLimit(rateLimiters.twoFactorVerify, request);
  if (rateLimited) return rateLimited;

  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }
  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
  }
  const loaded = await loadMember(session.user.id);
  if (!loaded.ok) return loaded.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON payload" }, { status: 400 });
  }

  const parsed = proofSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const proof = parsed.data;
  const result = await proveSessionReauth({
    member: loaded.member,
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

  // The raw token never leaves the server. The jwt callback consumes it
  // inside this update and is the only writer of lastAuthenticatedAt.
  await updateSession({
    user: { reauthChallengeToken: result.challengeToken },
  } as unknown as Parameters<typeof updateSession>[0]);

  return NextResponse.json({ ok: true });
}
