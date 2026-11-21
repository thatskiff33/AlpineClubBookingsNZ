import { createWriteStream } from "node:fs";
import { link, rm, unlink } from "node:fs/promises";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { streamDatabaseTool } from "./backup-db-tool.ts";

/** A dump still being written; it gets its final name only once complete. */
export const PARTIAL_SUFFIX = ".partial";

/** pg_dump names both versions in its first lines; this much is searched. */
const VERSION_HEADER_BYTES = 8 * 1024;
const SERVER_VERSION_LINE = /^-- Dumped from database version (\S+)[^\n]*\n/m;
const CLIENT_VERSION_LINE = /^-- Dumped by pg_dump version (\S+)[^\n]*\n/m;

/** The major version of a PostgreSQL version string such as `16.4` or `17devel`. */
function postgresMajorVersion(version: string): number | undefined {
  const match = /^(\d+)/.exec(version.trim());
  return match ? Number(match[1]) : undefined;
}

/**
 * Why a dump must be refused, read from pg_dump's own header, or undefined (#5193).
 * A pg_dump newer than the server dumps it, but its output is not guaranteed to
 * load into a server of that older version: pg_dump 17 writes
 * `SET transaction_timeout`, which PostgreSQL 16 refuses, so the restore fails.
 * An older pg_dump refuses a newer server by itself.
 */
function describeDumpVersionMismatch(header: string): string | undefined {
  const server = SERVER_VERSION_LINE.exec(header)?.[1];
  const client = CLIENT_VERSION_LINE.exec(header)?.[1];
  const serverMajor = server === undefined ? undefined : postgresMajorVersion(server);
  const clientMajor = client === undefined ? undefined : postgresMajorVersion(client);
  if (serverMajor === undefined || clientMajor === undefined || clientMajor <= serverMajor) return undefined;
  return (
    `pg_dump ${client} is newer than the PostgreSQL ${server} server it was backing up, so its dump ` +
    `is not guaranteed to restore into a PostgreSQL ${serverMajor} server. Install the PostgreSQL ` +
    `${serverMajor} client tools; the application's Docker image includes the matching ones.`
  );
}

/** Passes the dump through unchanged, failing it as soon as its header shows a mismatch. */
function refuseMismatchedVersions(): Transform {
  let header = "";
  let checked = false;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      if (!checked) {
        // latin1 keeps one character per byte; the header itself is ASCII.
        header += chunk.toString("latin1", 0, Math.min(chunk.length, VERSION_HEADER_BYTES - header.length));
        const complete = SERVER_VERSION_LINE.test(header) && CLIENT_VERSION_LINE.test(header);
        if (complete || header.length >= VERSION_HEADER_BYTES) {
          checked = true;
          const mismatch = describeDumpVersionMismatch(header);
          if (mismatch) return callback(new Error(mismatch));
        }
      }
      callback(null, chunk);
    },
  });
}

/**
 * Stream a plain SQL dump to disk; neither stdout nor stderr grows with the DB.
 * It is written under PARTIAL_SUFFIX and appears at `filepath` only once
 * complete, so a killed process never leaves a truncated dump under the final name.
 * A pg_dump newer than the server is stopped at its header and nothing is kept.
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
        return pipeline(source, refuseMismatchedVersions(), createGzip(), output, { signal });
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
