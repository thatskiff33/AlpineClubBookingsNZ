/**
 * Refusing to remove the last factor that meets the officer rule (#4618).
 *
 * `deletePasskey` calls this only when the delete would leave
 * `satisfiesOfficerSecondFactor` false. A refusal throws; the delete returns
 * 400 and leaves the row. While the release is off, every removal is allowed.
 */

import "server-only";

import { MEMBER_PRIVILEGE_CHECK_SELECT } from "@/lib/access-role-definitions";
import { officerAssignmentsFromMember } from "@/lib/officer-two-factor";
import { OFFICER_SIGN_IN_RELEASE_ENABLED } from "@/lib/officer-sign-in-release";
import { prisma } from "@/lib/prisma";
import { isOfficerTwoFactorRequired } from "@/lib/second-factor-enrolment";
import { isKioskSessionMember } from "@/lib/session-idle-expiry";
import { LOGIN_SECURITY_SETTINGS_ID } from "@/lib/login-security-settings";

export class LastOfficerFactorError extends Error {
  constructor() {
    super("This account must keep an authenticator app or a passkey");
    this.name = "LastOfficerFactorError";
  }
}

export async function assertLastFactorRemovable(memberId: string): Promise<void> {
  if (!OFFICER_SIGN_IN_RELEASE_ENABLED) return;
  const [member, policy] = await Promise.all([
    prisma.member.findUnique({
      where: { id: memberId },
      select: {
        role: true,
        financeAccessLevel: true,
        ...MEMBER_PRIVILEGE_CHECK_SELECT,
      },
    }),
    prisma.loginSecuritySetting.findUnique({
      where: { id: LOGIN_SECURITY_SETTINGS_ID },
      select: { officerTwoFactorPolicy: true },
    }),
  ]);
  if (!member) return;
  const required = isOfficerTwoFactorRequired({
    releaseEnabled: true,
    policyEnabled: policy?.officerTwoFactorPolicy ?? true,
    kiosk: isKioskSessionMember(member),
    canLogin: member.canLogin,
    assignments: officerAssignmentsFromMember(member),
  });
  if (required) throw new LastOfficerFactorError();
}
