import { z } from "zod";

/** Club policy lives here, shared by the editor, reader and jobs (INV-CONFIG). */
export const privacyRetentionSettingsSchema = z.object({
  emailLogRetentionYears: z.number().int().min(1).max(100),
  rejectedApplicationRetentionYears: z.number().int().min(1).max(100),
  formerMemberRetentionYears: z.number().int().min(1).max(100),
  pruneLogsAndApplicationsEnabled: z.boolean(),
  anonymiseMembersEnabled: z.boolean(),
  sentryReplayEnabled: z.boolean(),
}).strict();

export type PrivacyRetentionSettingsValues = z.infer<typeof privacyRetentionSettingsSchema>;
export const DEFAULT_PRIVACY_RETENTION_SETTINGS: PrivacyRetentionSettingsValues = {
  emailLogRetentionYears: 2,
  rejectedApplicationRetentionYears: 1,
  formerMemberRetentionYears: 7,
  pruneLogsAndApplicationsEnabled: false,
  anonymiseMembersEnabled: false,
  sentryReplayEnabled: false,
};

/** The retention jobs' recorded names: admin cron health and the scheduler share them. */
export const PRIVACY_DATA_PRUNE_JOB_NAME = "privacy-data-prune";
export const FORMER_MEMBER_ANONYMISATION_JOB_NAME = "former-member-anonymisation";

/** These settings can remove applications or member profiles. */
export const MEMBERSHIP_RETENTION_FIELDS = new Set<keyof PrivacyRetentionSettingsValues>([
  "rejectedApplicationRetentionYears", "formerMemberRetentionYears",
  "pruneLogsAndApplicationsEnabled", "anonymiseMembersEnabled",
]);
