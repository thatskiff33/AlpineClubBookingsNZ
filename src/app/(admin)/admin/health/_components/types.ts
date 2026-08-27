export interface HealthCheck {
  status: "ok" | "error";
  latencyMs: number;
  error?: string;
}

interface CronRun {
  id: string;
  jobName: string;
  startedAt: string;
  completedAt: string | null;
  durationMs: number | null;
  status: string;
  resultSummary: Record<string, unknown> | null;
  error: string | null;
}

interface WebhookLogEntry {
  id: string;
  source: string;
  eventType: string;
  eventId: string;
  status: string;
  durationMs: number;
  error: string | null;
  createdAt: string;
}

type CronHealthStatus =
  | "current"
  | "stale"
  | "failed"
  | "skipped"
  | "missing"
  | "disabled"
  | "untracked"
  | "unknown";

interface CronHealthJob {
  jobName: string;
  label: string;
  schedule: string;
  timezone: string;
  expectedLocalTime: string;
  staleAfterMinutes: number | null;
  enabled: boolean;
  disabledReason: string | null;
  recordsRuns: boolean;
  note?: string;
  status: CronHealthStatus;
  severity: "ok" | "warning" | "error" | "info";
  summary: string;
  staleThreshold: string | null;
  latestRunAt: string | null;
  latestRunStatus: string | null;
  latestSuccessAt: string | null;
  latestFailureAt: string | null;
}

interface CronHealthReport {
  generatedAt: string;
  cronEnabled: boolean;
  /** The zone the "expected" times below are stated in (CT-5, #2869). */
  defaultTimezone: string;
  /** The club's persisted setting; a running job adopts it only on restart. */
  configuredTimezone: string;
  /** The zone the scheduler pinned at boot, or `null` when unknown. */
  runningTimezone: string | null;
  /** True when the two are known to differ, so a restart is outstanding. */
  timezoneRestartRequired: boolean;
  jobs: CronHealthJob[];
}

interface EmailSuppressionEntry {
  id: string;
  email: string;
  reason: "BOUNCE" | "COMPLAINT";
  eventCount: number;
  suppressedAt: string | null;
  lastEventAt: string;
  lastEventType: string;
  lastBounceType: string | null;
  lastBounceSubType: string | null;
  lastComplaintFeedbackType: string | null;
  lastSesMessageId: string | null;
}

interface ExhaustedEmailFailure {
  id: string;
  to: string;
  subject: string;
  templateName: string;
  attempts: number;
  lastAttemptAt: string;
  errorMessage: string | null;
  createdAt: string;
  reviewedAt: string | null;
  reviewedById: string | null;
  reviewNote: string | null;
}

interface AdminAlertDeliveryEscalation {
  id: string;
  templateName: string;
  preferenceKey: string;
  attemptedRecipientCount: number;
  suppressedRecipientCount: number;
  failedRecipientCount: number;
  createdAt: string;
}

interface TokenEmailRecoveryFailure {
  id: string;
  to: string;
  subject: string;
  templateName: string;
  status: string;
  lastAttemptAt: string;
  errorMessage: string | null;
  createdAt: string;
  reissuedAt: string | null;
  reissuedById: string | null;
}

export interface HealthData {
  health: {
    status: string;
    version: string;
    uptime: number;
    checks: {
      db?: HealthCheck;
      config?: HealthCheck;
      stripe?: HealthCheck;
      xero?: HealthCheck;
      smtp?: HealthCheck;
    };
  };
  cronJobs: Record<string, CronRun[]>;
  cronHealth?: CronHealthReport;
  webhookStats: Record<string, { success: number; failure: number; total: number }>;
  recentWebhooks: WebhookLogEntry[];
  emailDeliverability: {
    summary: {
      activeCount: number;
      bounceCount: number;
      complaintCount: number;
      eventsLast24h: number;
    };
    suppressions: EmailSuppressionEntry[];
  };
  emailFailures: {
    summary: {
      activeCount: number;
      reviewedCount: number;
      scannedCount: number;
      maxAttempts: number;
    };
    failures: ExhaustedEmailFailure[];
    recentlyReviewed: ExhaustedEmailFailure[];
  };
  adminAlertDelivery: {
    summary: {
      recentCount: number;
      lookbackDays: number;
    };
    escalations: AdminAlertDeliveryEscalation[];
  };
  tokenEmailRecovery: {
    summary: {
      activeCount: number;
      reissuedCount: number;
      scannedCount: number;
    };
    failures: TokenEmailRecoveryFailure[];
    recentlyReissued: TokenEmailRecoveryFailure[];
  };
  systemInfo: {
    version: string;
    nodeVersion: string;
    uptime: number;
    memoryMb: { rss: number; heapUsed: number; heapTotal: number };
    sentryConfigured: boolean;
    sentryDashboardUrl: string | null;
    sentryConfigWarning: string | null;
  };
}
