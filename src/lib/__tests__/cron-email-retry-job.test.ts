import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * #5433: the email retry job runs the owed-notice sweep first, capped, then
 * the replay of FAILED rows, and reports both. The replay runs whatever the
 * sweep does; when the replay throws (a mail configuration fault) the error
 * carries the sweep's counts for the failed run's record.
 */

const mocks = vi.hoisted(() => ({
  drain: vi.fn(),
  retry: vi.fn(),
  order: [] as string[],
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@/lib/owed-notice/drain", () => ({
  EMAIL_RETRY_OWED_NOTICE_CAP: { maxRows: 100, budgetMs: 120_000 },
  drainOwedNotices: (...args: unknown[]) => {
    mocks.order.push("drain");
    return mocks.drain(...args);
  },
}));
vi.mock("@/lib/cron-email-retry", () => ({
  retryFailedEmails: (...args: unknown[]) => {
    mocks.order.push("retry");
    return mocks.retry(...args);
  },
}));
vi.mock("@/lib/logger", () => ({ default: mocks.logger }));

import { runEmailRetryJob } from "@/lib/cron-email-retry-job";
import { EMAIL_RETRY_OWED_NOTICE_CAP } from "@/lib/owed-notice/drain";

const SWEPT = { checked: 2, delivered: 1, cleared: 1, expired: 0 };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.order.length = 0;
  mocks.drain.mockResolvedValue(SWEPT);
  mocks.retry.mockResolvedValue({ retried: 3, succeeded: 2, failed: 1 });
});

describe("runEmailRetryJob", () => {
  it("sweeps the owed notices under its cap and as this job, then replays the failed rows, and reports both", async () => {
    await expect(runEmailRetryJob()).resolves.toEqual({ retried: 3, succeeded: 2, failed: 1, owedNotices: SWEPT });
    expect(mocks.order).toEqual(["drain", "retry"]);
    expect(mocks.drain).toHaveBeenCalledWith(expect.any(Date), { ...EMAIL_RETRY_OWED_NOTICE_CAP, job: "email-retry" });
  });

  it("replays the failed rows even when the sweep throws, and records that it did", async () => {
    mocks.drain.mockRejectedValue(new Error("sweep broke"));

    await expect(runEmailRetryJob()).resolves.toEqual({ retried: 3, succeeded: 2, failed: 1, owedNotices: { failed: "sweep broke" } });
    expect(mocks.retry).toHaveBeenCalledTimes(1);
    expect(mocks.logger.error).toHaveBeenCalledTimes(1);
  });

  it("keeps the sweep's counts on the replay's error, for the failed run's record", async () => {
    const fault = new Error("Email retry skipped: misconfigured");
    mocks.retry.mockRejectedValue(fault);

    const thrown = await runEmailRetryJob().then(
      () => null,
      (err: unknown) => err,
    );

    expect(thrown).toBe(fault);
    expect((thrown as { resultSummary?: unknown }).resultSummary).toEqual({ owedNotices: SWEPT });
    expect(mocks.drain).toHaveBeenCalledTimes(1);
  });
});
