import type { ClubModuleSettings } from "@prisma/client";
import { featureFlags } from "@/config/features";
import {
  DEFAULT_MODULE_SETTINGS,
  MODULE_DEFINITIONS,
  MODULE_KEYS,
  getEffectiveModuleFlags,
  getModuleCapabilityFlags,
  type ModuleKey,
  type ModuleSettingsValues,
} from "@/config/modules";
import type { FeatureFlags } from "@/config/schema";
import logger from "@/lib/logger";
import { prisma } from "@/lib/prisma";

export const CLUB_MODULE_SETTINGS_ID = "default";

export type ModuleReadinessStatus =
  | "ready"
  | "admin_disabled"
  | "capability_disabled";

export interface ModuleStatus {
  key: ModuleKey;
  label: string;
  description: string;
  envVar: string;
  adminEnabled: boolean;
  capabilityEnabled: boolean;
  effectiveEnabled: boolean;
  readiness: {
    status: ModuleReadinessStatus;
    message: string;
    dependencies: string[];
  };
}

export interface ClubModuleSettingsPayload {
  settings: ModuleSettingsValues;
  modules: ModuleStatus[];
  updatedAt: string | null;
  updatedByMemberId: string | null;
}

type ClubModuleSettingsRecord = Pick<
  ClubModuleSettings,
  | "kiosk"
  | "chores"
  | "financeDashboard"
  | "waitlist"
  | "xeroIntegration"
  | "bedAllocation"
  | "internetBankingPayments"
  | "updatedAt"
  | "updatedByMemberId"
>;

export function normalizeClubModuleSettings(
  record?: Partial<ClubModuleSettingsRecord> | null,
): ModuleSettingsValues {
  return {
    kiosk: record?.kiosk ?? DEFAULT_MODULE_SETTINGS.kiosk,
    chores: record?.chores ?? DEFAULT_MODULE_SETTINGS.chores,
    financeDashboard:
      record?.financeDashboard ?? DEFAULT_MODULE_SETTINGS.financeDashboard,
    waitlist: record?.waitlist ?? DEFAULT_MODULE_SETTINGS.waitlist,
    xeroIntegration:
      record?.xeroIntegration ?? DEFAULT_MODULE_SETTINGS.xeroIntegration,
    bedAllocation:
      record?.bedAllocation ?? DEFAULT_MODULE_SETTINGS.bedAllocation,
    internetBankingPayments:
      record?.internetBankingPayments ??
      DEFAULT_MODULE_SETTINGS.internetBankingPayments,
  };
}

function readinessMessage(params: {
  label: string;
  envVar: string;
  adminEnabled: boolean;
  capabilityEnabled: boolean;
}): { status: ModuleReadinessStatus; message: string } {
  if (!params.capabilityEnabled) {
    return {
      status: "capability_disabled",
      message: `${params.envVar} is not enabled, so ${params.label} cannot take effect even if admins activate it.`,
    };
  }

  if (!params.adminEnabled) {
    return {
      status: "admin_disabled",
      message: `${params.label} is available at deploy time but disabled by admin activation.`,
    };
  }

  return {
    status: "ready",
    message: `${params.label} is active and deploy capability is available.`,
  };
}

export function buildModuleStatusList(
  settings: ModuleSettingsValues,
  flags: FeatureFlags = featureFlags,
): ModuleStatus[] {
  const capabilities = getModuleCapabilityFlags(flags);

  return MODULE_KEYS.map((key) => {
    const definition = MODULE_DEFINITIONS[key];
    const adminEnabled = settings[key];
    const capabilityEnabled = capabilities[key];
    const readiness = readinessMessage({
      label: definition.label,
      envVar: definition.envVar,
      adminEnabled,
      capabilityEnabled,
    });

    return {
      key,
      label: definition.label,
      description: definition.description,
      envVar: definition.envVar,
      adminEnabled,
      capabilityEnabled,
      effectiveEnabled: adminEnabled && capabilityEnabled,
      readiness: {
        ...readiness,
        dependencies: definition.dependencies,
      },
    };
  });
}

export function buildClubModuleSettingsPayload(
  record?: Partial<ClubModuleSettingsRecord> | null,
  flags: FeatureFlags = featureFlags,
): ClubModuleSettingsPayload {
  const settings = normalizeClubModuleSettings(record);

  return {
    settings,
    modules: buildModuleStatusList(settings, flags),
    updatedAt: record?.updatedAt?.toISOString() ?? null,
    updatedByMemberId: record?.updatedByMemberId ?? null,
  };
}

export async function loadClubModuleSettings(): Promise<ClubModuleSettingsPayload> {
  const record = await prisma.clubModuleSettings.findUnique({
    where: { id: CLUB_MODULE_SETTINGS_ID },
  });

  return buildClubModuleSettingsPayload(record);
}

const DISABLED_MODULE_FLAGS: FeatureFlags = {
  kiosk: false,
  chores: false,
  financeDashboard: false,
  waitlist: false,
  xeroIntegration: false,
  bedAllocation: false,
  internetBankingPayments: false,
};

export async function loadEffectiveModuleFlags(
  flags: FeatureFlags = featureFlags,
): Promise<FeatureFlags> {
  try {
    const record = await prisma.clubModuleSettings.findUnique({
      where: { id: CLUB_MODULE_SETTINGS_ID },
    });

    return getEffectiveModuleFlags(flags, normalizeClubModuleSettings(record));
  } catch (err) {
    logger.error(
      { err },
      "Failed to load club module settings; disabling optional modules",
    );
    return DISABLED_MODULE_FLAGS;
  }
}
