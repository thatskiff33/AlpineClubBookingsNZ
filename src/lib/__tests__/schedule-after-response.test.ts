import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ after: vi.fn() }));
vi.mock("next/server", () => ({ after: mocks.after }));

import { scheduleAfterResponse } from "@/lib/schedule-after-response";

beforeEach(() => { mocks.after.mockReset(); });

describe("scheduleAfterResponse", () => {
  it("registers the task with after without running it or scheduling a fallback", async () => {
    const task = vi.fn(async () => {});
    scheduleAfterResponse(task);

    expect(mocks.after).toHaveBeenCalledExactlyOnceWith(task);
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(task).not.toHaveBeenCalled();

    await mocks.after.mock.calls[0]![0]();
    expect(task).toHaveBeenCalledTimes(1);
  });

  it("defers the task to a microtask when after cannot register it", async () => {
    mocks.after.mockImplementation(() => { throw new Error("No request scope"); });
    const task = vi.fn(async () => {});
    scheduleAfterResponse(task);

    expect(task).not.toHaveBeenCalled();
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(task).toHaveBeenCalledTimes(1);
  });
});
