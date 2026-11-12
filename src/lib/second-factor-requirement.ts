/**
 * Refusing to remove the last factor that meets the officer rule (#4618).
 *
 * `deletePasskey` calls this only when the delete would leave
 * `satisfiesOfficerSecondFactor` false. A refusal throws; the delete returns
 * 400 and leaves the row. While the release is off, every removal is allowed.
 */

import "server-only";

import type { Prisma } from "@prisma/client";
import { MEMBER_PRIVILEGE_CHECK_SELECT } from "@/lib/access-role-definitions";
import { officerAssignmentsFromMember } from "@/lib/officer-two-factor";
import { OFFICER_SIGN_IN_ENFORCED } from "@/lib/officer-sign-in-switch";
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

export async function assertLastFactorRemovable(
  memberId: string,
  db: Pick<Prisma.TransactionClient, "member" | "loginSecuritySetting"> = prisma,
): Promise<void> {
  if (!OFFICER_SIGN_IN_ENFORCED) return;
  const [member, policy] = await Promise.all([
    db.member.findUnique({
      where: { id: memberId },
      select: {
        role: true,
        financeAccessLevel: true,
        ...MEMBER_PRIVILEGE_CHECK_SELECT,
      },
    }),
    db.loginSecuritySetting.findUnique({
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
