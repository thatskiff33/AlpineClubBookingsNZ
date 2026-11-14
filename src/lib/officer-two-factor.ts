/**
 * Server half of the officer second-factor rule (#4618).
 *
 * The pure "is required" and "satisfies" helpers stay in
 * `second-factor-enrolment.ts`. This module loads the rows they read, stamps
 * the grace start, and lists who has not enrolled.
 */

import "server-only";

import type { AccessRoleDefinitionLevelFields } from "@/lib/access-roles";
import {
  ADMIN_CAPABLE_MEMBER_WHERE,
  MEMBER_PRIVILEGE_CHECK_SELECT,
} from "@/lib/access-role-definitions";
import {
  getAssignmentPermissionMatrix,
  type AdminPermissionLevel,
} from "@/lib/admin-permissions";
import { clubFormatValues } from "@/lib/club-format-server";
import type { ClubTimeZone } from "@/lib/club-time";
import { clubTimeZone } from "@/lib/club-time/server";
import {
  buildOfficerTwoFactorClaims,
  type OfficerTwoFactorClaims,
} from "@/lib/officer-two-factor-claims";
import {
  formatOfficerGraceDeadline,
  officerGraceClosedByReset,
  officerGraceHasEnded,
  officerTwoFactorGraceEnd,
} from "@/lib/officer-two-factor-grace";
import {
  LOGIN_SECURITY_SETTINGS_ID,
  normalizeOfficerTwoFactorPolicy,
  OFFICER_TWO_FACTOR_POLICY_SELECT,
} from "@/lib/login-security-settings";
import { OFFICER_SIGN_IN_ENFORCED } from "@/lib/officer-sign-in-switch";
import { prisma } from "@/lib/prisma";
import {
  isOfficerTwoFactorRequired,
  satisfiesOfficerSecondFactor,
  type OfficerTwoFactorAssignment,
} from "@/lib/second-factor-enrolment";
import { isKioskSessionMember } from "@/lib/session-idle-expiry";

type AccessRoleRow = {
  role: string | null;
  roleDefinition?:
    | (Partial<Pick<AccessRoleDefinitionLevelFields, "financeLevel" | "supportLevel">> & {
        requiresTwoFactor?: boolean | null;
      })
    | null;
};

/**
 * Resolve one assignment. Finance and Support come from the same per-row
 * resolution the admin permission matrix uses (INV-SSOT); only
 * `requiresTwoFactor` is the officer rule's own.
 */
export function officerAssignmentFromAccessRole(
  row: AccessRoleRow,
): OfficerTwoFactorAssignment {
  const definition = row.roleDefinition ?? null;
  const matrix = getAssignmentPermissionMatrix(row);
  return {
    role: row.role,
    requiresTwoFactor: definition ? (definition.requiresTwoFactor ?? null) : null,
    financeLevel: definitionLevelOf(matrix.finance),
    supportLevel: definitionLevelOf(matrix.support),
  };
}

/** The matrix's app level as the definition level the officer rule compares. */
function definitionLevelOf(level: AdminPermissionLevel | undefined): string | null {
  return level ? level.toUpperCase() : null;
}

export function officerAssignmentsFromMember(member: {
  accessRoles?: ReadonlyArray<AccessRoleRow> | null;
}): OfficerTwoFactorAssignment[] {
  return (member.accessRoles ?? []).map(officerAssignmentFromAccessRole);
}

/**
 * Set the grace stamp once, with the database clock, only while it is still
 * null. A second refresh updates nothing. Returns the stamp now stored, which
 * may be the other refresh's. A reset of a required officer writes the stamp
 * itself if it was still null (`clearMemberSecondFactors`), so this never
 * opens grace after such a reset; a member reset before the rule reached them
 * still gets their first grace period here.
 */
export async function stampOfficerGraceStart(memberId: string): Promise<{
  graceStartedAt: Date | null;
  factorsResetAt: Date | null;
}> {
  await prisma.$executeRaw`
    UPDATE "Member"
    SET "twoFactorGraceStartedAt" = NOW()
    WHERE "id" = ${memberId}
      AND "twoFactorGraceStartedAt" IS NULL
  `;
  const row = await prisma.member.findUnique({
    where: { id: memberId },
    select: { twoFactorGraceStartedAt: true, factorsResetAt: true },
  });
  return {
    graceStartedAt: row?.twoFactorGraceStartedAt ?? null,
    factorsResetAt: row?.factorsResetAt ?? null,
  };
}

export async function resolveOfficerTwoFactorClaims(input: {
  releaseEnabled: boolean;
  policyEnabled: boolean;
  graceDays: number;
  member: {
    id: string;
    canLogin?: boolean | null;
    role?: string | null;
    financeAccessLevel?: string | null;
    accessRoles?: ReadonlyArray<AccessRoleRow> | null;
    twoFactorEnabled?: boolean | null;
    twoFactorMethod?: string | null;
    hasPasskey?: boolean | null;
    twoFactorGraceStartedAt?: Date | null;
    factorsResetAt?: Date | null;
  };
  zone: ClubTimeZone | null;
  now: Date;
}): Promise<OfficerTwoFactorClaims> {
  const kiosk = isKioskSessionMember({
    role: input.member.role,
    accessRoles: input.member.accessRoles ?? [],
    financeAccessLevel: input.member.financeAccessLevel,
    canLogin: input.member.canLogin,
  });
  const shared = {
    releaseEnabled: input.releaseEnabled,
    policyEnabled: input.policyEnabled,
    graceDays: input.graceDays,
    kiosk,
    canLogin: input.member.canLogin,
    assignments: officerAssignmentsFromMember(input.member),
    twoFactorEnabled: input.member.twoFactorEnabled,
    twoFactorMethod: input.member.twoFactorMethod,
    hasPasskey: input.member.hasPasskey,
    zone: input.zone,
    now: input.now,
  };
  const preview = buildOfficerTwoFactorClaims({
    ...shared,
    graceStartedAt: input.member.twoFactorGraceStartedAt ?? null,
    factorsResetAt: input.member.factorsResetAt ?? null,
  });
  if (!preview.shouldStampGrace || !input.releaseEnabled) return preview;
  const stamped = await stampOfficerGraceStart(input.member.id);
  return buildOfficerTwoFactorClaims({
    ...shared,
    graceStartedAt: stamped.graceStartedAt,
    factorsResetAt: stamped.factorsResetAt ?? input.member.factorsResetAt ?? null,
  });
}

export type OfficerTwoFactorReportRow = {
  memberId: string;
  name: string;
  email: string;
  /** "not-started", "ended" after a reset, or the deadline in the club's date format. */
  grace: "not-started" | "ended" | string;
};

/**
 * Required officers who do not yet satisfy the rule. Satisfied members, the
 * kiosk, and anyone the rule does not require are omitted.
 */
export async function loadOfficerTwoFactorReport(): Promise<
  OfficerTwoFactorReportRow[]
> {
  if (!OFFICER_SIGN_IN_ENFORCED) return [];
  const [policy, zone, format] = await Promise.all([
    prisma.loginSecuritySetting.findUnique({
      where: { id: LOGIN_SECURITY_SETTINGS_ID },
      select: OFFICER_TWO_FACTOR_POLICY_SELECT,
    }),
    clubTimeZone(),
    clubFormatValues(),
  ]);
  const { policyEnabled, graceDays } = normalizeOfficerTwoFactorPolicy(policy);
  if (!policyEnabled) return [];

  const members = await prisma.member.findMany({
    where: ADMIN_CAPABLE_MEMBER_WHERE,
    select: {
      id: true,
      email: true,
      firstName: true,
      lastName: true,
      role: true,
      financeAccessLevel: true,
      twoFactorEnabled: true,
      twoFactorMethod: true,
      twoFactorGraceStartedAt: true,
      factorsResetAt: true,
      webAuthnCredentials: { select: { id: true }, take: 1 },
      ...MEMBER_PRIVILEGE_CHECK_SELECT,
    },
    orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
  });

  const now = new Date();
  const rows: OfficerTwoFactorReportRow[] = [];
  for (const member of members) {
    const hasPasskey = member.webAuthnCredentials.length > 0;
    const required = isOfficerTwoFactorRequired({
      releaseEnabled: true,
      policyEnabled,
      kiosk: isKioskSessionMember(member),
      canLogin: member.canLogin,
      assignments: officerAssignmentsFromMember(member),
    });
    if (!required) continue;
    if (
      satisfiesOfficerSecondFactor({
        twoFactorEnabled: member.twoFactorEnabled,
        twoFactorMethod: member.twoFactorMethod,
        hasPasskey,
      })
    ) {
      continue;
    }
    rows.push({
      memberId: member.id,
      name: `${member.firstName} ${member.lastName}`.trim(),
      email: member.email,
      grace: reportGrace(member, graceDays, zone, format, now),
    });
  }
  return rows;
}

function reportGrace(
  member: {
    twoFactorGraceStartedAt: Date | null;
    factorsResetAt: Date | null;
  },
  graceDays: number,
  zone: ClubTimeZone,
  format: { locale: string },
  now: Date,
): OfficerTwoFactorReportRow["grace"] {
  if (
    officerGraceClosedByReset({
      graceStartedAt: member.twoFactorGraceStartedAt,
      factorsResetAt: member.factorsResetAt,
    })
  ) {
    return "ended";
  }
  if (!(member.twoFactorGraceStartedAt instanceof Date)) return "not-started";
  const end = officerTwoFactorGraceEnd({
    startedAt: member.twoFactorGraceStartedAt,
    graceDays,
    zone,
  });
  if (officerGraceHasEnded(now, end)) return "ended";
  return formatOfficerGraceDeadline(end, zone, format) ?? "ended";
}
