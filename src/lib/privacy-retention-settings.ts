import "server-only";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { createAuditLog } from "@/lib/audit";
import {
  DEFAULT_PRIVACY_RETENTION_SETTINGS,
  privacyRetentionSettingsSchema,
  type PrivacyRetentionSettingsValues,
} from "@/lib/privacy-retention-shared";

export const PRIVACY_RETENTION_SETTINGS_ID = "default";

export async function getPrivacyRetentionSettings(
  db: Pick<Prisma.TransactionClient, "privacyRetentionSettings"> = prisma,
): Promise<PrivacyRetentionSettingsValues> {
  const row = await db.privacyRetentionSettings.findUnique({
    where: { id: PRIVACY_RETENTION_SETTINGS_ID },
    select: {
      emailLogRetentionYears: true, rejectedApplicationRetentionYears: true,
      formerMemberRetentionYears: true, pruneLogsAndApplicationsEnabled: true,
      anonymiseMembersEnabled: true, sentryReplayEnabled: true,
    },
  });
  return privacyRetentionSettingsSchema.parse(row ?? DEFAULT_PRIVACY_RETENTION_SETTINGS);
}

export async function savePrivacyRetentionSettings(
  input: PrivacyRetentionSettingsValues,
  actorId: string,
): Promise<PrivacyRetentionSettingsValues> {
  const values = privacyRetentionSettingsSchema.parse(input);
  await prisma.$transaction(async (tx) => {
    await tx.privacyRetentionSettings.upsert({
      where: { id: PRIVACY_RETENTION_SETTINGS_ID },
      create: { id: PRIVACY_RETENTION_SETTINGS_ID, ...values, updatedByMemberId: actorId },
      update: { ...values, updatedByMemberId: actorId },
    });
    await createAuditLog({
      action: "privacy.retention.settings_updated", category: "admin",
      actorMemberId: actorId, memberId: actorId,
      entityType: "PrivacyRetentionSettings", entityId: PRIVACY_RETENTION_SETTINGS_ID,
      summary: "Privacy retention settings updated", metadata: values,
    }, tx);
  });
  return values;
}

/** Public rendering fails closed if the settings store is unavailable. */
export async function getSentryReplayEnabled(): Promise<boolean> {
  try { return (await getPrivacyRetentionSettings()).sentryReplayEnabled; }
  catch { return false; }
}
