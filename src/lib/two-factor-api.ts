import { NextResponse } from "next/server";
import { auth, updateSession } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { isSecondFactorEnrolled } from "@/lib/second-factor-enrolment";
import { memberHasStoredPasskey } from "@/lib/webauthn";
import {
  clearTwoFactorLockout,
  createTwoFactorSessionChallenge,
  getActiveTwoFactorLockout,
} from "@/lib/two-factor";

const TWO_FACTOR_MEMBER_SELECT = {
  id: true,
  email: true,
  firstName: true,
  lastName: true,
  active: true,
  forcePasswordChange: true,
  twoFactorEnabled: true,
  twoFactorMethod: true,
  totpSecret: true,
  twoFactorFailedAttempts: true,
  twoFactorLockedUntil: true,
} as const;

export type TwoFactorApiMember = {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  active: boolean;
  forcePasswordChange: boolean;
  twoFactorEnabled: boolean;
  twoFactorMethod: "TOTP" | "EMAIL" | null;
  totpSecret: string | null;
  twoFactorFailedAttempts: number;
  twoFactorLockedUntil: Date | null;
};

export type TwoFactorApiSession = Awaited<ReturnType<typeof auth>>;

export type TwoFactorApiGuardResult =
  | {
      ok: true;
      session: NonNullable<TwoFactorApiSession>;
      member: TwoFactorApiMember;
    }
  | { ok: false; response: NextResponse };

export async function requireTwoFactorApiSession(): Promise<TwoFactorApiGuardResult> {
  const session = await auth();
  if (!session?.user?.id) {
    return {
      ok: false,
      response: NextResponse.json({ error: "Unauthorised" }, { status: 401 }),
    };
  }

  const member = await prisma.member.findUnique({
    where: { id: session.user.id },
    select: TWO_FACTOR_MEMBER_SELECT,
  });

  if (!member?.active) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "Account is deactivated" },
        { status: 403 },
      ),
    };
  }

  return { ok: true, session, member };
}

export async function markTwoFactorSessionVerified() {
  const session = await auth();
  if (!session?.user?.id) {
    return;
  }

  await clearTwoFactorLockout(session.user.id);

  // The session-update trigger is reachable by any authenticated client, so
  // the jwt callback only honours twoFactorVerified when the update carries
  // this single-use, server-minted challenge token. The raw token never
  // leaves the server: it is consumed by the jwt callback inside this same
  // updateSession() call.
  const twoFactorChallengeToken = await createTwoFactorSessionChallenge(
    session.user.id,
  );

  await updateSession({
    user: {
      twoFactorVerified: true,
      twoFactorChallengeToken,
    },
    // The extra token field is not part of the public Session shape, so the
    // literal needs an assertion to pass through unstable_update's typing.
  } as unknown as Parameters<typeof updateSession>[0]);
}

export function passwordChangeRequiredResponse() {
  return NextResponse.json(
    { error: "Password change required" },
    { status: 403 },
  );
}

export function twoFactorLockoutResponse(member: TwoFactorApiMember) {
  const lockedUntil = getActiveTwoFactorLockout(member);
  if (!lockedUntil) return null;

  return NextResponse.json(
    {
      error: "Too many invalid two-factor attempts",
      lockedUntil: lockedUntil.toISOString(),
    },
    { status: 429 },
  );
}

export async function getTwoFactorStatusPayload(
  session: NonNullable<TwoFactorApiSession>,
  member: TwoFactorApiMember,
) {
  const hasPasskey = await memberHasStoredPasskey(member.id);
  return {
    required: session.user.twoFactorRequired,
    verified: session.user.twoFactorVerified,
    enrolled: isSecondFactorEnrolled({
      twoFactorEnabled: member.twoFactorEnabled,
      hasPasskey,
      sessionEnrolled: session.user.twoFactorEnrolled,
    }),
    hasPasskey,
    method: member.twoFactorMethod,
    email: member.email,
    forcePasswordChange: member.forcePasswordChange,
    lockedUntil: getActiveTwoFactorLockout(member)?.toISOString() ?? null,
  };
}
