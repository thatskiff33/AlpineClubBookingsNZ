import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmodSync, existsSync, readdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { streamPgDump } from "@/lib/backup-dump";
import { realElapsedMs } from "@/lib/__tests__/helpers/clock";

const exec = promisify(execFile);

describe("streamPgDump", () => {
  let dir: string;
  let input: Parameters<typeof streamPgDump>[0];
  function command(body: string) {
    const executable = path.join(dir, "pg_dump");
    writeFileSync(executable, `#!${process.execPath}\n${body}\n`);
    chmodSync(executable, 0o755);
  }
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "backup-dump-"));
    input = {
      filepath: path.join(dir, "dump.sql.gz"),
      argvUrl: "postgresql://fixture@unused/synthetic",
      env: { NODE_ENV: "test", PATH: dir },
      timeoutMs: 10_000,
    };
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const leftovers = () => readdirSync(dir).filter((file) => file !== "pg_dump");

  it("writes a complete gzip containing the exact dump bytes", async () => {
    command('process.stdout.write("COPY example FROM stdin;\\nrow\\n\\\\.\\n");');
    await streamPgDump(input);
    expect(gunzipSync(readFileSync(input.filepath)).toString()).toBe("COPY example FROM stdin;\nrow\n\\.\n");
    // Completed atomically: only the final name remains, no .partial.
    expect(leftovers()).toEqual(["dump.sql.gz"]);
  }, 15_000);

  it("rejects a nonzero exit even after a complete stdout and removes the partial backup", async () => {
    command('process.stdout.end("valid SQL\\n", () => { process.stderr.write("dump failed"); process.exitCode = 7; });');
    await expect(streamPgDump(input)).rejects.toThrow("pg_dump exited 7: dump failed");
    expect(leftovers()).toEqual([]);
  }, 15_000);

  it("drains noisy stderr with bounded diagnostics", async () => {
    command('process.stderr.write("x".repeat(1024 * 1024), () => { process.exitCode = 2; });');
    const error = await streamPgDump(input).catch((err: Error) => err);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message.length).toBeLessThan(66_000);
    expect(existsSync(input.filepath)).toBe(false);
  }, 15_000);

  it("reports a missing executable without an unhandled rejection or partial file", async () => {
    await expect(streamPgDump(input)).rejects.toMatchObject({ code: "ENOENT", syscall: "spawn pg_dump" });
    expect(existsSync(input.filepath)).toBe(false);
  }, 15_000);

  it("never shows a dump under its final name while it is still being written", async () => {
    // The producer waits until the final name is checked, so a crash at that
    // point would leave only the .partial, which the spool prune removes.
    const probe = path.join(dir, "probe");
    command(`
      process.stdout.write("first half\\n");
      const fs = require("node:fs");
      const wait = setInterval(() => {
        if (fs.existsSync(${JSON.stringify(probe)})) { clearInterval(wait); process.stdout.write("second half\\n"); }
      }, 10);
    `);
    const done = streamPgDump(input);
    const started = process.hrtime.bigint();
    while (!existsSync(`${input.filepath}.partial`) && realElapsedMs(started) < 5_000) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(existsSync(`${input.filepath}.partial`)).toBe(true);
    expect(existsSync(input.filepath)).toBe(false);
    writeFileSync(probe, "");
    await done;
    expect(leftovers().filter((file) => file !== "probe")).toEqual(["dump.sql.gz"]);
  }, 15_000);

  it("kills a hung dump and removes its partial backup on timeout", async () => {
    command('process.stdout.write("partial SQL"); setInterval(() => {}, 1000);');
    await expect(streamPgDump({ ...input, timeoutMs: 200 })).rejects.toThrow("timed out");
    expect(leftovers()).toEqual([]);
  }, 15_000);

  it("rejects a destination failure and stops the producer", async () => {
    command('setInterval(() => process.stdout.write("row\\n"), 10);');
    const filepath = path.join(dir, "missing", "dump.sql.gz");
    await expect(streamPgDump({ ...input, filepath })).rejects.toMatchObject({ code: "ENOENT" });
    expect(existsSync(filepath)).toBe(false);
  }, 15_000);

  it("refuses an existing destination without changing or removing it", async () => {
    command('process.stdout.write("new SQL");');
    writeFileSync(input.filepath, "another run's backup");
    await expect(streamPgDump(input)).rejects.toMatchObject({ code: "EEXIST" });
    expect(readFileSync(input.filepath, "utf8")).toBe("another run's backup");
    expect(leftovers()).toEqual(["dump.sql.gz"]);
  }, 15_000);

  it("refuses another run's in-progress partial without truncating or removing it", async () => {
    command('process.stdout.write("new SQL");');
    writeFileSync(`${input.filepath}.partial`, "another run's dump in progress");
    await expect(streamPgDump(input)).rejects.toMatchObject({ code: "EEXIST" });
    expect(readFileSync(`${input.filepath}.partial`, "utf8")).toBe("another run's dump in progress");
    expect(leftovers()).toEqual(["dump.sql.gz.partial"]);
  }, 15_000);

  it("keeps peak memory flat when a synthetic dump grows from 16 to 512 MiB", async () => {
    // Real processes and streams, isolated from Vitest's heap. The producer reuses
    // one chunk and honours backpressure; resourceUsage catches even synchronous
    // allocations that an event-loop sampler would miss.
    command(`
      const { once } = require("node:events");
      (async () => {
        const chunk = Buffer.alloc(64 * 1024, "synthetic row\\n");
        for (let n = 0; n < Number(process.env.DUMP_BYTES); n += chunk.length) {
          if (!process.stdout.write(chunk)) await once(process.stdout, "drain");
        }
      })().catch(() => { process.exitCode = 1; });
    `);
    const moduleUrl = pathToFileURL(path.resolve("src/lib/backup-dump.ts")).href;
    const script = `
      import { streamPgDump } from ${JSON.stringify(moduleUrl)};
      const input = ${JSON.stringify(input)};
      input.timeoutMs = 30000;
      await streamPgDump({ ...input, env: { ...input.env, DUMP_BYTES: String(16 * 1024 * 1024) } });
      const small = process.resourceUsage().maxRSS;
      await streamPgDump({ ...input, filepath: input.filepath + ".large", env: { ...input.env, DUMP_BYTES: String(512 * 1024 * 1024) } });
      console.log(JSON.stringify({ small, large: process.resourceUsage().maxRSS }));
    `;
    const { stdout } = await exec(process.execPath, ["--input-type=module", "-e", script], { timeout: 60_000 });
    const memory = JSON.parse(stdout) as { small: number; large: number };
    // maxRSS is KiB. A whole-dump buffer adds at least 512 MiB; allow 64 MiB
    // for allocator/GC variation while the dump grows by 496 MiB.
    expect(memory.large - memory.small).toBeLessThan(64 * 1024);
  }, 65_000);
});
