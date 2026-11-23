/**
 * The fail-safe teardown helper real-database suites share (#5349). No database:
 * the steps here are plain functions, so the helper's own contract is proved in
 * the unit shards rather than only where a scratch database exists.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { runEveryTeardownStep } from "./support/teardown-steps";

describe("runEveryTeardownStep (#5349)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("runs every later step, in order, after one step rejects and another throws synchronously", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const ran: string[] = [];
    const rejected = new Error("connection already closed");
    const thrown = new Error("role is still in use");

    const outcome = await runEveryTeardownStep("probe suite", [
      { what: "disconnect the client", run: () => { ran.push("disconnect"); } },
      { what: "end the application connection", run: async () => { ran.push("end app"); throw rejected; } },
      { what: 'drop database "scratch"', run: async () => { ran.push("drop database"); } },
      { what: 'drop role "scratch_app"', run: () => { ran.push("drop role"); throw thrown; } },
      { what: "end the admin connection", run: async () => { ran.push("end admin"); } },
    ]).then(() => undefined, (error: unknown) => error);

    expect(ran).toEqual(["disconnect", "end app", "drop database", "drop role", "end admin"]);

    expect(outcome).toBeInstanceOf(AggregateError);
    const failure = outcome as AggregateError;
    expect(failure.message).toContain("[probe suite]");
    expect(failure.message).toContain("end the application connection");
    expect(failure.message).toContain('drop role "scratch_app"');
    // Only the steps that failed are named.
    expect(failure.message).not.toContain("disconnect the client");
    expect(failure.message).not.toContain('drop database "scratch"');
    expect(failure.message).not.toContain("end the admin connection");
    // The originals, in the order they failed, not copies or messages.
    expect(failure.errors).toHaveLength(2);
    expect(failure.errors[0]).toBe(rejected);
    expect(failure.errors[1]).toBe(thrown);

    // One log line per failed step, naming the step and what went wrong.
    expect(warn.mock.calls.map((call) => String(call[0]))).toEqual([
      "[probe suite] teardown could not end the application connection: connection already closed",
      '[probe suite] teardown could not drop role "scratch_app": role is still in use',
    ]);
  });

  it("logs a failure that is not an Error by its text", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const outcome = await runEveryTeardownStep("probe suite", [
      // A rejection with a non-Error reason, as a driver callback can produce.
      { what: "end the scratch connection", run: () => Promise.reject("socket hang up") },
    ]).then(() => undefined, (error: unknown) => error);

    expect(outcome).toBeInstanceOf(AggregateError);
    expect((outcome as AggregateError).errors).toEqual(["socket hang up"]);
    expect(warn.mock.calls.map((call) => String(call[0]))).toEqual([
      "[probe suite] teardown could not end the scratch connection: socket hang up",
    ]);
  });

  it("resolves and warns nothing when every step succeeds", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const ran: string[] = [];

    await expect(runEveryTeardownStep("probe suite", [
      { what: "disconnect the client", run: () => { ran.push("disconnect"); } },
      { what: 'drop database "scratch"', run: async () => { ran.push("drop database"); } },
      // A step whose guard found nothing to do returns undefined, as `scratch?.drop()` does.
      { what: "end the admin connection", run: () => undefined },
    ])).resolves.toBeUndefined();

    expect(ran).toEqual(["disconnect", "drop database"]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("resolves for an empty list", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(runEveryTeardownStep("probe suite", [])).resolves.toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });
});
