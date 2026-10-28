import { spawn } from "node:child_process";
import { once } from "node:events";
import type { Readable, Writable } from "node:stream";

const STDERR_LIMIT_BYTES = 65_536;

type ToolStream =
  | { direction: "stdout"; stream: (source: Readable, signal: AbortSignal) => Promise<void> }
  | { direction: "stdin"; stream: (sink: Writable, signal: AbortSignal) => Promise<void> };

/**
 * Run a backup database tool with bounded diagnostics and streaming I/O.
 * Both the child and pipeline settle before returning, including on failure.
 * Callers own their transforms, files and operator-facing error wording.
 */
export async function streamDatabaseTool(input: ToolStream & {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  exitError: (code: number | null, signal: NodeJS.Signals | null, stderr: string) => Error;
  spawnError?: (error: unknown) => Error;
  timeoutError?: () => Error;
}): Promise<void> {
  const child = spawn(input.command, input.args, {
    env: input.env,
    stdio: input.direction === "stdout"
      ? ["ignore", "pipe", "pipe"]
      : ["pipe", "ignore", "pipe"],
  });
  let stderr = "";
  let stderrBytes = 0;
  child.stderr!.on("data", (chunk: Buffer) => {
    const kept = chunk.subarray(0, Math.max(0, STDERR_LIMIT_BYTES - stderrBytes));
    stderrBytes += kept.length;
    stderr += kept.toString("utf8");
  });
  // `error` can precede `close`; reap even when starting the tool fails.
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  const exited = new Promise<void>((resolve, reject) => {
    child.once("error", (error) => reject(input.spawnError?.(error) ?? error));
    child.once("close", (code, signal) => {
      if (code === 0) resolve();
      else reject(input.exitError(code, signal, stderr.trim()));
    });
  });
  // A missing executable can reject before the pipeline has been attached.
  exited.catch(() => {});
  const controller = new AbortController();
  let timedOut = false;
  let streamed: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await once(child, "spawn").catch(async () => { await exited; });
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      child.kill("SIGKILL");
    }, input.timeoutMs);
    if (input.direction === "stdout") {
      streamed = input.stream(child.stdout!, controller.signal);
    } else {
      streamed = input.stream(child.stdin!, controller.signal).catch(async (error: unknown) => {
        // ON_ERROR_STOP may close stdin early: prefer the tool's diagnosis to EPIPE.
        await exited;
        throw error;
      });
    }
    // EOF alone is insufficient: a tool can finish its output and then fail.
    await Promise.all([exited, streamed]);
  } catch (error) {
    controller.abort();
    child.kill("SIGKILL");
    await Promise.allSettled([closed, streamed]);
    if (timedOut) {
      if (input.timeoutError) throw input.timeoutError();
      await exited;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
