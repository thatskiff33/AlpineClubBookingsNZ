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
