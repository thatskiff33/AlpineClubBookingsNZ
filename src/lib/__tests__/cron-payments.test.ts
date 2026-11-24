import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const {
  mockProcessPaymentRecoveryOperations,
  mockReleaseExpiredInternetBankingHolds,
  mockReapStaleWaitingPaymentXeroOutboxOperations,
  mockReannounceHeldLateCaptures,
  mockRunCreditReleaseAskSweep,
  mockDrainOwedNewCaptureAlerts,
  mockSweepVoidedCombinedGroupInvoiceCover,
  mockSweepOnceEverAlerts,
  mockCronJobRunCreate,
  mockReportCronError,
} = vi.hoisted(() => ({
  mockProcessPaymentRecoveryOperations: vi.fn(),
  mockReleaseExpiredInternetBankingHolds: vi.fn(),
  mockReapStaleWaitingPaymentXeroOutboxOperations: vi.fn(),
  mockReannounceHeldLateCaptures: vi.fn(),
  mockRunCreditReleaseAskSweep: vi.fn(),
  mockDrainOwedNewCaptureAlerts: vi.fn(),
  mockSweepVoidedCombinedGroupInvoiceCover: vi.fn(),
  mockSweepOnceEverAlerts: vi.fn(),
  mockCronJobRunCreate: vi.fn(),
  mockReportCronError: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    cronJobRun: {
      create: (...args: unknown[]) => mockCronJobRunCreate(...args),
    },
  },
}));

vi.mock("@/lib/payment-recovery", () => ({
  enqueueAdditionalPaymentIntentRecovery: vi.fn().mockResolvedValue({ id: "recovery_additional" }),
  processPaymentRecoveryOperations: (...args: unknown[]) =>
    mockProcessPaymentRecoveryOperations(...args),
}));

vi.mock("@/lib/internet-banking-payment-cron", () => ({
  releaseExpiredInternetBankingHolds: (...args: unknown[]) =>
    mockReleaseExpiredInternetBankingHolds(...args),
}));

vi.mock("@/lib/observability-bridge", () => ({
  reportCronError: (...args: unknown[]) => mockReportCronError(...args),
}));

// The route reaches the Xero outbox transitively as well; kept doubled so this
// suite never loads the outbox's provider-client import graph (#3641 moved the
// reaper out of it, and dropping this double took the first test past its limit).
vi.mock("@/lib/xero-operation-outbox", () => ({}));

vi.mock("@/lib/xero-waiting-invoice-reaper", () => ({
  reapStaleWaitingPaymentXeroOutboxOperations: (...args: unknown[]) =>
    mockReapStaleWaitingPaymentXeroOutboxOperations(...args),
}));

// #3635: the fifth task, the held late-capture alert's re-selecting run.
vi.mock("@/lib/late-capture-refund-hold", () => ({
  reannounceHeldLateCaptures: (...args: unknown[]) => mockReannounceHeldLateCaptures(...args),
}));

// #4253: the sixth task, the credit-release payment sweep.
vi.mock("@/lib/credit-release-ask-sweep", () => ({
  runCreditReleaseAskSweep: (...args: unknown[]) => mockRunCreditReleaseAskSweep(...args),
}));

// #4285 review: the seventh task, the owed new-capture alert's drain.
vi.mock("@/lib/duplicate-capture-kept-alert-drain", () => ({
  drainOwedNewCaptureAlerts: (...args: unknown[]) => mockDrainOwedNewCaptureAlerts(...args),
}));

// #4525 review: the eighth task, the combined group invoice cover-release sweep.
vi.mock("@/lib/member-money/doors", () => ({
  sweepVoidedCombinedGroupInvoiceCover: (...args: unknown[]) => mockSweepVoidedCombinedGroupInvoiceCover(...args),
}));

// #5255: the first task, the once-ever alert sweep.
vi.mock("@/lib/admin-alert-once-sweep", () => ({
  sweepOnceEverAlerts: (...args: unknown[]) => mockSweepOnceEverAlerts(...args),
}));

vi.mock("@/lib/logger", () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

const CRON_SECRET = "test-cron-secret-with-padding";

function authorisedRequest(url: string) {
  return new NextRequest(url, {
    method: "POST",
    headers: { "x-cron-secret": CRON_SECRET },
  });
}

describe("POST /api/cron/payments", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CRON_SECRET = CRON_SECRET;
    mockProcessPaymentRecoveryOperations.mockResolvedValue({
      found: 0,
      processed: 0,
      succeeded: 0,
      failed: 0,
      retried: 0,
      skipped: 0,
    });
    mockReleaseExpiredInternetBankingHolds.mockResolvedValue({
      scanned: 0,
      released: 0,
      skipped: 0,
      skippedStarted: 0,
      failed: 0,
      bookingIds: [],
      paymentIds: [],
    });
    mockReannounceHeldLateCaptures.mockResolvedValue({ checked: 0, announced: 0 });
    mockRunCreditReleaseAskSweep.mockResolvedValue({ enqueued: 0, payments: null, closes: null });
    mockDrainOwedNewCaptureAlerts.mockResolvedValue({ checked: 0, sent: 0 });
    mockSweepVoidedCombinedGroupInvoiceCover.mockResolvedValue({ checked: 0, released: 0, releaseFailures: 0, truncated: false, failed: false });
    mockSweepOnceEverAlerts.mockResolvedValue({ released: 0, resent: 0, settled: 0, dropped: 0, failed: 0 });
    mockReapStaleWaitingPaymentXeroOutboxOperations.mockResolvedValue({
      reaped: 0,
      released: 0,
      queueOperationIds: [],
    });
    mockCronJobRunCreate.mockResolvedValue(undefined);
  });

  it("returns 401 when the cron secret header is missing", async () => {
    const { POST } = await import("@/app/api/cron/payments/route");
    const request = new NextRequest(
      "http://localhost/api/cron/payments?task=recovery",
      { method: "POST" }
    );
    const response = await POST(request);
    expect(response.status).toBe(401);
    expect(mockProcessPaymentRecoveryOperations).not.toHaveBeenCalled();
  });

  function recordedRuns() {
    return mockCronJobRunCreate.mock.calls.map(
      ([arg]) =>
        (arg as { data: { jobName: string; status: string; error?: string } })
          .data
    );
  }

  it("runs all eight payments tasks and records each under its own job name", async () => {
    const { POST } = await import("@/app/api/cron/payments/route");
    const response = await POST(
      authorisedRequest("http://localhost/api/cron/payments?task=recovery")
    );
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.task).toBe("recovery");
    expect(mockProcessPaymentRecoveryOperations).toHaveBeenCalledOnce();
    expect(mockReleaseExpiredInternetBankingHolds).toHaveBeenCalledOnce();
    expect(mockReapStaleWaitingPaymentXeroOutboxOperations).toHaveBeenCalledOnce();
    expect(mockReannounceHeldLateCaptures).toHaveBeenCalledOnce();
    expect(mockRunCreditReleaseAskSweep).toHaveBeenCalledOnce();
    expect(mockDrainOwedNewCaptureAlerts).toHaveBeenCalledOnce();
    expect(mockSweepVoidedCombinedGroupInvoiceCover).toHaveBeenCalledOnce();
    expect(mockSweepOnceEverAlerts).toHaveBeenCalledOnce();
    expect(data.internetBankingHoldRelease).toMatchObject({ released: 0, failed: 0 });
    expect(data.xeroOutboxReap).toMatchObject({ reaped: 0 });
    expect(recordedRuns()).toEqual([
      expect.objectContaining({ jobName: "once-ever-alert-sweep", status: "SUCCESS" }),
      expect.objectContaining({ jobName: "payment-recovery", status: "SUCCESS" }),
      expect.objectContaining({ jobName: "internet-banking-hold-release", status: "SUCCESS" }),
      expect.objectContaining({ jobName: "xero-waiting-invoice-reaper", status: "SUCCESS" }),
      expect.objectContaining({ jobName: "late-capture-held-alert", status: "SUCCESS" }),
      expect.objectContaining({ jobName: "credit-release-asks", status: "SUCCESS" }),
      expect.objectContaining({ jobName: "duplicate-capture-kept-alert", status: "SUCCESS" }),
      expect.objectContaining({ jobName: "combined-invoice-cover-release", status: "SUCCESS" }),
    ]);
  });

  it.each([
    [{ checked: 2, released: 0, releaseFailures: 0, truncated: false, failed: true }, /could not read its manifests/],
    [{ checked: 3, released: 1, releaseFailures: 2, truncated: false, failed: false }, /could not release 2 voided invoice/],
    [{ checked: 5000, released: 1, releaseFailures: 0, truncated: true, failed: false }, /stopped at its per-run cap/],
  ])("records the cover sweep's failed read or capped run as a warning admin cron health shows (#4525)", async (sweep, warning) => {
    mockSweepVoidedCombinedGroupInvoiceCover.mockResolvedValueOnce(sweep);
    const { POST } = await import("@/app/api/cron/payments/route");
    const response = await POST(authorisedRequest("http://localhost/api/cron/payments?task=recovery"));
    expect(response.status).toBe(200);
    const run = mockCronJobRunCreate.mock.calls
      .map(([arg]) => (arg as { data: { jobName: string; status: string; resultSummary: Record<string, unknown> } }).data)
      .find((recorded) => recorded.jobName === "combined-invoice-cover-release");
    expect(run?.status).toBe("SUCCESS");
    expect(run?.resultSummary.warning).toMatch(warning);
  });

  it("records a hold release with item failures as a warning admin cron health shows (#3663)", async () => {
    mockReleaseExpiredInternetBankingHolds.mockResolvedValueOnce({
      scanned: 3,
      released: 1,
      skipped: 0,
      skippedStarted: 0,
      failed: 2,
      bookingIds: ["b1"],
      paymentIds: ["p1"],
    });
    const { POST } = await import("@/app/api/cron/payments/route");
    const response = await POST(
      authorisedRequest("http://localhost/api/cron/payments?task=recovery")
    );

    expect(response.status).toBe(200);
    const holdRun = mockCronJobRunCreate.mock.calls
      .map(([arg]) => (arg as { data: { jobName: string; status: string; resultSummary: Record<string, unknown> } }).data)
      .find((run) => run.jobName === "internet-banking-hold-release");
    expect(holdRun?.status).toBe("SUCCESS");
    expect(holdRun?.resultSummary.warning).toMatch(/^2 expired Internet Banking hold/);
  });

  it("records a once-ever alert sweep with failed rows as a warning admin cron health shows (#5255)", async () => {
    mockSweepOnceEverAlerts.mockResolvedValueOnce({ released: 1, resent: 0, settled: 0, dropped: 0, failed: 2 });
    const { POST } = await import("@/app/api/cron/payments/route");
    const response = await POST(authorisedRequest("http://localhost/api/cron/payments?task=recovery"));

    expect(response.status).toBe(200);
    const sweepRun = mockCronJobRunCreate.mock.calls
      .map(([arg]) => (arg as { data: { jobName: string; status: string; resultSummary: Record<string, unknown> } }).data)
      .find((run) => run.jobName === "once-ever-alert-sweep");
    expect(sweepRun?.status).toBe("SUCCESS");
    expect(sweepRun?.resultSummary.warning).toMatch(/^2 once-ever alert/);
  });

  it.each([
    ["once-ever-alert-sweep", mockSweepOnceEverAlerts, "onceEverAlertSweep"],
    ["payment-recovery", mockProcessPaymentRecoveryOperations, "recovery"],
    ["internet-banking-hold-release", mockReleaseExpiredInternetBankingHolds, "internetBankingHoldRelease"],
    ["xero-waiting-invoice-reaper", mockReapStaleWaitingPaymentXeroOutboxOperations, "xeroOutboxReap"],
    ["late-capture-held-alert", mockReannounceHeldLateCaptures, "lateCaptureHeldAlert"],
    ["credit-release-asks", mockRunCreditReleaseAskSweep, "creditReleaseAsks"],
    ["duplicate-capture-kept-alert", mockDrainOwedNewCaptureAlerts, "duplicateCaptureKeptAlert"],
    ["combined-invoice-cover-release", mockSweepVoidedCombinedGroupInvoiceCover, "combinedInvoiceCoverRelease"],
  ] as const)(
    "keeps running the other tasks when %s fails, and reports it as failed",
    async (failingJob, failingMock, resultKey) => {
      failingMock.mockRejectedValueOnce(new Error(`${failingJob} exploded`));
      const { POST } = await import("@/app/api/cron/payments/route");
      const response = await POST(
        authorisedRequest("http://localhost/api/cron/payments?task=recovery")
      );

      expect(response.status).toBe(500);
      const data = await response.json();
      expect(data.failedJobs).toEqual([
        { jobName: failingJob, message: `${failingJob} exploded` },
      ]);
      // The failed task reports null, never invented zero counts.
      expect(data.result[resultKey]).toBeNull();
      expect(mockProcessPaymentRecoveryOperations).toHaveBeenCalledOnce();
      expect(mockReleaseExpiredInternetBankingHolds).toHaveBeenCalledOnce();
      expect(mockReapStaleWaitingPaymentXeroOutboxOperations).toHaveBeenCalledOnce();
      expect(mockReportCronError).toHaveBeenCalledOnce();
      expect(mockReportCronError).toHaveBeenCalledWith(
        expect.objectContaining({ tag: failingJob })
      );
      const runs = recordedRuns();
      expect(runs).toHaveLength(8);
      for (const run of runs) {
        expect(run.status).toBe(run.jobName === failingJob ? "FAILURE" : "SUCCESS");
      }
      expect(runs.find((run) => run.jobName === failingJob)?.error).toBe(
        `${failingJob} exploded`
      );
    }
  );

  it("defaults to the recovery task when no task is supplied", async () => {
    const { POST } = await import("@/app/api/cron/payments/route");
    const response = await POST(
      authorisedRequest("http://localhost/api/cron/payments")
    );
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.task).toBe("recovery");
    expect(mockProcessPaymentRecoveryOperations).toHaveBeenCalledOnce();
  });

  it("returns 400 when task is not a known enum value", async () => {
    const { POST } = await import("@/app/api/cron/payments/route");
    const response = await POST(
      authorisedRequest("http://localhost/api/cron/payments?task=bogus")
    );
    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toBe("Invalid task parameter");
    expect(mockProcessPaymentRecoveryOperations).not.toHaveBeenCalled();
  });

  it("returns 400 when task is supplied more than once", async () => {
    const { POST } = await import("@/app/api/cron/payments/route");
    const response = await POST(
      authorisedRequest(
        "http://localhost/api/cron/payments?task=recovery&task=recovery"
      )
    );
    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toBe("Invalid task parameter");
    expect(data.details).toEqual({
      task: ["task may only be provided once"],
    });
    expect(mockProcessPaymentRecoveryOperations).not.toHaveBeenCalled();
  });
});
