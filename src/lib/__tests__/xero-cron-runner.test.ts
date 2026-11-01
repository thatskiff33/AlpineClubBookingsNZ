vi.mock("@/lib/cron-run-claim", () => ({
  withCronRunClaim: vi.fn(async (_name: string, work: (assertOwned: () => Promise<void>) => Promise<unknown>) => ({ claimed: true, result: await work(async () => {}) })),
}));
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/admin-modules", () => ({
  isEffectiveModuleEnabled: vi.fn(),
}));

vi.mock("@/lib/cron-job-run", () => ({
  recordCronJobRunSafe: vi.fn(),
}));

vi.mock("@/lib/logger", () => ({
  default: {
    error: vi.fn(),
  },
}));

vi.mock("@/lib/xero", () => ({
  isXeroConnected: vi.fn(),
  refreshAllMembershipStatuses: vi.fn(),
}));

vi.mock("@/lib/xero-feature-flags", () => ({
  isXeroDailyMembershipRefreshEnabled: vi.fn(),
}));

vi.mock("@/lib/xero-hardening", () => ({
  backfillHistoricalXeroObjectLinks: vi.fn(),
  cleanupStaleCanonicalXeroObjectLinks: vi.fn(),
  sendXeroReconciliationReport: vi.fn(),
}));

vi.mock("@/lib/xero-inbound-reconciliation", () => ({
  runXeroInboundReconciliationCycle: vi.fn(),
}));

vi.mock("@/lib/xero-operation-outbox", () => ({
  processQueuedXeroOutboxOperations: vi.fn(),
}));

vi.mock("@/lib/xero-operation-queue", () => ({
  processQueuedXeroOperationRetries: vi.fn(),
}));

import {
  XeroCronRunnerError,
  runXeroCronTaskList,
  runXeroCronTasks,
} from "@/lib/xero-cron-runner";

describe("xero cron runner", () => {
  it("records outbox and replay as separate jobs in the scheduled queue cycle", async () => {
    const recordCronRun = vi.fn();

    const result = await runXeroCronTaskList(["outbox", "retries"], {
      taskLabel: "xero-queue",
      recordCronRun,
      isModuleEnabled: vi.fn(async () => true),
      isConnected: vi.fn(async () => true),
      tasks: {
        processQueuedXeroOutboxOperations: vi.fn(async () => ({
          found: 2,
          processed: 2,
          succeeded: 2,
          failed: 0,
          skipped: 0,
        })),
        processQueuedXeroOperationRetries: vi.fn(async () => ({
          found: 1,
          processed: 1,
          succeeded: 1,
          failed: 0,
          skipped: 0,
        })),
      },
    });

    expect(result.task).toBe("xero-queue");
    expect(result.queuedOutboxOperations).toEqual({
      found: 2,
      processed: 2,
      succeeded: 2,
      failed: 0,
      skipped: 0,
    });
    expect(result.queuedRetries).toEqual({
      found: 1,
      processed: 1,
      succeeded: 1,
      failed: 0,
      skipped: 0,
    });
    expect(recordCronRun).toHaveBeenCalledWith(
      expect.objectContaining({
        jobName: "xero-outbox",
        status: "SUCCESS",
      })
    );
    expect(recordCronRun).toHaveBeenCalledWith(
      expect.objectContaining({
        jobName: "xero-operation-replay",
        status: "SUCCESS",
      })
    );
  });

  it("records skipped task rows when the Xero module is disabled at run time", async () => {
    const recordCronRun = vi.fn();
    const isConnected = vi.fn(async () => true);

    const result = await runXeroCronTaskList(["outbox", "retries"], {
      taskLabel: "xero-queue",
      recordCronRun,
      isModuleEnabled: vi.fn(async () => false),
      isConnected,
    });

    expect(isConnected).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      message: "Xero cron tasks skipped",
      task: "xero-queue",
      connected: false,
      skipped: true,
      reason: "Operational Xero effective module state is disabled",
    });
    expect(recordCronRun).toHaveBeenCalledWith(
      expect.objectContaining({
        jobName: "xero-outbox",
        status: "SKIPPED",
      })
    );
    expect(recordCronRun).toHaveBeenCalledWith(
      expect.objectContaining({
        jobName: "xero-operation-replay",
        status: "SKIPPED",
      })
    );
  });

  it("records a worked batch with routinely skipped rows as SUCCESS, not SKIPPED (#4375)", async () => {
    const recordCronRun = vi.fn();

    await runXeroCronTaskList(["outbox", "retries"], {
      taskLabel: "xero-queue",
      recordCronRun,
      isModuleEnabled: vi.fn(async () => true),
      isConnected: vi.fn(async () => true),
      tasks: {
        processQueuedXeroOutboxOperations: vi.fn(async () => ({
          found: 4,
          processed: 4,
          succeeded: 3,
          failed: 0,
          skipped: 1,
        })),
        processQueuedXeroOperationRetries: vi.fn(async () => ({
          found: 2,
          processed: 2,
          succeeded: 0,
          failed: 0,
          skipped: 2,
        })),
      },
    });

    for (const jobName of ["xero-outbox", "xero-operation-replay"]) {
      expect(recordCronRun).toHaveBeenCalledWith(
        expect.objectContaining({ jobName, status: "SUCCESS" })
      );
    }
    expect(recordCronRun).not.toHaveBeenCalledWith(
      expect.objectContaining({ status: "SKIPPED" })
    );
    for (const [input] of recordCronRun.mock.calls) {
      expect(input.resultSummary).not.toHaveProperty("warning");
    }
  });

  it("warns, not green, when a Xero cooldown refused outbox rows before any call (#4375)", async () => {
    const recordCronRun = vi.fn();

    const result = await runXeroCronTaskList(["outbox"], {
      taskLabel: "xero-queue",
      recordCronRun,
      isModuleEnabled: vi.fn(async () => true),
      isConnected: vi.fn(async () => true),
      tasks: {
        processQueuedXeroOutboxOperations: vi.fn(async () => ({
          found: 3,
          processed: 3,
          succeeded: 0,
          failed: 0,
          skipped: 3,
          cooldownDeferred: 3,
        })),
      },
    });

    const warning = expect.stringContaining("Xero refused 3 operation(s) before any call");
    expect(result.queuedOutboxOperations).toMatchObject({ warning });
    expect(recordCronRun).toHaveBeenCalledWith(
      expect.objectContaining({
        jobName: "xero-outbox",
        status: "SUCCESS",
        resultSummary: expect.objectContaining({ warning }),
      })
    );
  });

  it("warns when outbox or replay rows failed, and names both reasons together (#4375)", async () => {
    const recordCronRun = vi.fn();

    const result = await runXeroCronTaskList(["outbox", "retries"], {
      taskLabel: "xero-queue",
      recordCronRun,
      isModuleEnabled: vi.fn(async () => true),
      isConnected: vi.fn(async () => true),
      tasks: {
        processQueuedXeroOutboxOperations: vi.fn(async () => ({
          found: 3,
          processed: 3,
          succeeded: 0,
          failed: 1,
          skipped: 2,
          cooldownDeferred: 1,
        })),
        processQueuedXeroOperationRetries: vi.fn(async () => ({
          found: 2,
          processed: 2,
          succeeded: 0,
          failed: 2,
          skipped: 0,
        })),
      },
    });

    expect(result.queuedOutboxOperations).toMatchObject({
      warning:
        "Xero refused 1 operation(s) before any call (outage cooldown, daily limit or environment check); they stay queued and run once it clears. 1 operation(s) failed; see Xero Operations.",
    });
    expect(recordCronRun).toHaveBeenCalledWith(
      expect.objectContaining({
        jobName: "xero-operation-replay",
        status: "SUCCESS",
        resultSummary: expect.objectContaining({
          warning: "2 operation(s) failed; see Xero Operations.",
        }),
      })
    );
  });

  it("records a task that did no work as SKIPPED: not connected, or skipped: true (#4375)", async () => {
    const recordCronRun = vi.fn();

    await runXeroCronTaskList(["outbox", "credit-sync"], {
      taskLabel: "xero-queue",
      recordCronRun,
      isModuleEnabled: vi.fn(async () => true),
      isConnected: vi.fn(async () => false),
    });

    expect(recordCronRun).toHaveBeenCalledWith(
      expect.objectContaining({
        jobName: "xero-outbox",
        status: "SKIPPED",
        resultSummary: { skipped: true, reason: "Xero not connected" },
      })
    );

    const connectedRecord = vi.fn();
    await runXeroCronTaskList(["credit-sync"], {
      taskLabel: "xero-credit-sync",
      recordCronRun: connectedRecord,
      isModuleEnabled: vi.fn(async () => true),
      isConnected: vi.fn(async () => true),
      tasks: {
        reconcileXeroCreditSync: vi.fn(async () => ({ skipped: true })) as never,
      },
    });

    expect(connectedRecord).toHaveBeenCalledWith(
      expect.objectContaining({ status: "SKIPPED" })
    );
  });

  it("records the daily stale link cleanup job independently from backfill", async () => {
    const recordCronRun = vi.fn();

    const result = await runXeroCronTasks("link-cleanup", {
      recordCronRun,
      isModuleEnabled: vi.fn(async () => true),
      isConnected: vi.fn(async () => false),
      tasks: {
        cleanupStaleCanonicalXeroObjectLinks: vi.fn(async () => ({
          scannedActiveLinks: 3,
          deactivatedLinks: 1,
        })) as never,
      },
    });

    expect(result.linkCleanup).toEqual({
      scannedActiveLinks: 3,
      deactivatedLinks: 1,
    });
    expect(recordCronRun).toHaveBeenCalledWith(
      expect.objectContaining({
        jobName: "xero-link-cleanup",
        status: "SUCCESS",
      })
    );
    expect(recordCronRun).not.toHaveBeenCalledWith(
      expect.objectContaining({
        jobName: "xero-link-backfill",
      })
    );
  });

  it("records a link cleanup whose refund-note heals partly failed as FAILURE, with its summary, and fails the run (#4161)", async () => {
    const recordCronRun = vi.fn();
    const cleanup = { deactivatedLinks: 1, failedRefundNoteHealLinkIds: ["link_a"], deferredRefundNoteHealLinkIds: [] };

    const run = runXeroCronTasks("link-cleanup", {
      recordCronRun,
      isModuleEnabled: vi.fn(async () => true),
      isConnected: vi.fn(async () => false),
      log: { error: vi.fn() },
      tasks: { cleanupStaleCanonicalXeroObjectLinks: vi.fn(async () => cleanup) as never },
    });

    const error = await run.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(XeroCronRunnerError);
    expect((error as XeroCronRunnerError).payload.linkCleanup).toEqual(cleanup);
    expect((error as XeroCronRunnerError).message).toContain("link_a");
    expect(recordCronRun).toHaveBeenCalledWith(
      expect.objectContaining({
        jobName: "xero-link-cleanup",
        status: "FAILURE",
        resultSummary: cleanup,
        error: expect.stringContaining("link_a"),
      })
    );
  });

  it("does not fail the run for a heal only deferred behind a credit-note create (#4161)", async () => {
    const recordCronRun = vi.fn();

    await runXeroCronTasks("link-cleanup", {
      recordCronRun,
      isModuleEnabled: vi.fn(async () => true),
      isConnected: vi.fn(async () => false),
      tasks: {
        cleanupStaleCanonicalXeroObjectLinks: vi.fn(async () => ({ failedRefundNoteHealLinkIds: [], deferredRefundNoteHealLinkIds: ["link_b"] })) as never,
      },
    });

    expect(recordCronRun).toHaveBeenCalledWith(expect.objectContaining({ jobName: "xero-link-cleanup", status: "SUCCESS", error: null }));
  });
  it("#4162: the 02:25 slot runs the voided bank-transfer refund notes' follow-up right after the cleanup, recorded under its own job", async () => {
    const order: string[] = [];
    const recordCronRun = vi.fn();
    const result = await runXeroCronTaskList(["link-cleanup", "bank-refund-voids"], {
      taskLabel: "link-cleanup",
      recordCronRun,
      isModuleEnabled: vi.fn(async () => true),
      isConnected: vi.fn(async () => false),
      tasks: {
        cleanupStaleCanonicalXeroObjectLinks: vi.fn(async () => {
          order.push("heal");
          return { deactivatedLinks: 0 };
        }) as never,
        runBankRefundVoidFollowUp: vi.fn(async () => {
          order.push("follow-up");
          return { mode: "report-only" as const, scanned: 2, counts: { undone: 2, spare: 0, handled: 0, deferred: 0, unmatched: 0, "awaiting-heal": 0, "not-in-scope": 0, failed: 0 }, deferredOverdue: 0, items: [] };
        }),
      },
    });
    // Local rows only: it runs whether or not Xero is connected.
    expect(order).toEqual(["heal", "follow-up"]);
    expect(result.bankRefundVoidFollowUp).toMatchObject({ mode: "report-only", scanned: 2 });
    expect(recordCronRun).toHaveBeenCalledWith(expect.objectContaining({ jobName: "xero-bank-refund-void-follow-up", status: "SUCCESS" }));
  });

  it("#4162: a note the follow-up failed on is recorded FAILURE and fails the run", async () => {
    const recordCronRun = vi.fn();
    const run = runXeroCronTaskList(["bank-refund-voids"], {
      recordCronRun,
      isModuleEnabled: vi.fn(async () => true),
      isConnected: vi.fn(async () => true),
      log: { error: vi.fn() },
      tasks: {
        runBankRefundVoidFollowUp: vi.fn(async () => ({
          mode: "writes" as const, scanned: 1, counts: { undone: 0, spare: 0, handled: 0, deferred: 0, unmatched: 0, "awaiting-heal": 0, "not-in-scope": 0, failed: 1 }, deferredOverdue: 0, items: [],
        })),
      },
    });
    await expect(run).rejects.toBeInstanceOf(XeroCronRunnerError);
    expect(recordCronRun).toHaveBeenCalledWith(expect.objectContaining({ jobName: "xero-bank-refund-void-follow-up", status: "FAILURE", error: expect.stringContaining("could not be followed up") }));
  });
});
