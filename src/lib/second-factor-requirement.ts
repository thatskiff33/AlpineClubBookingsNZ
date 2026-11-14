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
import {
  LOGIN_SECURITY_SETTINGS_ID,
  normalizeOfficerTwoFactorPolicy,
  OFFICER_TWO_FACTOR_POLICY_SELECT,
} from "@/lib/login-security-settings";

export class LastOfficerFactorError extends Error {
  constructor() {
    super("This account must keep an authenticator app or a passkey");
    this.name = "LastOfficerFactorError";
  }
}

type OfficerRuleClient = Pick<Prisma.TransactionClient, "member" | "loginSecuritySetting">;

/**
 * Whether the officer rule covers this member now, read through `db` (a
 * transaction client when the caller holds the member row lock). The release
 * switch is the caller's check: every caller returns early or answers 404
 * while it is off, so this reads the rule as if it were on. A missing member
 * is not required.
 */
export async function isMemberOfficerTwoFactorRequired(
  memberId: string,
  db: OfficerRuleClient = prisma,
): Promise<boolean> {
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
      select: OFFICER_TWO_FACTOR_POLICY_SELECT,
    }),
  ]);
  if (!member) return false;
  return isOfficerTwoFactorRequired({
    releaseEnabled: true,
    policyEnabled: normalizeOfficerTwoFactorPolicy(policy).policyEnabled,
    kiosk: isKioskSessionMember(member),
    canLogin: member.canLogin,
    assignments: officerAssignmentsFromMember(member),
  });
}

export async function assertLastFactorRemovable(
  memberId: string,
  db: OfficerRuleClient = prisma,
): Promise<void> {
  if (!OFFICER_SIGN_IN_ENFORCED) return;
  if (await isMemberOfficerTwoFactorRequired(memberId, db)) {
    throw new LastOfficerFactorError();
  }
}
