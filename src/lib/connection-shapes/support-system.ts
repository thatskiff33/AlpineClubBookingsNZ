/**
 * What the Support area's system officer actions return (ALP-724,
 * `INV-MCP-006`): the health report, the running process's status, Stuck
 * States, the setup checklist, provider tests, backups, the modules, the
 * club's currency and locale, the sign-in rules, the access roles, privacy
 * retention, and Admin Overview's work-queue counts. The catalogue entry and
 * the route's `connectionJson` both read these (`INV-SSOT`).
 *
 * Kept: the states, counts and messages an officer reads to see what needs
 * attention. Dropped: raw job and webhook rows (their payloads can carry
 * member data), website links, the backup directory's path and file names,
 * process memory, monitoring links, and the ids of the officers who last
 * saved a setting. A health report's failed email lists the recipient's
 * address and subject, as the queue on the website does: the officer must
 * know whose mail failed.
 *
 * Types only from the lib modules: nothing here reaches the database.
 */
import type { AccessRoleDefinitionSummary } from "@/lib/access-role-definitions";
import type { AdminPendingCounts } from "@/lib/admin-work-queues";
import type { CronHealthReport } from "@/lib/admin-cron-health";
import type { BackupRunSummary } from "@/lib/backup-run";
import type { ClubFormatState } from "@/lib/club-format-admin-state";
import {
  completeConnectionShapeFor,
  connectionShapeFor,
  eachEntry,
  type ConnectionShapeFor,
} from "@/lib/connection-projection";
import type { getAdminAlertDeliveryEscalations } from "@/lib/email-admin-alert-escalation";
import type { getExhaustedEmailFailureReviewQueue } from "@/lib/email-failure-review";
import type { getEmailDeliverabilityTelemetry } from "@/lib/email-suppression";
import type { DetailedHealthReport, RuntimeStatusReport } from "@/lib/health-check";
import type { LoginSecuritySettingsPayload } from "@/lib/login-security-settings";
import type { ClubModuleSettingsPayload } from "@/lib/module-settings";
import type { getPrivacyRetentionPreview } from "@/lib/privacy-retention";
import type { PrivacyRetentionSettingsValues } from "@/lib/privacy-retention-shared";
import type { SetupProgressState, SetupReadiness } from "@/lib/setup-readiness";
import type { StuckStateDashboard } from "@/lib/stuck-state-dashboard";

import { EMAIL_FAILURE_SHAPE } from "./support-messages";

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

/** The health route's answer, as the admin health page reads it. */
export interface AdminHealthAnswer {
  health: DetailedHealthReport;
  cronJobs: unknown;
  cronHealth: CronHealthReport;
  webhookStats: Record<string, { success: number; failure: number; total: number }>;
  recentWebhooks: unknown;
  emailDeliverability: Awaited<ReturnType<typeof getEmailDeliverabilityTelemetry>>;
  emailFailures: Awaited<ReturnType<typeof getExhaustedEmailFailureReviewQueue>>;
  adminAlertDelivery: Awaited<ReturnType<typeof getAdminAlertDeliveryEscalations>>;
  tokenEmailRecovery: unknown;
  systemInfo: { version: string; nodeVersion: string; uptime: number };
}

const CHECK_SHAPE = { status: true, latencyMs: true, error: true } as const;

export const ADMIN_HEALTH_CONNECTION_SHAPE = connectionShapeFor<AdminHealthAnswer>({
  health: {
    status: true,
    version: true,
    uptime: true,
    checks: {
      db: CHECK_SHAPE,
      config: CHECK_SHAPE,
      stripe: CHECK_SHAPE,
      xero: CHECK_SHAPE,
      smtp: CHECK_SHAPE,
      paymentRecovery: CHECK_SHAPE,
    },
  },
  cronHealth: {
    generatedAt: true,
    cronEnabled: true,
    defaultTimezone: true,
    configuredTimezone: true,
    runningTimezone: true,
    timezoneRestartRequired: true,
    jobs: {
      jobName: true,
      label: true,
      schedule: true,
      timezone: true,
      expectedLocalTime: true,
      enabled: true,
      disabledReason: true,
      status: true,
      severity: true,
      summary: true,
      staleThreshold: true,
      latestRunAt: true,
      latestRunStatus: true,
      latestSuccessAt: true,
      latestFailureAt: true,
    },
  },
  webhookStats: eachEntry({ success: true, failure: true, total: true }),
  emailDeliverability: {
    summary: { activeCount: true, bounceCount: true, complaintCount: true, eventsLast24h: true },
  },
  emailFailures: {
    summary: {
      activeCount: true,
      reviewedCount: true,
      scannedCount: true,
      totalExhaustedCount: true,
      scanLimit: true,
      scanCapped: true,
      maxAttempts: true,
    },
    failures: EMAIL_FAILURE_SHAPE,
  },
  adminAlertDelivery: {
    summary: { recentCount: true, lookbackDays: true },
    escalations: {
      id: true,
      templateName: true,
      preferenceKey: true,
      attemptedRecipientCount: true,
      suppressedRecipientCount: true,
      failedRecipientCount: true,
      createdAt: true,
    },
  },
  systemInfo: { version: true, nodeVersion: true, uptime: true },
});

/** Every field: which process answered and how it is set to run. */
export const RUNTIME_STATUS_CONNECTION_SHAPE = completeConnectionShapeFor<RuntimeStatusReport>({
  cronEnabled: true,
  role: true,
  clubTimeZone: true,
  environmentRole: true,
});

// ---------------------------------------------------------------------------
// Stuck States
// ---------------------------------------------------------------------------

/** The named rows under a card come only to an officer who may see them (#2823, #4959). */
export const STUCK_STATES_CONNECTION_SHAPE = connectionShapeFor<StuckStateDashboard>({
  generatedAt: true,
  totals: { affectedCount: true, itemCount: true, critical: true, warning: true, info: true },
  domains: {
    domain: true,
    label: true,
    count: true,
    itemCount: true,
    critical: true,
    warning: true,
    info: true,
    highestSeverity: true,
  },
  items: {
    id: true,
    domain: true,
    domainLabel: true,
    title: true,
    severity: true,
    owner: true,
    count: true,
    summary: true,
    details: { id: true, title: true, summary: true },
  },
});

// ---------------------------------------------------------------------------
// The setup checklist and provider tests
// ---------------------------------------------------------------------------

const SETUP_PROGRESS_SHAPE = {
  completedStepIds: true,
  skippedStepIds: true,
  completedAt: true,
} as const satisfies ConnectionShapeFor<SetupProgressState>;

export const SETUP_READINESS_CONNECTION_SHAPE = connectionShapeFor<{
  readiness: SetupReadiness;
  progress: SetupProgressState;
}>({
  readiness: {
    status: true,
    summary: { total: true, complete: true, warning: true, blocked: true, skipped: true },
    categories: {
      id: true,
      title: true,
      description: true,
      status: true,
      checks: {
        id: true,
        title: true,
        description: true,
        status: true,
        required: true,
        message: true,
        details: true,
        action: { type: true, provider: true, label: true },
        progress: true,
      },
    },
    generatedAt: true,
  },
  progress: SETUP_PROGRESS_SHAPE,
});

export const SETUP_PROGRESS_CONNECTION_SHAPE = connectionShapeFor<{ progress: SetupProgressState }>({
  progress: SETUP_PROGRESS_SHAPE,
});

/** A provider test's answer: whether it passed, and what the provider said (a failure stays generic). */
export interface ProviderTestAnswer {
  ok: boolean;
  provider: string;
  checkedAt: string;
  message: string;
}

export const PROVIDER_TEST_CONNECTION_SHAPE = completeConnectionShapeFor<ProviderTestAnswer>({
  ok: true,
  provider: true,
  checkedAt: true,
  message: true,
});

// ---------------------------------------------------------------------------
// Backups
// ---------------------------------------------------------------------------

/** The backup status route's answer. Never a secret value (#2079). */
export interface BackupStatusAnswer {
  enabled: boolean;
  bucket: string | null;
  region: string | null;
  retentionDays: number | null;
  accessKeyIdSet: boolean;
  secretAccessKeySet: boolean;
  restoreValidationUrlSet: boolean;
  localEnabled: boolean;
  localPath: string | null;
  localPathFromEnv: boolean;
  anyDestinationEnabled: boolean;
  localBackups: Array<{ filename: string; sizeBytes: number; modifiedAt: string }>;
  localDiskSpace: { availableBytes: number; totalBytes: number; level: string } | null;
  localError: string | null;
  durable: boolean;
  needsReentry: boolean;
  running: boolean;
  activeRun: BackupRunSummary | null;
  recentRuns: BackupRunSummary[];
  legacyEnvVars: string[];
  legacyEnvUnmigrated: boolean;
  cronSchedule: string;
  canManageDestination: boolean;
}

const BACKUP_RUN_SHAPE = {
  id: true,
  status: true,
  trigger: true,
  startedAt: true,
  completedAt: true,
  durationMs: true,
  error: true,
} as const satisfies ConnectionShapeFor<BackupRunSummary>;

export const BACKUP_STATUS_CONNECTION_SHAPE = connectionShapeFor<BackupStatusAnswer>({
  enabled: true,
  localEnabled: true,
  anyDestinationEnabled: true,
  retentionDays: true,
  durable: true,
  needsReentry: true,
  localDiskSpace: { availableBytes: true, totalBytes: true, level: true },
  localError: true,
  running: true,
  activeRun: BACKUP_RUN_SHAPE,
  recentRuns: BACKUP_RUN_SHAPE,
  legacyEnvUnmigrated: true,
  cronSchedule: true,
});

/** Run-now's answer: the backup started in the background. */
export interface BackupStartedAnswer {
  ok: boolean;
  started: boolean;
}

export const BACKUP_STARTED_CONNECTION_SHAPE = connectionShapeFor<BackupStartedAnswer>({ ok: true, started: true });

// ---------------------------------------------------------------------------
// Modules, the club's format, sign-in rules, access roles
// ---------------------------------------------------------------------------

export const CLUB_MODULES_CONNECTION_SHAPE = connectionShapeFor<ClubModuleSettingsPayload>({
  modules: {
    key: true,
    label: true,
    description: true,
    adminEnabled: true,
    effectiveEnabled: true,
    readiness: { status: true, message: true, dependencies: true },
  },
  updatedAt: true,
});

/** The club-format read; only a Full Admin's carries the in-flight card count. */
export const CLUB_FORMAT_CONNECTION_SHAPE = connectionShapeFor<{ state: ClubFormatState; inFlight: unknown }>({
  state: {
    currencyCode: true,
    locale: true,
    currencySource: true,
    localeSource: true,
    updatedAt: true,
    unusableStoredCurrency: true,
    unusableStoredLocale: true,
  },
});

export const PASSWORD_POLICY_CONNECTION_SHAPE = connectionShapeFor<LoginSecuritySettingsPayload>({
  policy: {
    minPasswordLength: true,
    requireUppercase: true,
    requireLowercase: true,
    requireDigit: true,
    requireSymbol: true,
    magicLinkTtlMinutes: true,
    breachedPasswordCheck: true,
    sessionMaxAgeHours: true,
  },
  updatedAt: true,
});

/** The officer two-step sign-in rule's read. */
export interface OfficerTwoFactorPolicyAnswer {
  officerTwoFactorPolicy: boolean;
  officerTwoFactorGraceDays: number;
}

export const OFFICER_TWO_FACTOR_POLICY_CONNECTION_SHAPE = completeConnectionShapeFor<OfficerTwoFactorPolicyAnswer>({
  officerTwoFactorPolicy: true,
  officerTwoFactorGraceDays: true,
});

/** The access roles route's answer: each role with how many people hold it. */
export interface AccessRoleListAnswer {
  roles: Array<AccessRoleDefinitionSummary & { memberCount: number }>;
  roleOptions: unknown;
}

export const ACCESS_ROLE_LIST_CONNECTION_SHAPE = connectionShapeFor<AccessRoleListAnswer>({
  roles: {
    id: true,
    key: true,
    systemRole: true,
    label: true,
    description: true,
    sortOrder: true,
    permissions: eachEntry(true),
    requiresTwoFactor: true,
    memberCount: true,
  },
});

// ---------------------------------------------------------------------------
// Privacy retention
// ---------------------------------------------------------------------------

type RetentionPreview = Awaited<ReturnType<typeof getPrivacyRetentionPreview>>;

/** The retention route's read; the member lists come only with Membership view. */
export interface PrivacyRetentionAnswer {
  settings: PrivacyRetentionSettingsValues;
  clearedBookingDietary: number;
  preview: Partial<
    Pick<RetentionPreview, "emailLogs" | "rejectedApplications" | "formerMembers" | "blockedMembers" | "undatedMembers">
  >;
  formerMemberCandidateCount?: number;
  memberHasMore?: boolean;
  memberNextCursor?: string | null;
  page: number;
  pageSize: number;
  canViewMembership: boolean;
}

const RETENTION_SETTINGS_SHAPE = {
  emailLogRetentionYears: true,
  rejectedApplicationRetentionYears: true,
  formerMemberRetentionYears: true,
  pruneLogsAndApplicationsEnabled: true,
  anonymiseMembersEnabled: true,
  sentryReplayEnabled: true,
  bookingDietaryRetentionDays: true,
  bookingDietaryClearEnabled: true,
} as const satisfies ConnectionShapeFor<PrivacyRetentionSettingsValues>;

const RETENTION_GROUP_SHAPE = { count: true, rows: { id: true, date: true, reasons: true } } as const;

export const PRIVACY_RETENTION_CONNECTION_SHAPE = connectionShapeFor<PrivacyRetentionAnswer>({
  settings: RETENTION_SETTINGS_SHAPE,
  clearedBookingDietary: true,
  preview: {
    emailLogs: RETENTION_GROUP_SHAPE,
    rejectedApplications: RETENTION_GROUP_SHAPE,
    formerMembers: RETENTION_GROUP_SHAPE,
    blockedMembers: RETENTION_GROUP_SHAPE,
    undatedMembers: RETENTION_GROUP_SHAPE,
  },
  formerMemberCandidateCount: true,
  memberHasMore: true,
  memberNextCursor: true,
  page: true,
  pageSize: true,
  canViewMembership: true,
});

export const PRIVACY_RETENTION_SAVED_CONNECTION_SHAPE = connectionShapeFor<{
  settings: PrivacyRetentionSettingsValues;
}>({
  settings: RETENTION_SETTINGS_SHAPE,
});

// ---------------------------------------------------------------------------
// Admin Overview: the work-queue counts
// ---------------------------------------------------------------------------

/** Every count, and which could not be read. Counts only, never a name. */
export const ADMIN_PENDING_COUNTS_CONNECTION_SHAPE = completeConnectionShapeFor<AdminPendingCounts>({
  xeroSilentWebhook: true,
  familyRequests: true,
  memberApplications: true,
  refundAppeals: true,
  manualRefundTasks: true,
  creditApprovals: true,
  bookingReviews: true,
  lockedPeriodChangeRequests: true,
  policyExceptionRequests: true,
  publicBookingRequests: true,
  unpaidFinishedStays: true,
  unsettledAdditionalFinishedStays: true,
  unsettledAdditionalUpcomingStays: true,
  membershipCancellations: true,
  archiveRequests: true,
  deletionRequests: true,
  memberDeleteRequests: true,
  issueReports: true,
  unassignedHutLeaderDates: true,
  stuckStatesAffected: true,
  unavailable: true,
});
