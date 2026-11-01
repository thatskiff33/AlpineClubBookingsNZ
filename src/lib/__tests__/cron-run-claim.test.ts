import { beforeEach, describe, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ connect: vi.fn(), query: vi.fn(), end: vi.fn(), listeners: new Map<string, () => void>() }));
vi.mock("pg", () => ({ Client: class {
  connect = h.connect; query = h.query; end = h.end;
  on(event: string, callback: () => void) { h.listeners.set(event, callback); }
} }));
import { withCronRunClaim } from "@/lib/cron-run-claim";
describe("whole-cycle database claims", () => {
  beforeEach(() => {
    vi.stubEnv("DATABASE_URL", "postgresql://test:test@127.0.0.1:55442/concurrency_race_1881");
    h.query.mockResolvedValue({ rows: [{ claimed: true }] });
  });
  it("runs outside a transaction and closes the dedicated connection on success", async () => {
    const work = vi.fn(async (assertOwned: () => Promise<void>) => { await assertOwned(); return "done"; });
    expect(await withCronRunClaim("job", work)).toEqual({ claimed: true, result: "done" });
    expect(h.query.mock.calls[0]).toEqual([expect.stringContaining("pg_try_advisory_lock"), ["job"]]);
    expect(h.query.mock.calls.map((call) => call[0])).not.toContain("BEGIN");
    expect(h.end).toHaveBeenCalledOnce();
  });
  it("refuses another holder without entering its work", async () => {
    h.query.mockResolvedValueOnce({ rows: [{ claimed: false }] });
    const work = vi.fn();
    expect(await withCronRunClaim("job", work)).toEqual({ claimed: false });
    expect(work).not.toHaveBeenCalled(); expect(h.end).toHaveBeenCalledOnce();
  });
  it("always closes the connection after a task throws", async () => {
    await expect(withCronRunClaim("job", async () => { throw new Error("task failed"); })).rejects.toThrow("task failed");
    expect(h.end).toHaveBeenCalledOnce();
  });
  it("refuses further task boundaries after a lost connection", async () => {
    await expect(withCronRunClaim("job", async (assertOwned) => {
      h.listeners.get("error")?.();
      await assertOwned();
    })).rejects.toThrow("claim connection was lost");
    expect(h.end).toHaveBeenCalledOnce();
  });
});
