import { createWriteStream } from "node:fs";
import { link, rm, unlink } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { streamDatabaseTool } from "./backup-db-tool.ts";

/** A dump still being written; it gets its final name only once complete. */
export const PARTIAL_SUFFIX = ".partial";

/**
 * Stream a plain SQL dump to disk; neither stdout nor stderr grows with the DB.
 * It is written under PARTIAL_SUFFIX and appears at `filepath` only once
 * complete, so a killed process never leaves a truncated dump under the final name.
 */
export async function streamPgDump(input: {
  filepath: string;
  argvUrl: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
}): Promise<void> {
  // A timestamp collision must not truncate or remove another run's backup.
  const partialPath = `${input.filepath}${PARTIAL_SUFFIX}`;
  let ownsFile = false;
  try {
    await streamDatabaseTool({
      command: "pg_dump",
      args: [input.argvUrl],
      env: input.env,
      timeoutMs: input.timeoutMs,
      direction: "stdout",
      stream: (source, signal) => {
        const output = createWriteStream(partialPath, { flags: "wx" });
        output.on("open", () => { ownsFile = true; });
        return pipeline(source, createGzip(), output, { signal });
      },
      exitError: (code, signal, stderr) => new Error(`pg_dump exited ${code ?? signal}: ${stderr}`),
      timeoutError: () => new Error(`pg_dump timed out after ${input.timeoutMs} ms`),
    });
    // link() refuses an existing final name where rename() would overwrite it.
    await link(partialPath, input.filepath);
    await unlink(partialPath);
  } catch (error) {
    // The helper closes the stream and reaps the child before file cleanup.
    if (ownsFile) await rm(partialPath, { force: true });
    throw error;
  }
}
