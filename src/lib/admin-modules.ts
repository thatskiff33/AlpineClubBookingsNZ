import {
  DEFAULT_MODULE_SETTINGS,
  MODULE_KEYS,
  getEffectiveModuleFlags,
  readClubModuleSettingsRecord,
  type ModuleKey,
  type ModuleSettingsValues,
} from "@/config/modules";
import type { FeatureFlags } from "@/config/schema";
import {
  loadEffectiveModuleFlags,
  normalizeClubModuleSettings,
} from "@/lib/module-settings";

// test seam
export const ADMIN_MODULE_KEYS = MODULE_KEYS;
export type AdminModuleKey = ModuleKey;
export type AdminModuleSettingsSnapshot = ModuleSettingsValues;
export const DEFAULT_ADMIN_MODULE_SETTINGS = DEFAULT_MODULE_SETTINGS;
export const normalizeAdminModuleSettings = normalizeClubModuleSettings;

interface ClubModuleSettingsClient {
  clubModuleSettings?: {
    findUnique: (args: {
      where: { id: string };
      select?: Record<string, boolean>;
    }) => Promise<Parameters<typeof normalizeClubModuleSettings>[0]>;
  };
}

// test seam
export function getEffectiveModuleState(
  adminActivation: AdminModuleSettingsSnapshot = DEFAULT_ADMIN_MODULE_SETTINGS,
): FeatureFlags {
  return getEffectiveModuleFlags(adminActivation);
}

// test seam
export async function loadAdminModuleSettings(
  client?: ClubModuleSettingsClient,
): Promise<AdminModuleSettingsSnapshot> {
  const db =
    client ??
    ((await import("@/lib/prisma")).prisma as unknown as ClubModuleSettingsClient);

  if (!db.clubModuleSettings?.findUnique) {
    return DEFAULT_ADMIN_MODULE_SETTINGS;
  }

  try {
    const record = await readClubModuleSettingsRecord({
      clubModuleSettings: db.clubModuleSettings,
    });

    return normalizeClubModuleSettings(record);
  } catch {
    return DEFAULT_ADMIN_MODULE_SETTINGS;
  }
}

async function loadEffectiveModuleState(
  client?: ClubModuleSettingsClient,
): Promise<FeatureFlags> {
  if (!client) {
    return loadEffectiveModuleFlags();
  }

  const adminActivation = await loadAdminModuleSettings(client);
  return getEffectiveModuleState(adminActivation);
}

export async function isEffectiveModuleEnabled(
  moduleKey: AdminModuleKey,
  client?: ClubModuleSettingsClient,
): Promise<boolean> {
  const effective = await loadEffectiveModuleState(client);
  return effective[moduleKey];
}
