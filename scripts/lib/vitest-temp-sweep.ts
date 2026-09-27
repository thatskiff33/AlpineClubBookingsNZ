/**
 * Sweeps the scratch folders Vitest leaks into the system temp directory
 * (#3671). This docstring is the one full explanation; `vitest.config.mts`,
 * `vitest.global-setup.ts` and `docs/TESTING.md` point here.
 *
 * ## The leak
 *
 * Vitest 5 creates `os.tmpdir()/<21-character nanoid>` folders: one for the
 * Vitest instance (`_tmpDir`) and one per project (`tmpDir`). The module runner
 * writes one file per transformed module into them, under a sub-folder named
 * for the Vite environment: `ssr/` for node suites, `client/` for jsdom ones.
 *
 * - The instance's root `_tmpDir` is NEVER removed, so every run leaks one,
 *   including clean, green runs (vitest-dev/vitest#11224, fix in review as
 *   vitest-dev/vitest#11248).
 * - The per-project `tmpDir` is removed in `close()`, but that `rm` swallows
 *   every error with an empty `catch {}`. So it also survives a run that is
 *   killed, times out or is interrupted, and a run where Windows refuses the
 *   delete because a file is still held (`EBUSY`/`EPERM`).
 *
 * Each leaked folder is 100–160 MB. Under agent load that was about 14 GB a day.
 *
 * ## What is removed
 *
 * A direct child of the temp root is removed only when ALL of these hold. It is
 * never searched for recursively.
 *
 * - Its name is exactly a nanoid (`VITEST_TEMP_DIR_NAME`).
 * - It is a real directory, not a symlink or a Windows junction. Off Windows it
 *   must also be owned by the current user.
 * - Its direct children are a non-empty subset of `MARKER_DIRS` (`ssr`,
 *   `client`). Every one must be a real directory with the same ownership rule,
 *   and the first few entries in each must look like Vitest's files: a 40-hex
 *   SHA-1 name, or the `.tmp-` prefix Vitest's atomic writer uses. Any other
 *   child, or a marker name that is a file or a link, disqualifies the folder.
 * - The newest modification time of the folder and of its marker children is
 *   older than `STALE_AFTER_MS` (24 hours). Adding a module adds a file to a
 *   marker directory, which moves that directory's time forward. The heartbeat
 *   below keeps an idle run's own folders fresh as well.
 * - It is not one of the current run's own folders (`keep`).
 *
 * A folder that qualifies is first renamed, in the same parent, to
 * `<name>.vitest-sweep-trash`, and only the renamed path is deleted. The rename
 * claims the folder atomically, so two concurrent sweeps cannot both delete it
 * and a Vitest process still writing to the old path cannot write into a
 * folder being deleted. A delete that is cut short leaves a trash folder that
 * no longer looks like Vitest's. The next sweep removes those first, with the
 * same link and ownership checks but no age check, because only this module
 * creates that name.
 *
 * ## What is and is not guaranteed
 *
 * The checks never follow a link, and nothing outside the temp root is ever
 * chosen as a target. Node's recursive `rm` is not atomic, though. A process
 * that can write inside a candidate folder while it is being deleted could swap
 * a sub-folder for a junction between Node's check and its descent. On Windows,
 * `%TEMP%` is per-user, so that process would already have to be running as you.
 * Off Windows, the ownership check keeps the sweep off folders another user
 * owns in a shared `/tmp`.
 *
 * ## Cost
 *
 * The sweep runs in a detached, low-priority child process (`launchSweep`). The
 * test run neither waits for it nor shares its I/O thread pool, and the child
 * outlives a short run, so even many short `vitest related` runs make progress.
 * Each sweep makes at most `MAX_ATTEMPTS_PER_RUN` removal attempts, counting
 * failures. The only in-process work is the heartbeat, one `utimes` per own
 * folder every ten minutes.
 *
 * Nothing here throws into Vitest. Every failure is recorded or swallowed,
 * because disposable-cache housekeeping must never fail or slow a test run.
 *
 * This file is also the child's entry point: `node scripts/lib/vitest-temp-sweep.ts`,
 * using Node 24's built-in type stripping. It therefore imports only Node
 * built-ins and uses only erasable TypeScript syntax.
 */
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import type { Dirent } from "node:fs";
import { lstat, opendir, readdir, rename, rm, utimes } from "node:fs/promises";
import { constants as osConstants, setPriority, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Vitest's folder name: `nanoid()` — 21 characters of `A-Za-z0-9_-`. */
export const VITEST_TEMP_DIR_NAME = /^[A-Za-z0-9_-]{21}$/;

/** The suffix a claimed folder is renamed to before it is deleted. */
export const TRASH_SUFFIX = ".vitest-sweep-trash";

/** A folder this module claimed but did not finish deleting. */
export const VITEST_TRASH_DIR_NAME = /^[A-Za-z0-9_-]{21}\.vitest-sweep-trash$/;

/** The Vite environment sub-folders Vitest writes; the only children allowed. */
export const MARKER_DIRS: readonly string[] = ["ssr", "client"];

/** A module file (`<sha1>`), or Vitest's atomic-write temp file (`.tmp-…`). */
export const MARKER_ENTRY_NAME = /^[0-9a-f]{40}$|^\.tmp-/;

/** How many entries of each marker directory are checked against the pattern. */
export const MARKER_ENTRIES_SAMPLED = 5;

/**
 * A folder untouched for longer than this is treated as leaked. Chosen by the
 * owner on #3675: 24 hours rather than 2, so an idle watch session WITHOUT this
 * setup's heartbeat (another repository, an older worktree, an editor
 * extension) keeps its folder through a working day.
 */
export const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

/**
 * Removal attempts one sweep makes at most, failures included. Every run leaks
 * about one folder, so any cap above that converges. The cap bounds how much
 * disk work one sweep does while a large backlog drains.
 */
export const MAX_ATTEMPTS_PER_RUN = 10;

/** How often a live run refreshes its own folders' modification time. */
export const HEARTBEAT_INTERVAL_MS = 10 * 60 * 1000;

/** An environment: `process.env`, or a plain object in a test. */
export type Env = Readonly<Record<string, string | undefined>>;

/** The environment variable that carries the child's options. */
export const SWEEP_OPTIONS_ENV = "VITEST_TEMP_SWEEP_OPTIONS";

export type SweepStats = {
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
  mtimeMs: number;
  uid: number;
};

/** The file-system calls the sweep makes, injectable so a test can fail one. */
export type SweepFs = {
  readdir(dir: string): Promise<Dirent[]>;
  /** Up to `max` entry names from `dir`, without listing all of it. */
  sampleNames(dir: string, max: number): Promise<string[]>;
  lstat(target: string): Promise<SweepStats>;
  rename(from: string, to: string): Promise<void>;
  rm(target: string): Promise<void>;
};

export const nodeSweepFs: SweepFs = {
  readdir: (dir) => readdir(dir, { withFileTypes: true }),
  async sampleNames(dir, max) {
    const names: string[] = [];
    const handle = await opendir(dir);
    try {
      for (let entry = await handle.read(); entry; entry = await handle.read()) {
        names.push(entry.name);
        if (names.length >= max) break;
      }
    } finally {
      await handle.close();
    }
    return names;
  },
  lstat: (target) => lstat(target),
  rename: (from, to) => rename(from, to),
  rm: (target) => rm(target, { recursive: true, force: true }),
};

/** The current user's uid off Windows; `null` (no ownership check) on Windows. */
export function currentUid(): number | null {
  if (process.platform === "win32" || typeof process.getuid !== "function") {
    return null;
  }
  return process.getuid();
}

export type SweepOptions = {
  /** The directory whose direct children are candidates: `os.tmpdir()`. */
  tempRoot: string;
  /** Folders older than this many milliseconds are removed. */
  maxAgeMs: number;
  /** Milliseconds since the epoch, read once per sweep. */
  now: () => number;
  /** Absolute paths that are never removed: the current run's own folders. */
  keep?: Iterable<unknown>;
  /** Stop after this many attempts. Defaults to `MAX_ATTEMPTS_PER_RUN`. */
  maxAttempts?: number;
  /** Required owner of every folder touched; `null` skips the check. */
  uid?: number | null;
  fs?: SweepFs;
};

export type SweepReport = {
  removed: string[];
  failed: Array<{ path: string; error: unknown }>;
};

function samePath(a: string, b: string): boolean {
  const left = path.resolve(a);
  const right = path.resolve(b);
  return process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

/** `target`'s stats when it is a real, suitably owned directory, else `null`. */
async function realDirectory(
  fs: SweepFs,
  target: string,
  uid: number | null,
): Promise<SweepStats | null> {
  try {
    const stats = await fs.lstat(target);
    if (stats.isSymbolicLink() || !stats.isDirectory()) return null;
    if (uid !== null && stats.uid !== uid) return null;
    return stats;
  } catch {
    return null;
  }
}

/**
 * The newest modification time across a candidate folder and its marker
 * children, or `null` when the folder does not have exactly Vitest's shape.
 */
async function vitestFolderMtime(
  fs: SweepFs,
  dir: string,
  uid: number | null,
): Promise<number | null> {
  const own = await realDirectory(fs, dir, uid);
  if (own === null) return null;
  let children: Dirent[];
  try {
    children = await fs.readdir(dir);
  } catch {
    return null;
  }
  if (children.length === 0) return null;

  let newest = own.mtimeMs;
  for (const child of children) {
    if (!MARKER_DIRS.includes(child.name)) return null;
    const markerDir = path.join(dir, child.name);
    const stats = await realDirectory(fs, markerDir, uid);
    if (stats === null) return null;
    newest = Math.max(newest, stats.mtimeMs);
    try {
      const sample = await fs.sampleNames(markerDir, MARKER_ENTRIES_SAMPLED);
      if (!sample.every((name) => MARKER_ENTRY_NAME.test(name))) return null;
    } catch {
      return null;
    }
  }
  return newest;
}

/**
 * Removes stale Vitest scratch folders, and this module's own unfinished trash,
 * from `tempRoot`. Resolves with what it removed and what it failed to remove;
 * never rejects.
 */
export async function sweepStaleVitestTempDirs(
  options: SweepOptions,
): Promise<SweepReport> {
  const fs = options.fs ?? nodeSweepFs;
  const uid = options.uid === undefined ? currentUid() : options.uid;
  const keep = [...(options.keep ?? [])].filter(
    (dir): dir is string => typeof dir === "string",
  );
  const maxAttempts = options.maxAttempts ?? MAX_ATTEMPTS_PER_RUN;
  const report: SweepReport = { removed: [], failed: [] };
  const attempts = () => report.removed.length + report.failed.length;

  let entries: Dirent[];
  try {
    entries = await fs.readdir(options.tempRoot);
  } catch (error) {
    report.failed.push({ path: options.tempRoot, error });
    return report;
  }

  // Unfinished trash first: only this module creates the name, so no age check.
  // A Dirent for a symlink or junction reports `isDirectory() === false`, so a
  // link is rejected here without ever being resolved, and again by `lstat`.
  for (const entry of entries) {
    if (attempts() >= maxAttempts) return report;
    if (!entry.isDirectory() || !VITEST_TRASH_DIR_NAME.test(entry.name)) continue;
    const trash = path.join(options.tempRoot, entry.name);
    if ((await realDirectory(fs, trash, uid)) === null) continue;
    try {
      await fs.rm(trash);
      report.removed.push(trash);
    } catch (error) {
      report.failed.push({ path: trash, error });
    }
  }

  const now = options.now();
  for (const entry of entries) {
    if (attempts() >= maxAttempts) break;
    if (!entry.isDirectory() || !VITEST_TEMP_DIR_NAME.test(entry.name)) continue;
    const dir = path.join(options.tempRoot, entry.name);
    if (keep.some((own) => samePath(own, dir))) continue;

    const newest = await vitestFolderMtime(fs, dir, uid);
    if (newest === null || now - newest <= options.maxAgeMs) continue;

    const trash = dir + TRASH_SUFFIX;
    try {
      await fs.rename(dir, trash);
    } catch (error) {
      // Claimed by a concurrent sweep, or held open: leave it for a later run.
      report.failed.push({ path: dir, error });
      continue;
    }
    try {
      await fs.rm(trash);
      report.removed.push(dir);
    } catch (error) {
      report.failed.push({ path: trash, error });
    }
  }
  return report;
}

/**
 * Sets each folder's modification time to `now`, so a long-lived run's own
 * folders never look stale to a sweep started by another run. A folder that
 * does not exist yet (Vitest creates it lazily) is skipped. Never rejects.
 */
export async function touchVitestTempDirs(
  dirs: Iterable<string>,
  now: () => number,
): Promise<void> {
  const seconds = now() / 1000;
  for (const dir of dirs) {
    try {
      await utimes(dir, seconds, seconds);
    } catch {
      // Not created yet, or already gone: nothing to keep alive.
    }
  }
}

/** Starts the heartbeat; the returned function stops it. */
export function startHeartbeat(
  dirs: readonly string[],
  now: () => number,
  intervalMs: number = HEARTBEAT_INTERVAL_MS,
): () => void {
  const timer = setInterval(() => {
    void touchVitestTempDirs(dirs, now);
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

/** The parts of Vitest's `TestProject` this module reads, all optional. */
export type TempDirSource = {
  tmpDir?: unknown;
  vitest?: { projects?: unknown; _tmpDir?: unknown };
};

/**
 * Every scratch folder the current run owns: each project's `tmpDir`, plus the
 * instance's own `_tmpDir`. `_tmpDir` is marked internal by Vitest, so it is
 * read defensively. If it disappears, `warn` says so once, because that folder
 * is then protected only by its age and the heartbeat. Never throws.
 */
export function ownTempDirs(
  project: TempDirSource,
  warn: (message: string) => void = console.warn,
): string[] {
  const dirs = new Set<string>();
  const add = (dir: unknown) => {
    if (typeof dir === "string" && dir.length > 0) dirs.add(dir);
  };
  add(project?.tmpDir);
  const projects = project?.vitest?.projects;
  if (projects && typeof (projects as Iterable<unknown>)[Symbol.iterator] === "function") {
    for (const other of projects as Iterable<{ tmpDir?: unknown } | null>) {
      add(other?.tmpDir);
    }
  }
  const instanceDir = project?.vitest?._tmpDir;
  if (typeof instanceDir === "string" && instanceDir.length > 0) {
    dirs.add(instanceDir);
  } else {
    warn(
      "[vitest-temp-sweep] Vitest no longer exposes `_tmpDir`; this run's root scratch folder is protected only by its age and the heartbeat (#3671).",
    );
  }
  return [...dirs];
}

/** What the child process reads from `SWEEP_OPTIONS_ENV`. */
type ChildOptions = { tempRoot: string; maxAgeMs: number; keep: string[] };

type SpawnFn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

/** This file, which is also the child's entry point. */
export const SWEEP_SCRIPT = fileURLToPath(import.meta.url);

/**
 * Starts a sweep in a detached, low-priority child process that the run does
 * not wait for. Returns the child, or `null` if it could not be started.
 * Never throws.
 */
export function launchSweep(
  options: ChildOptions,
  spawnFn: SpawnFn = spawn,
): ChildProcess | null {
  try {
    const child = spawnFn(process.execPath, ["--no-warnings", SWEEP_SCRIPT], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: { ...process.env, [SWEEP_OPTIONS_ENV]: JSON.stringify(options) },
    });
    child.on("error", () => {});
    child.unref();
    if (typeof child.pid === "number") {
      try {
        setPriority(child.pid, osConstants.priority.PRIORITY_LOW);
      } catch {
        // Lowering priority is a courtesy, not a requirement.
      }
    }
    return child;
  } catch {
    return null;
  }
}

export type SetupDeps = {
  env?: Env;
  tempRoot?: string;
  now?: () => number;
  warn?: (message: string) => void;
  launch?: (options: ChildOptions) => unknown;
  heartbeat?: (dirs: readonly string[], now: () => number) => () => void;
};

/**
 * The body of `vitest.global-setup.ts`: launches the sweep and starts the
 * heartbeat, and returns the teardown that stops the heartbeat. It does not
 * wait for the child. Never throws. On any failure it warns once and returns a
 * no-op teardown.
 */
export function setupVitestTempSweep(
  project: TempDirSource,
  deps: SetupDeps = {},
): () => void {
  const warn = deps.warn ?? console.warn;
  try {
    const env = deps.env ?? process.env;
    if (env.FAKETIME) {
      // The clock-rollover canary runs under libfaketime. Every folder would
      // look stale, and heartbeat mtimes would be written in the faked future.
      warn("[vitest-temp-sweep] FAKETIME is set; skipping the temp sweep (#3671).");
      return () => {};
    }
    const now = deps.now ?? (() => Date.now());
    const keep = ownTempDirs(project, warn);
    const launch = deps.launch ?? ((options: ChildOptions) => launchSweep(options));
    launch({
      tempRoot: deps.tempRoot ?? tmpdir(),
      maxAgeMs: STALE_AFTER_MS,
      keep,
    });
    const stop = (deps.heartbeat ?? startHeartbeat)(keep, now);
    return () => {
      try {
        stop();
      } catch {
        // Nothing to clean up that could matter to the run.
      }
    };
  } catch (error) {
    warn(`[vitest-temp-sweep] temp sweep not started (#3671): ${String(error)}`);
    return () => {};
  }
}

/** The child's work: read its options, sweep once, exit. Never rejects. */
export async function runSweepFromEnv(
  env: Env = process.env,
): Promise<SweepReport | null> {
  try {
    const raw = env[SWEEP_OPTIONS_ENV];
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ChildOptions>;
    if (typeof parsed.tempRoot !== "string" || typeof parsed.maxAgeMs !== "number") {
      return null;
    }
    return await sweepStaleVitestTempDirs({
      tempRoot: parsed.tempRoot,
      maxAgeMs: parsed.maxAgeMs,
      keep: Array.isArray(parsed.keep) ? parsed.keep : [],
      now: () => Date.now(),
    });
  } catch {
    return null;
  }
}

const entry = process.argv[1];
if (entry && pathToFileURL(path.resolve(entry)).href === import.meta.url) {
  void runSweepFromEnv();
}
