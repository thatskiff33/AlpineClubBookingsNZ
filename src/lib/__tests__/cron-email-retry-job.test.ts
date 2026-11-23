import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * #5433: the email retry job runs the owed-notice sweep first, then the replay
 * of FAILED rows, and reports both. The sweep never throws; the replay may
 * (a mail configuration fault), and the sweep has run by then.
 */

const mocks = vi.hoisted(() => ({ drain: vi.fn(), retry: vi.fn(), order: [] as string[] }));

vi.mock("@/lib/owed-notice/drain", () => ({
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

import { runEmailRetryJob } from "@/lib/cron-email-retry-job";

const SWEPT = { checked: 2, delivered: 1, cleared: 1, expired: 0 };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.order.length = 0;
  mocks.drain.mockResolvedValue(SWEPT);
  mocks.retry.mockResolvedValue({ retried: 3, succeeded: 2, failed: 1 });
});

describe("runEmailRetryJob", () => {
  it("sweeps the owed notices, then replays the failed rows, and reports both", async () => {
    await expect(runEmailRetryJob()).resolves.toEqual({ retried: 3, succeeded: 2, failed: 1, owedNotices: SWEPT });
    expect(mocks.order).toEqual(["drain", "retry"]);
  });

  it("has swept already when the replay throws on a configuration fault", async () => {
    mocks.retry.mockRejectedValue(new Error("Email retry skipped: misconfigured"));

    await expect(runEmailRetryJob()).rejects.toThrow("misconfigured");
    expect(mocks.drain).toHaveBeenCalledTimes(1);
  });
});
