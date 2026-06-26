import type { MemberFieldsSettings } from "@prisma/client";
import logger from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import {
  DEFAULT_MEMBER_FIELDS_SETTINGS,
  MEMBER_FIELD_KEYS,
  type MemberFieldKey,
  type MemberFieldsSettingsValues,
} from "@/config/member-fields";

/**
 * Server loaders for the single-row ("default") club setting controlling which
 * optional member fields are collected and displayed. Constants/types live in
 * src/config/member-fields.ts so client code can import them without pulling in
 * prisma. Defaults are ON to preserve existing behaviour; a club can switch a
 * field off to avoid collecting data it does not need (Privacy Act
 * minimisation). Gates admin UI, member onboarding/profile capture, and CSV.
 */

export const MEMBER_FIELDS_SETTINGS_ID = "default";

type MemberFieldsSettingsRecord = Pick<
  MemberFieldsSettings,
  MemberFieldKey | "updatedAt" | "updatedByMemberId"
>;

export function normalizeMemberFieldsSettings(
  record?: Partial<MemberFieldsSettingsRecord> | null,
): MemberFieldsSettingsValues {
  return Object.fromEntries(
    MEMBER_FIELD_KEYS.map((key) => [
      key,
      record?.[key] ?? DEFAULT_MEMBER_FIELDS_SETTINGS[key],
    ]),
  ) as MemberFieldsSettingsValues;
}

export interface MemberFieldsSettingsPayload {
  settings: MemberFieldsSettingsValues;
  updatedAt: string | null;
  updatedByMemberId: string | null;
}

export function buildMemberFieldsSettingsPayload(
  record?: Partial<MemberFieldsSettingsRecord> | null,
): MemberFieldsSettingsPayload {
  return {
    settings: normalizeMemberFieldsSettings(record),
    updatedAt: record?.updatedAt?.toISOString() ?? null,
    updatedByMemberId: record?.updatedByMemberId ?? null,
  };
}

export async function loadMemberFieldsSettings(): Promise<MemberFieldsSettingsPayload> {
  const record = await prisma.memberFieldsSettings.findUnique({
    where: { id: MEMBER_FIELDS_SETTINGS_ID },
  });

  return buildMemberFieldsSettingsPayload(record);
}

/**
 * Resolve just the on/off flags. Resilient to the settings row (or table, during
 * a deploy window) being absent: falls back to defaults so member-facing flows
 * keep working.
 */
export async function loadMemberFieldsFlags(): Promise<MemberFieldsSettingsValues> {
  try {
    const record = await prisma.memberFieldsSettings.findUnique({
      where: { id: MEMBER_FIELDS_SETTINGS_ID },
    });
    return normalizeMemberFieldsSettings(record);
  } catch (err) {
    logger.error(
      { err },
      "Failed to load member field settings; using defaults",
    );
    return { ...DEFAULT_MEMBER_FIELDS_SETTINGS };
  }
}
