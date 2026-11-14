import {
  clampOfficerTwoFactorGraceDays,
  OFFICER_TWO_FACTOR_GRACE_DEFAULT_DAYS,
} from "@/lib/officer-two-factor-grace";
import { prisma } from "@/lib/prisma";
import {
  normalizeLoginSecurityPolicy,
  type LoginSecurityPolicy,
} from "@/lib/password-policy";

// DB-backed loader for the club-wide login & security policy (epic #2030, child
// #2033). The singleton row (id "default") mirrors ClubModuleSettings /
// ClubIdentitySettings. An absent row resolves to the code default
// (normalizeLoginSecurityPolicy over `null`), so an un-configured club behaves
// byte-identically to today — there is no SELF_HEAL/backfill because the safe
// default lives in code, exactly like module settings.

export const LOGIN_SECURITY_SETTINGS_ID = "default";

const SETTINGS_SELECT = {
  minPasswordLength: true,
  requireUppercase: true,
  requireLowercase: true,
  requireDigit: true,
  requireSymbol: true,
  magicLinkTtlMinutes: true,
  breachedPasswordCheck: true,
  sessionMaxAgeHours: true,
  updatedAt: true,
  updatedByMemberId: true,
} as const;

export interface LoginSecuritySettingsPayload {
  policy: LoginSecurityPolicy;
  updatedAt: string | null;
  updatedByMemberId: string | null;
}

/**
 * Load the effective login & security settings. Returns the normalized policy
 * plus audit metadata (who last changed it, when). A missing row yields the code
 * default policy with null metadata.
 */
export async function loadLoginSecuritySettings(): Promise<LoginSecuritySettingsPayload> {
  const record = await prisma.loginSecuritySetting.findUnique({
    where: { id: LOGIN_SECURITY_SETTINGS_ID },
    select: SETTINGS_SELECT,
  });

  return {
    policy: normalizeLoginSecurityPolicy(record),
    updatedAt: record?.updatedAt?.toISOString() ?? null,
    updatedByMemberId: record?.updatedByMemberId ?? null,
  };
}

/** The officer two-factor columns, for any read that feeds the rule (#4618). */
export const OFFICER_TWO_FACTOR_POLICY_SELECT = {
  officerTwoFactorPolicy: true,
  officerTwoFactorGraceDays: true,
} as const;

/**
 * The one reading of the officer policy row (#4618, INV-SSOT). An absent row
 * is policy on and 14 days, matching the column defaults; a stored grace
 * value is clamped into 0–60. The refresh, the report, the reset and the
 * last-factor refusal all read the policy through this.
 */
export function normalizeOfficerTwoFactorPolicy(
  record: {
    officerTwoFactorPolicy?: boolean | null;
    officerTwoFactorGraceDays?: number | null;
  } | null,
): { policyEnabled: boolean; graceDays: number } {
  return {
    policyEnabled: record?.officerTwoFactorPolicy ?? true,
    graceDays: clampOfficerTwoFactorGraceDays(
      record?.officerTwoFactorGraceDays ?? OFFICER_TWO_FACTOR_GRACE_DEFAULT_DAYS,
    ),
  };
}

/**
 * The club's maximum session age in hours (#4611, `INV-AUTH-007`) and the
 * officer two-factor policy (#4618), one read, for the `jwt` callback in
 * `auth.ts` on every session refresh. Session age is normalised exactly as the
 * full policy is: an absent row reads as the 7-day default and a stray stored
 * value is clamped into 8..720, so a change applies to existing sessions on
 * their next refresh and never extends one. An absent row is policy on and 14
 * days, matching the column defaults; a stored grace value is clamped into
 * 0–60. A failed read throws, so the refresh fails closed: the session
 * endpoint clears the cookie, as for a failed member read.
 */
export async function loadLoginSecurityRefresh(): Promise<{
  sessionMaxAgeHours: number;
  officerTwoFactorPolicy: boolean;
  officerTwoFactorGraceDays: number;
}> {
  const record = await prisma.loginSecuritySetting.findUnique({
    where: { id: LOGIN_SECURITY_SETTINGS_ID },
    select: {
      sessionMaxAgeHours: true,
      ...OFFICER_TWO_FACTOR_POLICY_SELECT,
    },
  });
  const officer = normalizeOfficerTwoFactorPolicy(record);
  return {
    sessionMaxAgeHours: normalizeLoginSecurityPolicy(record).sessionMaxAgeHours,
    officerTwoFactorPolicy: officer.policyEnabled,
    officerTwoFactorGraceDays: officer.graceDays,
  };
}
