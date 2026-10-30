import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { E2E_SPEC_SECONDS } from "./e2e-spec-durations.mjs";
import {
  PLAYWRIGHT_TEST_FILE,
  notChromiumIgnore,
  chromiumSpecFiles,
  dealShards,
  parseE2eShard,
  shardTestMatch,
  specsForShard,
} from "./e2e-spec-shard.mjs";
import { renderDurationsModule, specSecondsFromLog } from "./record-e2e-spec-durations.mjs";

const root = path.resolve(import.meta.dirname, "..", "..");

describe("E2E spec shards (#4397)", () => {
  it("parses E2E_SHARD, treating unset as an unsharded run and refusing a bad value", () => {
    expect(parseE2eShard(undefined)).toBeNull();
    expect(parseE2eShard("")).toBeNull();
    expect(parseE2eShard("2/3")).toEqual({ index: 2, total: 3 });
    for (const bad of ["0/3", "4/3", "3", "a/b", "1/0", "1/3 "]) expect(() => parseE2eShard(bad)).toThrow(/Invalid E2E_SHARD/);
  });

  it("splits the real chromium specs into disjoint shards that together hold every spec exactly once", () => {
    const files = chromiumSpecFiles(path.join(root, "e2e"));
    expect(files.length).toBeGreaterThan(10);
    expect(files.some((file) => file.startsWith("multi-lodge/") || file.startsWith("pre-setup/"))).toBe(false);
    for (const total of [1, 2, 3, 4]) {
      const shards = Array.from({ length: total }, (_, i) => specsForShard(files, { index: i + 1, total }));
      expect(shards.flat().sort()).toEqual(files);
      expect(new Set(shards.flat()).size).toBe(files.length);
      expect(shards.every((shard) => shard.length > 0)).toBe(true);
    }
  });

  it("deals by duration: longest first to the least-loaded shard, shard 1 charged for pre-setup", () => {
    const durations = { "a.spec.ts": 50, "b.spec.ts": 40, "c.spec.ts": 30, "d.spec.ts": 20, "pre-setup/gate.spec.ts": 25 };
    const files = ["a.spec.ts", "b.spec.ts", "c.spec.ts", "d.spec.ts", "new.spec.ts"];
    // new.spec.ts is unmeasured and dealt as the median (30). Shard 1 starts at
    // 25, so a (50) goes to shard 2, b (40) to 1, c (30) to 2, new (30) to 1, d (20) to 2.
    expect(dealShards(files, 2, durations)).toEqual([
      ["b.spec.ts", "new.spec.ts"],
      ["a.spec.ts", "c.spec.ts", "d.spec.ts"],
    ]);
    // Unsharded, nothing is charged and everything lands in the one shard.
    expect(dealShards(files, 1, durations)).toEqual([[...files].sort()]);
    // Input order never changes the deal.
    expect(dealShards([...files].reverse(), 2, durations)).toEqual(dealShards(files, 2, durations));
    expect(specsForShard(files, { index: 2, total: 2 }, durations)).toEqual(["a.spec.ts", "c.spec.ts", "d.spec.ts"]);
  });

  it("keeps the real shards within one spec's time of each other", () => {
    const files = chromiumSpecFiles(path.join(root, "e2e"));
    const seconds = (file) => E2E_SPEC_SECONDS[file] ?? 0;
    const preSetup = Object.entries(E2E_SPEC_SECONDS).filter(([file]) => file.startsWith("pre-setup/")).reduce((sum, [, value]) => sum + value, 0);
    const longest = Math.max(preSetup, ...files.map(seconds));
    for (const total of [2, 3, 4]) {
      const loads = dealShards(files, total).map((shard, i) => shard.reduce((sum, file) => sum + seconds(file), i === 0 ? preSetup : 0));
      expect(Math.max(...loads) - Math.min(...loads), `${total} shards: ${loads.join(", ")}`).toBeLessThanOrEqual(longest);
    }
  });

  it("measures only spec files that exist, so a rename or deletion refreshes the file", () => {
    const e2eDir = path.join(root, "e2e");
    for (const file of Object.keys(E2E_SPEC_SECONDS)) expect(existsSync(path.join(e2eDir, file)), file).toBe(true);
    expect(Object.keys(E2E_SPEC_SECONDS)).not.toContain("auth.setup.ts");
  });

  it("records each spec's wall-clock share of its job from gh run logs, and renders the module it reads", () => {
    const log = [
      "Shard A\tRun\t2026-10-27T10:00:00.000Z   ✓    1 [setup] › e2e/auth.setup.ts:10:6 › sign in (7.1s)",
      "Shard A\tRun\t2026-10-27T10:00:05.000Z   ✓    2 [chromium] › e2e/a.spec.ts:3:5 › first (4.0s)",
      "Shard A\tRun\t2026-10-27T10:00:15.000Z   ✓    3 [chromium] › e2e/b.spec.ts:3:5 › hook time counts (2.0s)",
      "Shard B\tRun\t2026-10-27T10:00:00.000Z   ✓    1 [chromium] › e2e/a.spec.ts:9:5 › other shard (1.5m)",
      "Shard B\tRun\t2026-10-27T10:00:30.000Z   ✓    2 [pre-setup] › e2e/pre-setup/gate.spec.ts:9:5 › gate (500ms)",
      "Shard B\tRun\t2026-10-27T10:00:31.000Z   -    3 [chromium] › e2e/c.spec.ts:9:5 › skipped",
    ].join("\n");
    const seconds = specSecondsFromLog(log);
    expect(seconds).toEqual({ "a.spec.ts": 94, "b.spec.ts": 10, "pre-setup/gate.spec.ts": 30 });
    const rendered = renderDurationsModule(seconds, "a test");
    expect(rendered).toContain('export const E2E_SPEC_SECONDS = {\n  "a.spec.ts": 94,');
    // The committed module is what the recorder writes, so a hand edit shows.
    const committed = readFileSync(path.join(root, "scripts", "ci", "e2e-spec-durations.mjs"), "utf8");
    const source = /^\/\/ Source: (.*)\.$/m.exec(committed)[1];
    expect(committed).toBe(renderDurationsModule(E2E_SPEC_SECONDS, source));
  });

  it("anchors each shard's patterns to the absolute test dir, and refuses a shard with no files", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "e2e-shard-"));
    mkdirSync(path.join(dir, "sub"));
    mkdirSync(path.join(dir, "pre-setup"));
    for (const file of ["waitlist.spec.ts", "admin-waitlist.spec.ts", "sub/waitlist.spec.ts", "pre-setup/gate.spec.ts", "notes.ts"]) {
      writeFileSync(path.join(dir, file), "");
    }
    expect(chromiumSpecFiles(dir)).toEqual(["admin-waitlist.spec.ts", "sub/waitlist.spec.ts", "waitlist.spec.ts"]);
    const patterns = shardTestMatch(dir, { index: 1, total: 1 });
    const root = path.resolve(dir).split(path.sep).join("/");
    const matches = (file) => patterns.some((pattern) => pattern.test(`${root}/${file}`));
    expect(matches("waitlist.spec.ts")).toBe(true);
    expect(matches("sub/waitlist.spec.ts")).toBe(true);
    expect(patterns.filter((pattern) => pattern.test(`${root}/sub/waitlist.spec.ts`))).toHaveLength(1);
    expect(matches("pre-setup/gate.spec.ts")).toBe(false);
    // One file between two shards leaves one of them empty, whichever the deal picks.
    const empty = [1, 2].filter((index) => {
      try {
        shardTestMatch(path.join(dir, "sub"), { index, total: 2 });
        return false;
      } catch (error) {
        expect(String(error)).toMatch(/found no spec files/);
        return true;
      }
    });
    expect(empty).toHaveLength(1);
  });

  it("keeps Playwright's default test-file shapes, and ignores its two other projects' dirs by absolute or relative path", () => {
    for (const file of ["a.spec.ts", "a.test.ts", "a.spec.tsx", "a.spec.mjs", "a.test.js"]) expect(PLAYWRIGHT_TEST_FILE.test(file)).toBe(true);
    for (const file of ["auth.setup.ts", "helpers/x.ts", "a.spec.ts.snap"]) expect(PLAYWRIGHT_TEST_FILE.test(file)).toBe(false);
    const ignore = notChromiumIgnore("/home/runner/repo/e2e");
    for (const file of ["/home/runner/repo/e2e/pre-setup/a.spec.ts", "/home/runner/repo/e2e/multi-lodge/b.spec.ts"]) expect(ignore.test(file)).toBe(true);
    for (const file of ["/home/runner/repo/e2e/booking.spec.ts", "/home/runner/repo/e2e/not-multi-lodge-x.spec.ts"]) expect(ignore.test(file)).toBe(false);
    // A parent folder sharing a name must not hide the whole suite.
    expect(notChromiumIgnore("/src/worktrees/pre-setup/e2e").test("/src/worktrees/pre-setup/e2e/booking.spec.ts")).toBe(false);
  });
});
