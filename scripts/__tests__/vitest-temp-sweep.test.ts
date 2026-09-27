import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  MAX_REMOVALS_PER_RUN,
  STALE_AFTER_MS,
  VITEST_TEMP_DIR_NAME,
  nodeSweepFs,
  startVitestTempSweep,
  sweepStaleVitestTempDirs,
  touchVitestTempDirs,
  type SweepFs,
} from "../lib/vitest-temp-sweep";

/**
 * #3671 — every case runs against a REAL directory tree in a temp folder this
 * suite owns, rather than a mocked file system: what the sweep must get right is
 * how real directories, links and modification times look to `lstat`, and a
 * mock would only restate the assumptions under test. The one injected call is
 * the failing `rm`, because a delete cannot be made to fail portably.
 *
 * The suite's own root is named `vitest-temp-sweep-test-XXXXXX`, which is not a
 * nanoid, so a sweep started by a concurrent run can never match it.
 *
 * Times are fixed relative to `NOW` and passed in, so the frozen test clock and
 * the real one are both irrelevant here.
 */

const NOW = Date.parse("2026-07-01T00:00:00.000Z");
const STALE = NOW - STALE_AFTER_MS - 60 * 60 * 1000;
const FRESH = NOW - 60 * 1000;

/** Twenty-one characters from the nanoid alphabet, distinct per call. */
let counter = 0;
function nanoidName(): string {
  counter += 1;
  return `A-b_${String(counter).padStart(17, "0")}`;
}

let root: string;
let outside: string;
let suiteRoot: string;

beforeEach(() => {
  suiteRoot = mkdtempSync(path.join(tmpdir(), "vitest-temp-sweep-test-"));
  root = path.join(suiteRoot, "tmp");
  outside = path.join(suiteRoot, "outside");
  mkdirSync(root);
  mkdirSync(outside);
});

afterEach(() => {
  rmSync(suiteRoot, { recursive: true, force: true });
});

function setMtime(target: string, ms: number): void {
  utimesSync(target, ms / 1000, ms / 1000);
}

/**
 * A folder shaped like Vitest's: `<name>/<env>/<sha1 file>`. Children are
 * timed first, because creating an entry moves its parent's mtime.
 */
function vitestDir(
  parent: string,
  name: string,
  times: { dir?: number; ssr?: number; client?: number } = {},
  environments: readonly string[] = ["ssr"],
): string {
  const dir = path.join(parent, name);
  mkdirSync(dir);
  for (const env of environments) {
    const envDir = path.join(dir, env);
    mkdirSync(envDir);
    writeFileSync(path.join(envDir, "0123456789abcdef0123456789abcdef01234567"), "x");
    const time = env === "ssr" ? times.ssr : env === "client" ? times.client : undefined;
    setMtime(envDir, time ?? STALE);
  }
  setMtime(dir, times.dir ?? STALE);
  return dir;
}

function sweep(extra: Partial<Parameters<typeof sweepStaleVitestTempDirs>[0]> = {}) {
  return sweepStaleVitestTempDirs({
    tempRoot: root,
    maxAgeMs: STALE_AFTER_MS,
    now: () => NOW,
    ...extra,
  });
}

/** Creates a directory junction (a symlink off Windows); `false` if refused. */
function tryLink(target: string, link: string): boolean {
  try {
    symlinkSync(target, link, "junction");
    return true;
  } catch {
    return false;
  }
}

describe("sweepStaleVitestTempDirs (#3671)", () => {
  it("removes a stale nanoid folder that has an ssr/ sub-folder", async () => {
    const stale = vitestDir(root, nanoidName());
    const report = await sweep();
    expect(report.removed).toEqual([stale]);
    expect(report.failed).toEqual([]);
    expect(existsSync(stale)).toBe(false);
  });

  it("keeps a folder while any of it is fresh: the folder, ssr/ or client/", async () => {
    const freshDir = vitestDir(root, nanoidName(), { dir: FRESH });
    const freshSsr = vitestDir(root, nanoidName(), { ssr: FRESH });
    const freshClient = vitestDir(root, nanoidName(), { client: FRESH }, [
      "ssr",
      "client",
    ]);
    const report = await sweep();
    expect(report.removed).toEqual([]);
    for (const dir of [freshDir, freshSsr, freshClient]) {
      expect(existsSync(dir), dir).toBe(true);
    }
  });

  it("treats exactly the threshold as fresh, and one millisecond past it as stale", async () => {
    const atThreshold = vitestDir(root, nanoidName(), {
      dir: NOW - STALE_AFTER_MS,
      ssr: NOW - STALE_AFTER_MS,
    });
    expect((await sweep()).removed).toEqual([]);
    expect(existsSync(atThreshold)).toBe(true);
    const report = await sweep({ now: () => NOW + 1000 });
    expect(report.removed).toEqual([atThreshold]);
  });

  it("keeps stale folders whose name is not exactly a 21-character nanoid", async () => {
    const names = [
      "A-b_0000000000000000", // 20 characters
      "A-b_000000000000000000", // 22 characters
      "A-b.00000000000000000", // "." is outside the nanoid alphabet
      "A-b+00000000000000000", // so is "+"
      "A-b~00000000000000000", // and "~"
      "0f8fad5b-d9cb-469f-a165-70867728950e", // a UUID, not a nanoid
    ];
    for (const name of names) expect(VITEST_TEMP_DIR_NAME.test(name), name).toBe(false);
    expect(VITEST_TEMP_DIR_NAME.test(nanoidName())).toBe(true);

    const kept = names.map((name) => vitestDir(root, name));
    const report = await sweep();
    expect(report.removed).toEqual([]);
    for (const dir of kept) expect(existsSync(dir), dir).toBe(true);
  });

  it("keeps a stale nanoid folder with no ssr/ directory in it", async () => {
    const clientOnly = vitestDir(root, nanoidName(), {}, ["client"]);
    const empty = vitestDir(root, nanoidName(), {}, []);
    const ssrIsAFile = path.join(root, nanoidName());
    mkdirSync(ssrIsAFile);
    writeFileSync(path.join(ssrIsAFile, "ssr"), "not a directory");
    setMtime(ssrIsAFile, STALE);

    const report = await sweep();
    expect(report.removed).toEqual([]);
    for (const dir of [clientOnly, empty, ssrIsAFile]) {
      expect(existsSync(dir), dir).toBe(true);
    }
  });

  it("keeps a file whose name is a nanoid", async () => {
    const file = path.join(root, nanoidName());
    writeFileSync(file, "a file, not a folder");
    setMtime(file, STALE);
    const report = await sweep();
    expect(report.removed).toEqual([]);
    expect(readFileSync(file, "utf8")).toBe("a file, not a folder");
  });

  it("never removes the current run's own folders", async () => {
    const own = vitestDir(root, nanoidName());
    const other = vitestDir(root, nanoidName());
    const report = await sweep({ keep: [own] });
    expect(report.removed).toEqual([other]);
    expect(existsSync(own)).toBe(true);
  });

  it("swallows a failed delete and still removes the rest", async () => {
    const first = vitestDir(root, nanoidName());
    const second = vitestDir(root, nanoidName());
    const refused = new Error("EBUSY: resource busy or locked");
    const failingFs: SweepFs = {
      ...nodeSweepFs,
      rm: async (target) => {
        if (target === first) throw refused;
        return nodeSweepFs.rm(target);
      },
    };

    const report = await sweep({ fs: failingFs });
    expect(report.failed).toEqual([{ path: first, error: refused }]);
    expect(report.removed).toEqual([second]);
    expect(existsSync(first)).toBe(true);
    expect(existsSync(second)).toBe(false);
  });

  it("resolves, never rejects, when the temp root cannot be listed", async () => {
    const missing = path.join(suiteRoot, "does-not-exist");
    const report = await sweep({ tempRoot: missing });
    expect(report.removed).toEqual([]);
    expect(report.failed).toHaveLength(1);
    expect(report.failed[0]?.path).toBe(missing);
  });

  it("resolves when an lstat fails, and skips only that folder", async () => {
    const unreadable = vitestDir(root, nanoidName());
    const readable = vitestDir(root, nanoidName());
    const failingFs: SweepFs = {
      ...nodeSweepFs,
      lstat: async (target) => {
        if (target.startsWith(unreadable)) throw new Error("EPERM");
        return nodeSweepFs.lstat(target);
      },
    };
    const report = await sweep({ fs: failingFs });
    expect(report.removed).toEqual([readable]);
    expect(existsSync(unreadable)).toBe(true);
  });

  // Junctions need no elevation on Windows and are what a Windows user would
  // actually meet; off Windows the same call makes an ordinary directory
  // symlink. If the platform still refuses, the case is skipped, not passed.
  it("does not follow a nanoid-named link to a stale Vitest-shaped folder", async (ctx) => {
    const target = vitestDir(outside, nanoidName());
    const link = path.join(root, nanoidName());
    if (!tryLink(target, link)) ctx.skip();

    const report = await sweep();
    expect(report.removed).toEqual([]);
    expect(existsSync(link)).toBe(true);
    expect(existsSync(path.join(target, "ssr"))).toBe(true);
  });

  it("does not treat a linked ssr/ as Vitest's, and leaves the link's target intact", async (ctx) => {
    const target = path.join(outside, "precious");
    mkdirSync(target);
    writeFileSync(path.join(target, "keep.txt"), "keep");
    // Stale too, so a sweep that followed the link would see an old ssr/ and
    // remove the folder: this case isolates the link guard, not the age guard.
    setMtime(target, STALE);
    const dir = path.join(root, nanoidName());
    mkdirSync(dir);
    if (!tryLink(target, path.join(dir, "ssr"))) ctx.skip();
    setMtime(dir, STALE);

    const report = await sweep();
    expect(report.removed).toEqual([]);
    expect(existsSync(dir)).toBe(true);
    expect(readFileSync(path.join(target, "keep.txt"), "utf8")).toBe("keep");
  });

  it("removes at most MAX_REMOVALS_PER_RUN folders by default, and honours a lower cap", async () => {
    const dirs = Array.from({ length: MAX_REMOVALS_PER_RUN + 2 }, () =>
      vitestDir(root, nanoidName()),
    );
    expect((await sweep()).removed).toHaveLength(MAX_REMOVALS_PER_RUN);
    expect((await sweep({ maxRemovals: 1 })).removed).toHaveLength(1);
    expect(dirs.filter((dir) => existsSync(dir))).toHaveLength(1);
  });

  it("removes nothing once its signal is aborted", async () => {
    const stale = vitestDir(root, nanoidName());
    const controller = new AbortController();
    controller.abort();
    const report = await sweep({ signal: controller.signal });
    expect(report.removed).toEqual([]);
    expect(existsSync(stale)).toBe(true);
  });
});

describe("touchVitestTempDirs (#3671)", () => {
  it("moves each folder's mtime to now, and ignores one that does not exist", async () => {
    const dir = vitestDir(root, nanoidName());
    await expect(
      touchVitestTempDirs([dir, path.join(root, "not-created-yet")], () => NOW),
    ).resolves.toBeUndefined();
    expect(statSync(dir).mtimeMs).toBe(NOW);
    // And that is enough to protect it from a sweep.
    expect((await sweep()).removed).toEqual([]);
  });
});

describe("startVitestTempSweep (#3671)", () => {
  it("sweeps in the background; done resolves with the report", async () => {
    const stale = vitestDir(root, nanoidName());
    const handle = startVitestTempSweep({
      tempRoot: root,
      maxAgeMs: STALE_AFTER_MS,
      now: () => NOW,
    });
    const report = await handle.done;
    expect(report).toEqual({ removed: [stale], failed: [] });
    expect(existsSync(stale)).toBe(false);
    await expect(handle.stop()).resolves.toBe(report);
  });

  it("removes nothing further once stopped", async () => {
    const stale = vitestDir(root, nanoidName());
    const handle = startVitestTempSweep({
      tempRoot: root,
      maxAgeMs: STALE_AFTER_MS,
      now: () => NOW,
    });
    // Stopped before the listing resolves, so the loop sees the abort first.
    const report = await handle.stop();
    expect(report.removed).toEqual([]);
    expect(existsSync(stale)).toBe(true);
  });

  it("keeps its own folders alive with a heartbeat until stopped", async () => {
    const own = vitestDir(root, nanoidName());
    const handle = startVitestTempSweep({
      tempRoot: root,
      maxAgeMs: STALE_AFTER_MS,
      now: () => NOW,
      keep: [own],
      heartbeatMs: 5,
    });
    // Bounded by iterations, not by the clock (Date is frozen in this suite).
    for (let i = 0; i < 400 && statSync(own).mtimeMs !== NOW; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const report = await handle.stop();
    expect(report.removed).toEqual([]);
    expect(statSync(own).mtimeMs).toBe(NOW);
  });
});

describe("the global setup is wired into Vitest (#3671)", () => {
  it("lists vitest.global-setup.ts as the config's globalSetup", () => {
    const config = readFileSync(
      path.join(process.cwd(), "vitest.config.mts"),
      "utf8",
    );
    expect(config).toMatch(/globalSetup:\s*\[\s*"\.\/vitest\.global-setup\.ts"\s*\]/);
  });

  it("default-exports a setup function", async () => {
    const { default: setup } = await import("../../vitest.global-setup");
    expect(typeof setup).toBe("function");
  });
});
