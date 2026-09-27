import type { ChildProcess, SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  existsSync,
  lstatSync,
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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  MAX_ATTEMPTS_PER_RUN,
  STALE_AFTER_MS,
  SWEEP_OPTIONS_ENV,
  SWEEP_SCRIPT,
  TRASH_SUFFIX,
  VITEST_TEMP_DIR_NAME,
  launchSweep,
  nodeSweepFs,
  ownTempDirs,
  runSweepFromEnv,
  setupVitestTempSweep,
  startHeartbeat,
  sweepStaleVitestTempDirs,
  touchVitestTempDirs,
  type SweepFs,
} from "../lib/vitest-temp-sweep";

/**
 * #3671 — every case runs against a REAL directory tree in a temp folder this
 * suite owns, rather than a mocked file system: what the sweep must get right is
 * how real directories, links and modification times look to `lstat`, and a
 * mock would only restate the assumptions under test. The injected calls are
 * the failing ones: an `rm`, a `rename` or an `lstat` that refuses, or an
 * `lstat` reporting another owner, because none of those can be produced
 * portably on a real disk.
 *
 * The suite's own root is named `vitest-temp-sweep-test-XXXXXX`, which is not a
 * nanoid, so a sweep started by a concurrent run can never match it.
 *
 * `NOW` is a whole-second instant deliberately far from the frozen test clock
 * (2026-07-01), and it is always passed in. So a `Date.now()` that slipped into
 * the code under test would produce a different, detectable time.
 */

const NOW = Date.parse("2026-03-15T12:34:56.000Z");
const STALE = NOW - STALE_AFTER_MS - 60 * 60 * 1000;
const FRESH = NOW - 60 * 1000;
const SHA1_NAME = "0123456789abcdef0123456789abcdef01234567";

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
    writeFileSync(path.join(envDir, SHA1_NAME), "x");
    const time =
      env === "ssr" ? times.ssr : env === "client" ? times.client : undefined;
    setMtime(envDir, time ?? STALE);
  }
  setMtime(dir, times.dir ?? STALE);
  return dir;
}

function sweep(
  extra: Partial<Parameters<typeof sweepStaleVitestTempDirs>[0]> = {},
) {
  return sweepStaleVitestTempDirs({
    tempRoot: root,
    maxAgeMs: STALE_AFTER_MS,
    now: () => NOW,
    uid: null,
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

/** Waits for `condition`, bounded by iterations: `Date` is frozen here. */
async function eventually(condition: () => boolean, tries = 400): Promise<void> {
  for (let i = 0; i < tries && !condition(); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("sweepStaleVitestTempDirs: what is removed (#3671)", () => {
  it("removes a stale nanoid folder with ssr/, and leaves no trash behind", async () => {
    const stale = vitestDir(root, nanoidName());
    const report = await sweep();
    expect(report).toEqual({ removed: [stale], failed: [] });
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(stale + TRASH_SUFFIX)).toBe(false);
  });

  it("removes a stale folder holding only client/, or both ssr/ and client/", async () => {
    const clientOnly = vitestDir(root, nanoidName(), {}, ["client"]);
    const both = vitestDir(root, nanoidName(), {}, ["ssr", "client"]);
    const report = await sweep();
    expect(report.removed.sort()).toEqual([clientOnly, both].sort());
    expect(existsSync(clientOnly)).toBe(false);
    expect(existsSync(both)).toBe(false);
  });

  it("accepts Vitest's atomic-write temp files in a marker directory", async () => {
    const dir = vitestDir(root, nanoidName());
    writeFileSync(path.join(dir, "ssr", ".tmp-1700000000000-abc123"), "x");
    setMtime(path.join(dir, "ssr"), STALE);
    expect((await sweep()).removed).toEqual([dir]);
  });

  it("uses the configured owner check, and passes a folder the owner matches", async () => {
    const dir = vitestDir(root, nanoidName());
    const owner = lstatSync(dir).uid;
    expect((await sweep({ uid: owner })).removed).toEqual([dir]);
  });
});

describe("sweepStaleVitestTempDirs: what is kept (#3671)", () => {
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

  it("treats exactly the threshold as fresh, and one second past it as stale", async () => {
    const atThreshold = vitestDir(root, nanoidName(), {
      dir: NOW - STALE_AFTER_MS,
      ssr: NOW - STALE_AFTER_MS,
    });
    expect((await sweep()).removed).toEqual([]);
    expect(existsSync(atThreshold)).toBe(true);
    const report = await sweep({ now: () => NOW + 1000 });
    expect(report.removed).toEqual([atThreshold]);
  });

  it("is 24 hours, as the owner decided on #3675", () => {
    expect(STALE_AFTER_MS).toBe(24 * 60 * 60 * 1000);
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
    for (const name of names) {
      expect(VITEST_TEMP_DIR_NAME.test(name), name).toBe(false);
    }
    expect(VITEST_TEMP_DIR_NAME.test(nanoidName())).toBe(true);

    const kept = names.map((name) => vitestDir(root, name));
    const report = await sweep();
    expect(report.removed).toEqual([]);
    for (const dir of kept) expect(existsSync(dir), dir).toBe(true);
  });

  it("keeps a stale nanoid folder that is empty, or whose ssr is a file", async () => {
    const empty = vitestDir(root, nanoidName(), {}, []);
    const ssrIsAFile = path.join(root, nanoidName());
    mkdirSync(ssrIsAFile);
    writeFileSync(path.join(ssrIsAFile, "ssr"), "not a directory");
    setMtime(ssrIsAFile, STALE);
    const clientAndSsrFile = vitestDir(root, nanoidName(), {}, ["client"]);
    writeFileSync(path.join(clientAndSsrFile, "ssr"), "not a directory");
    setMtime(clientAndSsrFile, STALE);

    const report = await sweep();
    expect(report.removed).toEqual([]);
    for (const dir of [empty, ssrIsAFile, clientAndSsrFile]) {
      expect(existsSync(dir), dir).toBe(true);
    }
  });

  it("keeps a stale folder with any child besides ssr/ and client/", async () => {
    const extraDir = vitestDir(root, nanoidName());
    mkdirSync(path.join(extraDir, "photos"));
    setMtime(path.join(extraDir, "photos"), STALE);
    setMtime(extraDir, STALE);
    const extraFile = vitestDir(root, nanoidName(), {}, ["ssr", "client"]);
    writeFileSync(path.join(extraFile, "notes.txt"), "mine");
    setMtime(extraFile, STALE);

    const report = await sweep();
    expect(report.removed).toEqual([]);
    expect(existsSync(path.join(extraDir, "photos"))).toBe(true);
    expect(readFileSync(path.join(extraFile, "notes.txt"), "utf8")).toBe("mine");
  });

  it("keeps a folder whose marker directory holds files that are not Vitest's", async () => {
    const dir = vitestDir(root, nanoidName());
    writeFileSync(path.join(dir, "ssr", "thesis.docx"), "precious");
    setMtime(path.join(dir, "ssr"), STALE);
    expect((await sweep()).removed).toEqual([]);
    expect(existsSync(path.join(dir, "ssr", "thesis.docx"))).toBe(true);
  });

  it("keeps a file whose name is a nanoid", async () => {
    const file = path.join(root, nanoidName());
    writeFileSync(file, "a file, not a folder");
    setMtime(file, STALE);
    const report = await sweep();
    expect(report.removed).toEqual([]);
    expect(readFileSync(file, "utf8")).toBe("a file, not a folder");
  });

  it("never removes the current run's own folders, and ignores non-string keep entries", async () => {
    const own = vitestDir(root, nanoidName());
    const other = vitestDir(root, nanoidName());
    const report = await sweep({ keep: [undefined, 42, null, own] });
    expect(report.removed).toEqual([other]);
    expect(existsSync(own)).toBe(true);
  });

  it("keeps a folder, or a marker child, owned by somebody else", async () => {
    const dir = vitestDir(root, nanoidName());
    const owner = lstatSync(dir).uid;
    expect((await sweep({ uid: owner + 1 })).removed).toEqual([]);

    const markerOwnedElsewhere: SweepFs = {
      ...nodeSweepFs,
      lstat: async (target) => {
        const stats = await nodeSweepFs.lstat(target);
        if (target !== path.join(dir, "ssr")) return stats;
        return {
          isDirectory: () => stats.isDirectory(),
          isSymbolicLink: () => stats.isSymbolicLink(),
          mtimeMs: stats.mtimeMs,
          uid: owner + 1,
        };
      },
    };
    const report = await sweep({ uid: owner, fs: markerOwnedElsewhere });
    expect(report.removed).toEqual([]);
    expect(existsSync(dir)).toBe(true);
  });
});

// Junctions need no elevation on Windows and are what a Windows user would
// actually meet; off Windows the same call makes an ordinary directory
// symlink. If the platform still refuses, the case is skipped, not passed.
describe("sweepStaleVitestTempDirs: links are never followed (#3671)", () => {
  it("does not follow a nanoid-named link to a stale Vitest-shaped folder", async (ctx) => {
    const target = vitestDir(outside, nanoidName());
    const link = path.join(root, nanoidName());
    if (!tryLink(target, link)) ctx.skip();

    const report = await sweep();
    expect(report.removed).toEqual([]);
    expect(existsSync(link)).toBe(true);
    expect(existsSync(path.join(target, "ssr", SHA1_NAME))).toBe(true);
  });

  it("keeps a folder whose ssr/ is a link, even beside a real client/", async (ctx) => {
    const target = path.join(outside, "precious");
    mkdirSync(target);
    writeFileSync(path.join(target, SHA1_NAME), "keep");
    // Stale too, so a sweep that followed the link would see an old ssr/ and
    // remove the folder: this case isolates the link guard, not the age guard.
    setMtime(target, STALE);
    const dir = vitestDir(root, nanoidName(), {}, ["client"]);
    if (!tryLink(target, path.join(dir, "ssr"))) ctx.skip();
    setMtime(dir, STALE);

    const report = await sweep();
    expect(report.removed).toEqual([]);
    expect(existsSync(dir)).toBe(true);
    expect(readFileSync(path.join(target, SHA1_NAME), "utf8")).toBe("keep");
  });

  it("does not follow a trash-named link", async (ctx) => {
    const target = vitestDir(outside, nanoidName());
    const link = path.join(root, nanoidName() + TRASH_SUFFIX);
    if (!tryLink(target, link)) ctx.skip();

    expect((await sweep()).removed).toEqual([]);
    expect(existsSync(path.join(target, "ssr", SHA1_NAME))).toBe(true);
  });
});

describe("sweepStaleVitestTempDirs: failures and limits (#3671)", () => {
  it("swallows a failed delete, leaves the claimed folder as trash, and removes the rest", async () => {
    const first = vitestDir(root, nanoidName());
    const second = vitestDir(root, nanoidName());
    const refused = new Error("EBUSY: resource busy or locked");
    const failingFs: SweepFs = {
      ...nodeSweepFs,
      rm: async (target) => {
        if (target === first + TRASH_SUFFIX) throw refused;
        return nodeSweepFs.rm(target);
      },
    };

    const report = await sweep({ fs: failingFs });
    expect(report.failed).toEqual([{ path: first + TRASH_SUFFIX, error: refused }]);
    expect(report.removed).toEqual([second]);
    expect(existsSync(first + TRASH_SUFFIX)).toBe(true);
    expect(existsSync(second)).toBe(false);

    // The remnant no longer looks like Vitest's, and the next sweep clears it
    // even though it is fresh: only this module creates that name.
    setMtime(first + TRASH_SUFFIX, FRESH);
    expect((await sweep()).removed).toEqual([first + TRASH_SUFFIX]);
    expect(existsSync(first + TRASH_SUFFIX)).toBe(false);
  });

  it("swallows a failed claim (rename) and deletes nothing it did not claim", async () => {
    const dir = vitestDir(root, nanoidName());
    const claimed = new Error("EPERM: operation not permitted");
    const failingFs: SweepFs = {
      ...nodeSweepFs,
      rename: async () => {
        throw claimed;
      },
    };
    const report = await sweep({ fs: failingFs });
    expect(report).toEqual({ removed: [], failed: [{ path: dir, error: claimed }] });
    expect(existsSync(path.join(dir, "ssr", SHA1_NAME))).toBe(true);
  });

  it("keeps trash-named files and trash names whose id is not a nanoid", async () => {
    const file = path.join(root, nanoidName() + TRASH_SUFFIX);
    writeFileSync(file, "file");
    const badId = path.join(root, `short${TRASH_SUFFIX}`);
    mkdirSync(badId);
    expect((await sweep()).removed).toEqual([]);
    expect(existsSync(file)).toBe(true);
    expect(existsSync(badId)).toBe(true);
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

  it("makes at most MAX_ATTEMPTS_PER_RUN attempts by default, and honours a lower cap", async () => {
    const dirs = Array.from({ length: MAX_ATTEMPTS_PER_RUN + 2 }, () =>
      vitestDir(root, nanoidName()),
    );
    expect((await sweep()).removed).toHaveLength(MAX_ATTEMPTS_PER_RUN);
    expect((await sweep({ maxAttempts: 1 })).removed).toHaveLength(1);
    expect(dirs.filter((dir) => existsSync(dir))).toHaveLength(1);
  });

  it("counts failed attempts towards the cap, not just removals", async () => {
    Array.from({ length: 5 }, () => vitestDir(root, nanoidName()));
    let renames = 0;
    const failingFs: SweepFs = {
      ...nodeSweepFs,
      rename: async () => {
        renames += 1;
        throw new Error("EBUSY");
      },
    };
    const report = await sweep({ fs: failingFs, maxAttempts: 3 });
    expect(report.failed).toHaveLength(3);
    expect(renames).toBe(3);
  });
});

describe("touchVitestTempDirs and the heartbeat (#3671)", () => {
  it("moves each folder's mtime to the injected now, and ignores one that does not exist", async () => {
    const dir = vitestDir(root, nanoidName());
    await expect(
      touchVitestTempDirs([dir, path.join(root, "not-created-yet")], () => NOW),
    ).resolves.toBeUndefined();
    expect(statSync(dir).mtimeMs).toBe(NOW);
    // And that is enough to protect it from a sweep.
    expect((await sweep()).removed).toEqual([]);
  });

  it("keeps its folders fresh while running, and stops touching them once stopped", async () => {
    const own = vitestDir(root, nanoidName());
    const stop = startHeartbeat([own], () => NOW, 5);
    await eventually(() => statSync(own).mtimeMs === NOW);
    expect(statSync(own).mtimeMs).toBe(NOW);

    stop();
    // Let any tick already in flight land, then prove no later one does.
    await new Promise((resolve) => setTimeout(resolve, 20));
    setMtime(own, STALE);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(statSync(own).mtimeMs).toBe(STALE);
  });
});

describe("ownTempDirs (#3671)", () => {
  it("collects this project's, every project's and the instance's folder", () => {
    const warn = vi.fn();
    const dirs = ownTempDirs(
      {
        tmpDir: "/t/project",
        vitest: {
          projects: [{ tmpDir: "/t/project" }, { tmpDir: "/t/other" }, null, {}],
          _tmpDir: "/t/root",
        },
      },
      warn,
    );
    expect(dirs).toEqual(["/t/project", "/t/other", "/t/root"]);
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", undefined],
    ["a number", 42],
    ["empty", ""],
  ])("warns, and does not throw, when _tmpDir is %s", (_label, instanceDir) => {
    const warn = vi.fn();
    const dirs = ownTempDirs(
      { tmpDir: "/t/project", vitest: { projects: [], _tmpDir: instanceDir } },
      warn,
    );
    expect(dirs).toEqual(["/t/project"]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("tolerates projects that are not iterable", () => {
    const warn = vi.fn();
    expect(
      ownTempDirs({ tmpDir: "/t/p", vitest: { projects: {}, _tmpDir: "/t/r" } }, warn),
    ).toEqual(["/t/p", "/t/r"]);
    expect(ownTempDirs({}, warn)).toEqual([]);
  });
});

describe("setupVitestTempSweep (#3671)", () => {
  const project = {
    tmpDir: "/t/project",
    vitest: { projects: [{ tmpDir: "/t/project" }], _tmpDir: "/t/root" },
  };

  it("launches the sweep with this run's folders kept, and the teardown stops the heartbeat", () => {
    const launch = vi.fn();
    const stop = vi.fn();
    const heartbeat = vi.fn(() => stop);
    const teardown = setupVitestTempSweep(project, {
      env: {},
      tempRoot: "/t",
      launch,
      heartbeat,
      warn: vi.fn(),
    });

    expect(launch).toHaveBeenCalledWith({
      tempRoot: "/t",
      maxAgeMs: STALE_AFTER_MS,
      keep: ["/t/project", "/t/root"],
    });
    expect(heartbeat).toHaveBeenCalledWith(
      ["/t/project", "/t/root"],
      expect.any(Function),
    );
    expect(stop).not.toHaveBeenCalled();
    teardown();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("skips everything, and warns once, under libfaketime", () => {
    const launch = vi.fn();
    const heartbeat = vi.fn(() => () => {});
    const warn = vi.fn();
    const teardown = setupVitestTempSweep(project, {
      env: { FAKETIME: "+1y" },
      launch,
      heartbeat,
      warn,
    });
    expect(launch).not.toHaveBeenCalled();
    expect(heartbeat).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(() => teardown()).not.toThrow();
  });

  it("never throws: a failure warns once and returns a no-op teardown", () => {
    const warn = vi.fn();
    const hostile = {
      get vitest(): never {
        throw new Error("internals moved");
      },
    };
    const teardown = setupVitestTempSweep(hostile, { env: {}, warn });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(() => teardown()).not.toThrow();

    const launchThrows = setupVitestTempSweep(project, {
      env: {},
      warn,
      launch: () => {
        throw new Error("spawn EAGAIN");
      },
      heartbeat: () => () => {},
    });
    expect(warn).toHaveBeenCalledTimes(2);
    expect(() => launchThrows()).not.toThrow();
  });
});

describe("launchSweep and the child process (#3671)", () => {
  function fakeChild() {
    const child = new EventEmitter() as EventEmitter & { unref: () => void; pid?: number };
    child.unref = vi.fn();
    return child;
  }

  it("spawns this file, detached and silent, with the options in the environment", () => {
    const child = fakeChild();
    const calls: Array<[string, readonly string[], SpawnOptions]> = [];
    const spawnFn = (command: string, args: readonly string[], options: SpawnOptions) => {
      calls.push([command, args, options]);
      return child as unknown as ChildProcess;
    };
    const options = { tempRoot: "/t", maxAgeMs: STALE_AFTER_MS, keep: ["/t/own"] };
    expect(launchSweep(options, spawnFn)).toBe(child);

    expect(calls).toHaveLength(1);
    const [command, args, spawnOptions] = calls[0]!;
    expect(command).toBe(process.execPath);
    expect(args).toEqual(["--no-warnings", SWEEP_SCRIPT]);
    expect(path.basename(SWEEP_SCRIPT)).toBe("vitest-temp-sweep.ts");
    expect(existsSync(SWEEP_SCRIPT)).toBe(true);
    expect(spawnOptions).toMatchObject({ detached: true, stdio: "ignore", windowsHide: true });
    // The child inherits the run's environment, plus its options.
    for (const [key, value] of Object.entries(process.env)) {
      expect(spawnOptions.env?.[key], key).toBe(value);
    }
    expect(JSON.parse(spawnOptions.env?.[SWEEP_OPTIONS_ENV] ?? "null")).toEqual(options);
    expect(child.unref).toHaveBeenCalledTimes(1);
    // An async spawn failure is swallowed rather than crashing the run.
    expect(() => child.emit("error", new Error("ENOENT"))).not.toThrow();
  });

  it("returns null rather than throwing when spawn throws", () => {
    const spawnFn = () => {
      throw new Error("EAGAIN");
    };
    expect(launchSweep({ tempRoot: "/t", maxAgeMs: 1, keep: [] }, spawnFn)).toBeNull();
  });

  it("runSweepFromEnv ignores missing or malformed options", async () => {
    expect(await runSweepFromEnv({})).toBeNull();
    expect(await runSweepFromEnv({ [SWEEP_OPTIONS_ENV]: "{not json" })).toBeNull();
    expect(await runSweepFromEnv({ [SWEEP_OPTIONS_ENV]: '{"tempRoot":1}' })).toBeNull();
  });

  it("runSweepFromEnv sweeps what the options describe", async () => {
    const stale = vitestDir(root, nanoidName());
    const own = vitestDir(root, nanoidName());
    // runSweepFromEnv reads Date.now() (frozen here, real in the child) rather
    // than NOW, so a zero threshold is used: any past mtime is then stale.
    const report = await runSweepFromEnv({
      [SWEEP_OPTIONS_ENV]: JSON.stringify({ tempRoot: root, maxAgeMs: 0, keep: [own] }),
    });
    expect(report?.removed).toEqual([stale]);
    expect(existsSync(own)).toBe(true);
  });

  // Launches a real Node process that runs this TypeScript file directly, so it
  // carries its own budget ("A test that launches a process needs its own
  // budget", docs/TESTING.md).
  it("really runs as a child process under Node's type stripping", async () => {
    const stale = vitestDir(root, nanoidName());
    const own = vitestDir(root, nanoidName());
    const child = launchSweep({ tempRoot: root, maxAgeMs: 0, keep: [own] });
    expect(child).not.toBeNull();
    await new Promise<void>((resolve) => {
      child!.once("exit", () => resolve());
      child!.once("error", () => resolve());
    });
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(own)).toBe(true);
  }, 30_000);
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
