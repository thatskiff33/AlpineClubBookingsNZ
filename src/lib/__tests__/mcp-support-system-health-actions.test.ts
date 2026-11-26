/**
 * ALP-724 (`INV-MCP-006`): the Support area's attention and housekeeping
 * actions an officer's AI app connection may run: the health report, the
 * running process, Stuck States, Admin Overview's work-queue counts, the
 * setup checklist and provider tests, and backups. Each route answers the
 * browser as before; the connection gets exactly the action's `returns`
 * fields (`expectActionContract`). Every handler runs twice (connection, then
 * browser), so the mocks answer both runs.
 *
 * What a connection must never be sent here: raw scheduled-job or webhook
 * rows (their payloads can carry member data), website links, the backup
 * directory and file names, process memory, or a failed email's link to
 * resend it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const prisma = {
    webhookLog: { findMany: vi.fn() },
    setupProgress: { findUnique: vi.fn(), upsert: vi.fn() },
  };
  return {
    prisma,
    requireAdmin: vi.fn(),
    healthReport: vi.fn(),
    runtimeStatus: vi.fn(),
    clubTimeZone: vi.fn(),
    cronRuns: vi.fn(),
    cronDefinitions: vi.fn(),
    cronReport: vi.fn(),
    cronByJob: vi.fn(),
    webhookStats: vi.fn(),
    failures: vi.fn(),
    deliverability: vi.fn(),
    alertEscalations: vi.fn(),
    tokenRecovery: vi.fn(),
    sentryInfo: vi.fn(),
    stuckStates: vi.fn(),
    pendingCounts: vi.fn(),
    setupSnapshot: vi.fn(),
    xeroBaseCurrency: vi.fn(),
    buildReadiness: vi.fn(),
    logAudit: vi.fn(),
    xeroConnection: vi.fn(),
    backupState: vi.fn(),
    backupConfig: vi.fn(),
    recentRuns: vi.fn(),
    activeRun: vi.fn(),
    runBackup: vi.fn(),
    localBackups: vi.fn(),
    diskSpace: vi.fn(),
    createAuditLog: vi.fn(),
    sentryCapture: vi.fn(),
  };
});

vi.mock("server-only", () => ({}));
vi.mock("@/lib/session-guards", () => ({ requireAdmin: h.requireAdmin }));
vi.mock("@/lib/prisma", () => ({ prisma: h.prisma }));
vi.mock("@/lib/audit", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/audit")),
  logAudit: h.logAudit,
  createAuditLog: h.createAuditLog,
}));
vi.mock("@/lib/app-version", () => ({ getAppVersion: () => "2026.07.1" }));
vi.mock("@/lib/health-check", () => ({ getDetailedHealthReport: h.healthReport, getRuntimeStatus: h.runtimeStatus }));
vi.mock("@/lib/observability/sentry-dashboard-info", () => ({ buildSentryDashboardInfo: h.sentryInfo }));
vi.mock("@/lib/webhook-log", () => ({ getWebhookStats: h.webhookStats }));
vi.mock("@/lib/email-failure-review", () => ({ getExhaustedEmailFailureReviewQueue: h.failures }));
vi.mock("@/lib/email-suppression", () => ({ getEmailDeliverabilityTelemetry: h.deliverability }));
vi.mock("@/lib/email-admin-alert-escalation", () => ({ getAdminAlertDeliveryEscalations: h.alertEscalations }));
vi.mock("@/lib/token-email-recovery", () => ({ getTokenEmailRecoveryQueue: h.tokenRecovery }));
vi.mock("@/lib/admin-cron-health", () => ({
  buildCronHealthReport: h.cronReport,
  getAdminCronJobDefinitions: h.cronDefinitions,
  groupCronRunsByJob: h.cronByJob,
}));
vi.mock("@/lib/admin-cron-runs", () => ({ getCronRunsForAdminHealth: h.cronRuns }));
vi.mock("@/lib/club-time-zone-settings", () => ({ getClubTimeZone: h.clubTimeZone }));
vi.mock("@/lib/cron-runtime-zone", () => ({ readCronRuntimeZone: () => "Pacific/Auckland" }));
vi.mock("@/lib/stuck-state-dashboard", () => ({ getStuckStateDashboard: h.stuckStates }));
vi.mock("@/lib/admin-pending-counts", () => ({ getAdminPendingCounts: h.pendingCounts }));
vi.mock("@/lib/setup-readiness-db", () => ({ getSetupDatabaseSnapshot: h.setupSnapshot }));
vi.mock("@/lib/xero-base-currency-server", () => ({ readXeroBaseCurrencyForViewer: h.xeroBaseCurrency }));
vi.mock("@/lib/setup-readiness", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/setup-readiness")),
  buildSetupReadiness: h.buildReadiness,
}));
vi.mock("@/lib/xero-connection", () => ({ readXeroConnection: h.xeroConnection }));
vi.mock("@/lib/stripe", () => ({ getStripe: vi.fn() }));
vi.mock("@/lib/stripe-config", () => ({ getOperationalStripeSecretKey: vi.fn() }));
vi.mock("@/lib/backup-config", () => ({
  BACKUP_PROVIDER: "backup",
  getBackupSetupState: h.backupState,
  resolveBackupConfig: h.backupConfig,
  isAnyBackupDestinationEnabled: () => true,
}));
vi.mock("@/lib/backup-run", () => ({
  getRecentBackupRuns: h.recentRuns,
  getActiveBackupRun: h.activeRun,
  runManagedBackup: h.runBackup,
}));
vi.mock("@/lib/backup-local", () => ({ listLocalBackups: h.localBackups, getLocalBackupDiskSpace: h.diskSpace }));
vi.mock("@sentry/nextjs", () => ({ captureMessage: h.sentryCapture, flush: async () => true }));
vi.mock("@/lib/xero-config", () => ({ detectLegacyProviderEnv: () => [] }));

import { POST as runBackup } from "@/app/api/admin/backups/run/route";
import { GET as backupStatus } from "@/app/api/admin/backups/status/route";
import { GET as getHealth } from "@/app/api/admin/health/route";
import { GET as getPendingCounts } from "@/app/api/admin/pending-counts/route";
import { GET as getRuntimeStatus } from "@/app/api/admin/runtime-status/route";
import { PATCH as patchProgress } from "@/app/api/admin/setup/progress/route";
import { POST as testProvider } from "@/app/api/admin/setup/provider-test/route";
import { GET as getSetup } from "@/app/api/admin/setup/route";
import { GET as getStuckStates } from "@/app/api/admin/stuck-states/route";
import { expectActionContract, officerMemberSession } from "@/lib/__tests__/helpers/mcp-action-contract";
import { ZERO_ADMIN_PENDING_COUNTS } from "@/lib/admin-work-queues";
import { findMcpAction, mcpActionInputSchema, splitMcpActionArguments } from "@/lib/mcp/catalogue";

const STAMP = new Date("2026-06-30T00:00:00.000Z");
const ISO = STAMP.toISOString();

beforeEach(() => {
  vi.clearAllMocks();
  h.requireAdmin.mockResolvedValue({ ok: true, session: officerMemberSession() });
  h.logAudit.mockResolvedValue(undefined);
  h.createAuditLog.mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------
// Health and attention
// ---------------------------------------------------------------------------

function check(status: "ok" | "error" = "ok") {
  return { status, latencyMs: 4, error: status === "error" ? "Not configured" : "none" };
}

describe("get_system_health", () => {
  beforeEach(() => {
    h.healthReport.mockResolvedValue({
      httpStatus: 200,
      report: {
        status: "degraded",
        version: "2026.07.1",
        uptime: 60,
        checks: {
          db: check(),
          config: check(),
          stripe: check(),
          xero: check("error"),
          smtp: check(),
          paymentRecovery: check(),
        },
      },
    });
    h.clubTimeZone.mockResolvedValue("Pacific/Auckland");
    h.cronDefinitions.mockReturnValue([]);
    h.cronRuns.mockResolvedValue([]);
    h.cronByJob.mockReturnValue({
      "email-retry": [{ id: "run-1", jobName: "email-retry", resultSummary: { emailedTo: "member@example.test" } }],
    });
    h.cronReport.mockReturnValue({
      generatedAt: ISO,
      cronEnabled: true,
      defaultTimezone: "Pacific/Auckland",
      configuredTimezone: "Pacific/Auckland",
      runningTimezone: "Pacific/Auckland",
      timezoneRestartRequired: false,
      jobs: [
        {
          jobName: "email-retry",
          label: "Email retry",
          schedule: "*/15 * * * *",
          timezone: "Pacific/Auckland",
          expectedLocalTime: "Every 15 minutes",
          staleAfterMinutes: 60,
          enabled: true,
          disabledReason: null,
          recordsRuns: true,
          note: "Retries failed email.",
          status: "current",
          severity: "ok",
          summary: "Ran 3 minutes ago.",
          staleThreshold: "1h",
          latestRunAt: ISO,
          latestRunStatus: "SUCCESS",
          latestSuccessAt: ISO,
          latestFailureAt: null,
        },
      ],
    });
    h.webhookStats.mockResolvedValue({ stripe: { success: 4, failure: 0, total: 4 } });
    h.deliverability.mockResolvedValue({
      summary: { activeCount: 1, bounceCount: 1, complaintCount: 0, eventsLast24h: 0 },
      suppressions: [{ id: "suppression-1", email: "bounced@example.test" }],
    });
    h.failures.mockResolvedValue({
      summary: {
        activeCount: 1,
        reviewedCount: 0,
        scannedCount: 1,
        totalExhaustedCount: 1,
        scanLimit: 200,
        scanCapped: false,
        maxAttempts: 5,
      },
      failures: [
        {
          id: "email-1",
          to: "member@example.test",
          subject: "Your booking",
          templateName: "booking-confirmed",
          attempts: 5,
          lastAttemptAt: ISO,
          errorMessage: "Mailbox full",
          createdAt: ISO,
          bookingId: "booking-1",
          bookingExists: true,
          bookingRecipientMemberId: "member-1",
          recovery: "retry",
          freshCopyHref: "/admin/bookings/booking-1#emails",
          reviewedAt: ISO,
          reviewedById: "officer-9",
          reviewNote: "Checked",
        },
      ],
      archived: [],
    });
    h.alertEscalations.mockResolvedValue({
      summary: { recentCount: 1, lookbackDays: 7 },
      escalations: [
        {
          id: "escalation-1",
          templateName: "admin-new-booking",
          preferenceKey: "adminNewBooking",
          attemptedRecipientCount: 2,
          suppressedRecipientCount: 1,
          failedRecipientCount: 1,
          createdAt: ISO,
        },
      ],
    });
    h.tokenRecovery.mockResolvedValue({ summary: { activeCount: 0 }, failures: [], recentlyReissued: [] });
    h.prisma.webhookLog.findMany.mockResolvedValue([{ id: "webhook-1", payload: { email: "member@example.test" } }]);
    h.sentryInfo.mockReturnValue({ sentryDashboardUrl: "https://sentry.io/organizations/club/issues/" });
  });

  it("sends the checks, job health and email queues without raw rows, links or memory", async () => {
    const { connection, browser } = await expectActionContract({ actionId: "get_system_health", handler: getHealth });
    const sent = JSON.stringify(connection);
    expect(sent).not.toContain("webhook-1");
    expect(sent).not.toContain("run-1");
    expect(sent).not.toContain("sentry.io");
    expect(sent).not.toContain("#emails");
    expect(sent).not.toContain("memoryMb");
    // The officer must know whose mail failed, as on the website.
    expect(sent).toContain("member@example.test");
    expect(JSON.stringify(browser)).toContain("webhook-1");
  });

  it("redacts a failed check's provider message for a connection only", async () => {
    const report = await h.healthReport();
    h.healthReport.mockResolvedValue({
      ...report,
      report: {
        ...report.report,
        checks: { ...report.report.checks, smtp: { status: "error", latencyMs: 4, error: "Rejected: Bearer abc123SecretToken" } },
      },
    });
    const { connection, browser } = await expectActionContract({ actionId: "get_system_health", handler: getHealth });
    expect(JSON.stringify(connection)).not.toContain("abc123SecretToken");
    expect(JSON.stringify(connection)).toContain("Rejected: Bearer");
    expect(JSON.stringify(browser)).toContain("abc123SecretToken");
  });
});

describe("get_runtime_status", () => {
  it("sends the process's status whole", async () => {
    const status = { cronEnabled: true, role: "web-blue", clubTimeZone: null, environmentRole: "production" };
    h.runtimeStatus.mockReturnValue(status);
    const { connection } = await expectActionContract({ actionId: "get_runtime_status", handler: getRuntimeStatus });
    expect(connection).toEqual(status);
  });
});

describe("get_stuck_states", () => {
  it("sends each card and its named rows without links, decided on the officer's own areas", async () => {
    h.stuckStates.mockResolvedValue({
      generatedAt: ISO,
      totals: { affectedCount: 2, itemCount: 1, critical: 1, warning: 0, info: 0 },
      domains: [
        {
          domain: "payment",
          label: "Payments",
          count: 2,
          itemCount: 1,
          critical: 1,
          warning: 0,
          info: 0,
          highestSeverity: "critical",
        },
      ],
      items: [
        {
          id: "payment-exhausted",
          domain: "payment",
          domainLabel: "Payments",
          title: "Failed payments",
          severity: "critical",
          owner: "Finance",
          count: 2,
          href: "/admin/finance/payments",
          summary: "Two payments failed every retry.",
          details: [{ id: "detail-1", title: "BK-1 - Ana Reid", summary: "Failed", href: "/bookings/booking-1" }],
        },
      ],
    });
    const { connection } = await expectActionContract({ actionId: "get_stuck_states", handler: getStuckStates });
    expect(JSON.stringify(connection)).not.toContain("href");
    // The officer's own matrix decides the named rows: a Full Admin sees them.
    expect(h.stuckStates).toHaveBeenCalledWith({ viewerCanViewMembership: true, viewerCanViewFinance: true });
  });
});

describe("get_officer_work_queue_counts", () => {
  it("sends every count and which could not be read", async () => {
    h.pendingCounts.mockResolvedValue({ ...ZERO_ADMIN_PENDING_COUNTS, issueReports: 3, unavailable: ["xeroSilentWebhook"] });
    const { connection } = await expectActionContract({
      actionId: "get_officer_work_queue_counts",
      handler: getPendingCounts,
    });
    expect(connection).toMatchObject({ issueReports: 3, unavailable: ["xeroSilentWebhook"] });
  });
});

// ---------------------------------------------------------------------------
// The setup checklist and provider tests
// ---------------------------------------------------------------------------

const PROGRESS_ROW = {
  id: "default",
  completedStepIds: ["club-config"],
  skippedStepIds: ["sentry"],
  completedAt: null,
  completedByMemberId: null,
};

describe("get_setup_readiness", () => {
  it("sends each check without its link, and the progress without who finished it", async () => {
    h.setupSnapshot.mockResolvedValue({});
    h.prisma.setupProgress.findUnique.mockResolvedValue({ ...PROGRESS_ROW, completedAt: STAMP, completedByMemberId: "officer-9" });
    h.xeroBaseCurrency.mockResolvedValue(null);
    h.buildReadiness.mockReturnValue({
      status: "warning",
      summary: { total: 1, complete: 0, warning: 1, blocked: 0, skipped: 0 },
      categories: [
        {
          id: "integrations",
          title: "Integrations",
          description: "Outside services.",
          status: "warning",
          checks: [
            {
              id: "stripe",
              title: "Stripe",
              description: "Card payments.",
              status: "warning",
              required: false,
              message: "Not tested yet.",
              details: ["Key saved."],
              href: "/admin/setup/stripe",
              action: { type: "provider-test", provider: "stripe", label: "Test Stripe" },
              progress: "open",
            },
          ],
        },
      ],
      generatedAt: ISO,
    });
    const { connection } = await expectActionContract({ actionId: "get_setup_readiness", handler: getSetup });
    const sent = JSON.stringify(connection);
    expect(sent).not.toContain("/admin/setup/stripe");
    expect(sent).not.toContain("officer-9");
  });
});

describe("the setup progress actions", () => {
  beforeEach(() => {
    h.prisma.setupProgress.findUnique.mockResolvedValue(PROGRESS_ROW);
  });

  it("update_setup_step ticks one step", async () => {
    h.prisma.setupProgress.upsert.mockResolvedValue({ ...PROGRESS_ROW, completedStepIds: ["club-config", "stripe"] });
    const { connection } = await expectActionContract({
      actionId: "update_setup_step",
      handler: patchProgress,
      args: { action: "complete", stepId: "stripe" },
    });
    expect(connection).toEqual({
      progress: { completedStepIds: ["club-config", "stripe"], skippedStepIds: ["sentry"], completedAt: null },
    });
    expect(h.prisma.setupProgress.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: expect.objectContaining({ completedStepIds: ["club-config", "stripe"] }) }),
    );
  });

  it("offers a step action only the three step decisions", () => {
    const input = mcpActionInputSchema(findMcpAction("update_setup_step")!);
    expect(input.safeParse({ action: "reset", stepId: "stripe" }).success).toBe(false);
    expect(input.safeParse({ action: "skip", stepId: "not-a-step" }).success).toBe(false);
  });

  it("finish_setup and reset_setup_progress send their fixed decision, whatever the app adds", async () => {
    expect(splitMcpActionArguments(findMcpAction("finish_setup")!, { action: "reset" }).body).toEqual({
      action: "finish",
    });
    h.prisma.setupProgress.upsert.mockResolvedValue({ ...PROGRESS_ROW, completedStepIds: [], skippedStepIds: [] });
    const { connection } = await expectActionContract({ actionId: "reset_setup_progress", handler: patchProgress });
    expect(connection).toEqual({ progress: { completedStepIds: [], skippedStepIds: [], completedAt: null } });
    expect(h.prisma.setupProgress.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: expect.objectContaining({ completedStepIds: [], skippedStepIds: [] }) }),
    );
  });

  it("finish_setup records the checklist finished", async () => {
    h.prisma.setupProgress.upsert.mockResolvedValue({ ...PROGRESS_ROW, completedAt: STAMP, completedByMemberId: "officer-1" });
    const { connection } = await expectActionContract({ actionId: "finish_setup", handler: patchProgress });
    expect(connection).toMatchObject({ progress: { completedAt: ISO } });
  });
});

describe("test_provider_connection", () => {
  it("answers whether the provider passed", async () => {
    h.xeroConnection.mockResolvedValue({ tenantId: "tenant-1", expiresAt: new Date("2099-01-01T00:00:00.000Z") });
    const { connection } = await expectActionContract({
      actionId: "test_provider_connection",
      handler: testProvider,
      args: { provider: "xero" },
    });
    expect(connection).toMatchObject({ ok: true, provider: "xero" });
  });

  it("leaves the monitoring event to its own destructive action", () => {
    const check = findMcpAction("test_provider_connection")!;
    expect(mcpActionInputSchema(check).safeParse({ provider: "sentry" }).success).toBe(false);
    const sentry = findMcpAction("send_monitoring_test_event")!;
    expect(sentry.kind).toBe("destructive");
    expect(splitMcpActionArguments(sentry, {}).body).toEqual({ provider: "sentry" });
  });
});

describe("send_monitoring_test_event", () => {
  it("sends the diagnostic event and answers whether monitoring accepted it", async () => {
    vi.stubEnv("SENTRY_DSN", "https://key@example.test/1");
    try {
      const { connection } = await expectActionContract({
        actionId: "send_monitoring_test_event",
        handler: testProvider,
      });
      expect(connection).toMatchObject({ ok: true, provider: "sentry" });
      expect(h.sentryCapture).toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

// ---------------------------------------------------------------------------
// Backups
// ---------------------------------------------------------------------------

const RUN = {
  id: "backup-run-1",
  status: "SUCCESS",
  trigger: "scheduled",
  startedAt: ISO,
  completedAt: ISO,
  durationMs: 1200,
  error: null,
  resultSummary: { key: "backups/2026-06-30.sql.gz" },
  triggeredByMemberId: null,
};

describe("get_backup_status", () => {
  it("sends the backup's health without its directory, file names or bucket", async () => {
    h.backupState.mockResolvedValue({
      enabled: true,
      bucket: "club-backups",
      region: "ap-southeast-2",
      retentionDays: 30,
      accessKeyIdSet: true,
      secretAccessKeySet: true,
      restoreValidationUrlSet: false,
      localEnabled: true,
      localPath: "/srv/backups",
      localPathFromEnv: false,
      anyDestinationEnabled: true,
      durable: true,
      needsReentry: false,
    });
    h.recentRuns.mockResolvedValue([RUN]);
    h.activeRun.mockResolvedValue({ ...RUN, id: "backup-run-2", status: "RUNNING", completedAt: null });
    h.localBackups.mockReturnValue([{ filename: "club-2026-06-30.sql.gz", sizeBytes: 100, modifiedAt: ISO }]);
    h.diskSpace.mockReturnValue({ availableBytes: 1000, totalBytes: 2000, level: "ok" });
    const { connection, browser } = await expectActionContract({ actionId: "get_backup_status", handler: backupStatus });
    const sent = JSON.stringify(connection);
    expect(sent).not.toContain("/srv/backups");
    expect(sent).not.toContain("club-2026-06-30");
    expect(sent).not.toContain("club-backups");
    expect(sent).not.toContain("backups/2026-06-30.sql.gz");
    expect(JSON.stringify(browser)).toContain("/srv/backups");
  });

  it("says the directory could not be read without naming it", async () => {
    h.backupState.mockResolvedValue({
      enabled: true,
      bucket: "club-backups",
      region: "ap-southeast-2",
      retentionDays: 30,
      accessKeyIdSet: true,
      secretAccessKeySet: true,
      restoreValidationUrlSet: false,
      localEnabled: true,
      localPath: "/srv/backups",
      localPathFromEnv: false,
      anyDestinationEnabled: true,
      durable: true,
      needsReentry: false,
    });
    h.recentRuns.mockResolvedValue([RUN]);
    h.activeRun.mockResolvedValue({ ...RUN, id: "backup-run-2", status: "RUNNING", completedAt: null });
    h.localBackups.mockImplementation(() => {
      throw new Error("ENOENT: no such file or directory, scandir '/srv/backups'");
    });
    h.diskSpace.mockReturnValue({ availableBytes: 1000, totalBytes: 2000, level: "ok" });
    const { connection, browser } = await expectActionContract({ actionId: "get_backup_status", handler: backupStatus });
    expect(connection).toMatchObject({ localError: "Could not read the backup directory." });
    expect(JSON.stringify(browser)).toContain("scandir '/srv/backups'");
  });
});

describe("run_backup_now", () => {
  it("starts a backup in the background and answers at once", async () => {
    h.activeRun.mockResolvedValue(null);
    h.backupConfig.mockResolvedValue({ needsReentry: false });
    h.runBackup.mockResolvedValue({ claimed: false });
    const { connection } = await expectActionContract({ actionId: "run_backup_now", handler: runBackup });
    expect(connection).toEqual({ ok: true, started: true });
    expect(h.runBackup).toHaveBeenCalledWith({ trigger: "manual", triggeredByMemberId: "officer-1" });
  });
});
