import { EventEmitter } from "node:events";
import { PassThrough, Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { streamDatabaseTool } from "../backup-db-tool";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

function fakeChild() {
  return Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(),
  });
}

describe("streamDatabaseTool", () => {
  let child: ReturnType<typeof fakeChild>;
  const exitError = (code: number | null, signal: NodeJS.Signals | null, stderr: string) =>
    new Error(`tool exited ${code ?? signal}: ${stderr}`);
  function options() {
    return {
      command: "fixture-db-tool",
      args: ["synthetic-db"],
      env: { NODE_ENV: "test" } as NodeJS.ProcessEnv,
      timeoutMs: 1_000,
      exitError,
      direction: "stdout" as const,
      stream: (source: Readable, signal: AbortSignal) => pipeline(
        source,
        new Writable({ write(_chunk, _encoding, callback) { callback(); } }),
        { signal },
      ),
    };
  }
  async function start() {
    child.emit("spawn");
    // Let the helper attach its pipeline and timer after the spawn promise.
    await vi.waitFor(() => expect(child.stdout.listenerCount("data")).toBeGreaterThan(0));
  }
  beforeEach(() => {
    child = fakeChild();
    vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
  });
  afterEach(() => vi.useRealTimers());

  it("streams stdout to the sink and waits for a successful exit after EOF", async () => {
    const chunks: Buffer[] = [];
    const done = streamDatabaseTool({
      ...options(),
      stream: (source: Readable, signal: AbortSignal) => pipeline(source, new Writable({
        write(chunk: Buffer, _encoding, callback) { chunks.push(chunk); callback(); },
      }), { signal }),
    });
    let settled = false;
    void done.then(() => { settled = true; });
    await start();
    child.stdout.end("synthetic SQL");
    await vi.waitFor(() => expect(child.stdout.readableEnded).toBe(true));
    expect(settled).toBe(false);
    child.emit("close", 0, null);
    await done;
    expect(Buffer.concat(chunks).toString()).toBe("synthetic SQL");
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("rejects a non-zero exit even with complete stdout", async () => {
    const done = streamDatabaseTool(options());
    const rejected = expect(done).rejects.toThrow("tool exited 7: failed");
    await start();
    child.stdout.end("valid SQL");
    child.stderr.write(" failed \n");
    child.emit("close", 7, null);
    await rejected;
  });

  it("keeps exactly the first 65,536 stderr bytes across chunks and drains the rest", async () => {
    const done = streamDatabaseTool(options());
    const rejected = expect(done).rejects.toMatchObject({
      message: `tool exited 2: ${"a".repeat(65_530)}bbbbbb`,
    });
    await start();
    child.stderr.write(Buffer.alloc(65_530, "a"));
    child.stderr.write(Buffer.alloc(100_000, "b"));
    child.stderr.write("discarded diagnostics");
    child.stdout.end();
    child.emit("close", 2, null);
    await rejected;
  });

  it("preserves a spawn error and reaps the failed child", async () => {
    const error = Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });
    const done = streamDatabaseTool(options());
    const rejected = expect(done).rejects.toBe(error);
    let settled = false;
    void done.catch(() => { settled = true; });
    child.emit("error", error);
    await vi.waitFor(() => expect(child.kill).toHaveBeenCalledWith("SIGKILL"));
    expect(settled).toBe(false);
    child.emit("close", -2, null);
    await rejected;
  });

  it("allows the caller to wrap a spawn error with its cause", async () => {
    const error = new Error("spawn ENOENT");
    const done = streamDatabaseTool({
      ...options(), spawnError: (cause) => new Error("Could not start tool", { cause }),
    });
    const rejected = expect(done).rejects.toMatchObject({ message: "Could not start tool", cause: error });
    child.emit("error", error);
    child.emit("close", -2, null);
    await rejected;
  });

  it("kills on timeout, aborts the pipeline and waits for close before rejecting", async () => {
    vi.useFakeTimers();
    const done = streamDatabaseTool({ ...options(), timeoutError: () => new Error("tool timed out") });
    const rejected = expect(done).rejects.toThrow("tool timed out");
    await start();
    let settled = false;
    void done.catch(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    expect(child.stdout.destroyed).toBe(true);
    expect(settled).toBe(false);
    child.emit("close", null, "SIGKILL");
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("preserves signal-exit wording when no timeout message is supplied", async () => {
    vi.useFakeTimers();
    const done = streamDatabaseTool(options());
    const rejected = expect(done).rejects.toThrow("tool exited SIGKILL:");
    await start();
    await vi.advanceTimersByTimeAsync(1_000);
    child.emit("close", null, "SIGKILL");
    await rejected;
  });

  it("reports the tool's exit reason ahead of an input pipeline failure", async () => {
    const source = new PassThrough();
    const done = streamDatabaseTool({
      ...options(),
      direction: "stdin",
      stream: (sink, signal) => pipeline(source, sink, { signal }),
    });
    const rejected = expect(done).rejects.toThrow("tool exited 3: not owner");
    child.emit("spawn");
    await vi.waitFor(() => expect(child.stdin.listenerCount("error")).toBeGreaterThan(0));
    child.stdin.destroy(new Error("EPIPE"));
    child.stderr.write("not owner");
    child.emit("close", 3, null);
    await rejected;
  });

  it("keeps an input pipeline error when the tool itself exits successfully", async () => {
    const error = new Error("corrupt gzip");
    const done = streamDatabaseTool({
      ...options(), direction: "stdin", stream: () => Promise.reject(error),
    });
    const rejected = expect(done).rejects.toBe(error);
    child.emit("spawn");
    child.emit("close", 0, null);
    await rejected;
  });

  it("kills and reaps the producer on a sink failure", async () => {
    const error = new Error("disk full");
    const done = streamDatabaseTool({
      ...options(), stream: () => Promise.reject(error),
    });
    const rejected = expect(done).rejects.toBe(error);
    child.emit("spawn");
    await vi.waitFor(() => expect(child.kill).toHaveBeenCalledWith("SIGKILL"));
    child.emit("close", null, "SIGKILL");
    await rejected;
  });
});
