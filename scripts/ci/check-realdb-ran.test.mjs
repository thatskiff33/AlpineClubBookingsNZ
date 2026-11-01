import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { unexercisedRealdbFiles } from "./check-realdb-ran.mjs";
import { realdbFilesToRun } from "./realdb-files.mjs";

const root = path.resolve(import.meta.dirname, "..", "..");
const A = "src/lib/__tests__/a.realdb.test.ts";
const B = "src/lib/__tests__/b.realdb.test.ts";
const result = (file, ...statuses) => ({
  name: path.join(root, file),
  assertionResults: statuses.map((status) => ({ status })),
});

describe("the realdb-all job's did-it-really-run check (#4458)", () => {
  it("accepts files whose tests all ran", () => {
    const report = { testResults: [result(A, "passed", "passed"), result(B, "passed")] };
    expect(unexercisedRealdbFiles(report, [A, B], root)).toEqual([]);
  });

  it("names a file the report never collected", () => {
    const report = { testResults: [result(A, "passed")] };
    expect(unexercisedRealdbFiles(report, [A, B], root)).toEqual([
      expect.stringContaining(`${B}: not in the Vitest report`),
    ]);
  });

  it("names a file that skipped every test (a gate env var unset)", () => {
    const report = { testResults: [result(A, "passed"), result(B, "skipped", "skipped")] };
    expect(unexercisedRealdbFiles(report, [A, B], root)).toEqual([
      expect.stringContaining(`${B}: no test passed`),
    ]);
  });

  it("names a file with no tests at all", () => {
    const report = { testResults: [result(A, "passed"), result(B)] };
    expect(unexercisedRealdbFiles(report, [A, B], root)).toEqual([
      expect.stringContaining(`${B}: no test passed`),
    ]);
  });

  it("names a file whose structural tests pass while its database describe skips", () => {
    // data-migration-verification and school-pending-adult-resolution look like this.
    const report = { testResults: [result(A, "passed", "skipped", "skipped")] };
    expect(unexercisedRealdbFiles(report, [A], root)).toEqual([
      expect.stringContaining(`${A}: 2 of 3 tests did not run`),
    ]);
  });

  it("counts a todo test as not run, and a failed one as run (the job fails on it anyway)", () => {
    expect(unexercisedRealdbFiles({ testResults: [result(A, "passed", "todo")] }, [A], root)).toHaveLength(1);
    expect(unexercisedRealdbFiles({ testResults: [result(A, "passed", "failed")] }, [A], root)).toEqual([]);
  });

  it("ignores report entries for files the job did not list", () => {
    const report = { testResults: [result(A, "passed"), result(B, "skipped")] };
    expect(unexercisedRealdbFiles(report, [A], root)).toEqual([]);
  });

  it("exits 1 naming the file from the command line, 0 when all ran, 2 without a report", () => {
    const files = realdbFilesToRun();
    const dir = mkdtempSync(path.join(tmpdir(), "realdb-ran-"));
    const write = (name, statusFor) => {
      const report = path.join(dir, name);
      writeFileSync(
        report,
        JSON.stringify({ testResults: files.map((file, i) => result(file, statusFor(i))) }),
      );
      return report;
    };
    const run = (...args) =>
      spawnSync(process.execPath, [path.join(import.meta.dirname, "check-realdb-ran.mjs"), ...args], {
        encoding: "utf8",
      });
    expect(run(write("ok.json", () => "passed")).status).toBe(0);
    const bad = run(write("bad.json", (i) => (i === 0 ? "skipped" : "passed")));
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain(`${files[0]}: no test passed`);
    expect(run().status).toBe(2);
  });
});
