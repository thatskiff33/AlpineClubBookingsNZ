import { NextResponse } from "next/server";
import { generateTotpEnrollment } from "@/lib/two-factor";
import { authenticatorEnrolmentBlock } from "@/lib/second-factor-enrolment";
import {
  passwordChangeRequiredResponse,
  requireTwoFactorApiSession,
  twoFactorLockoutResponse,
} from "@/lib/two-factor-api";

export async function GET() {
  const guard = await requireTwoFactorApiSession();
  if (!guard.ok) return guard.response;

  if (guard.member.forcePasswordChange) {
    return passwordChangeRequiredResponse();
  }

  const locked = twoFactorLockoutResponse(guard.member);
  if (locked) return locked;

  const blocked = authenticatorEnrolmentBlock({
    twoFactorRequired: guard.session.user.twoFactorRequired,
    twoFactorVerified: guard.session.user.twoFactorVerified,
    officerTwoFactorRequired: guard.session.user.officerTwoFactorRequired,
    twoFactorSatisfiesOfficer: guard.session.user.twoFactorSatisfiesOfficer,
    twoFactorEnabled: guard.member.twoFactorEnabled,
    twoFactorMethod: guard.member.twoFactorMethod,
    refuseVerifiedModuleSession: true,
  });
  if (blocked) {
    return NextResponse.json({ error: blocked.error }, { status: blocked.status });
  }

  return NextResponse.json(
    generateTotpEnrollment(`${guard.member.email} (${guard.member.firstName})`),
  );
}
