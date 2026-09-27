/**
 * Sweeps the scratch folders Vitest leaks into the system temp directory
 * (#3671).
 *
 * Vitest 5 gives every run, and every project in it, a folder at
 * `os.tmpdir()/<21-character nanoid>`, and the module runner writes one file per
 * transformed module into it, under a sub-folder named for the Vite environment
 * (`ssr/`, and `client/` for jsdom suites). Vitest deletes the folder only in
 * `close()`, and swallows any failure there with an empty `catch {}` — so a run
 * that is killed, times out or is interrupted, or one where Windows refuses the
 * delete because a worker still holds a file open, leaves 100–160 MB behind that
 * nothing ever removes. Under agent load that was about 14 GB a day.
 *
 * `vitest.global-setup.ts` calls `startVitestTempSweep` once per run, so each
 * run clears what earlier runs leaked. The guard is the whole design: a folder
 * is removed only when EVERY one of these holds.
 *
 * - It is a direct child of the temp root. Nothing is ever searched for.
 * - Its name is exactly a 21-character nanoid (`VITEST_TEMP_DIR_NAME`).
 * - It is a real directory, not a symlink or a Windows junction, and so is its
 *   `ssr/` sub-folder. A link is never followed, so the sweep cannot reach
 *   anything outside the temp root through one.
 * - It contains an `ssr/` directory — the shape the issue measured on every
 *   leaked folder.
 * - The newest modification time of the folder and of its environment
 *   sub-folders is older than the threshold (`STALE_AFTER_MS`, two hours). A
 *   run adding a module adds a file to `ssr/` and so moves that sub-folder's
 *   time forward, and the heartbeat below keeps an idle long-lived run (watch
 *   mode) fresh too, so a folder in use is never old enough to match.
 * - It is not one of the current run's own folders (`keep`).
 *
 * The cost at startup is one directory listing of the temp root and at most
 * three `lstat` calls per nanoid-named folder — there is no recursive walk of
 * anything until a folder has already passed every guard and is being removed.
 *
 * Nothing here throws. A folder that cannot be read or removed is recorded and
 * skipped, and the rest are still processed: disposable cache housekeeping must
 * never fail, slow down or reorder a test run.
 */
import type { Dirent } from "node:fs";
import { lstat, readdir, rm, utimes } from "node:fs/promises";
import path from "node:path";

/** Vitest's folder name: `nanoid()` — 21 characters of `A-Za-z0-9_-`. */
export const VITEST_TEMP_DIR_NAME = /^[A-Za-z0-9_-]{21}$/;

/** The sub-folder that marks a folder as Vitest's module-runner cache. */
export const REQUIRED_ENVIRONMENT_DIR = "ssr";

/**
 * Every Vite environment sub-folder Vitest writes, all of which count towards a
 * folder's age. Only `REQUIRED_ENVIRONMENT_DIR` makes a folder eligible.
 */
const ENVIRONMENT_DIRS = [REQUIRED_ENVIRONMENT_DIR, "client"] as const;

/** A folder untouched for longer than this is treated as leaked. */
export const STALE_AFTER_MS = 2 * 60 * 60 * 1000;

/**
 * How many folders one run removes at most. Each run leaks at most a couple, so
 * any cap above that still converges; the cap bounds the disk work a single run
 * does while a large backlog drains (roughly a thousand folders on the machine
 * that found this).
 */
export const MAX_REMOVALS_PER_RUN = 10;

/** How often a live run refreshes its own folders' modification time. */
export const HEARTBEAT_INTERVAL_MS = 10 * 60 * 1000;

/** The file-system calls the sweep makes, injectable so a test can fail one. */
export type SweepFs = {
  readdir(dir: string): Promise<Dirent[]>;
  lstat(
    target: string,
  ): Promise<{ isDirectory(): boolean; isSymbolicLink(): boolean; mtimeMs: number }>;
  rm(target: string): Promise<void>;
};

export const nodeSweepFs: SweepFs = {
  readdir: (dir) => readdir(dir, { withFileTypes: true }),
  lstat: (target) => lstat(target),
  rm: (target) => rm(target, { recursive: true, force: true }),
};

export type SweepOptions = {
  /** The directory whose direct children are candidates: `os.tmpdir()`. */
  tempRoot: string;
  /** Folders older than this many milliseconds are removed. */
  maxAgeMs: number;
  /** Milliseconds since the epoch, read once per sweep. */
  now: () => number;
  /** Absolute paths that are never removed: the current run's own folders. */
  keep?: Iterable<string>;
  /** Stop after this many removals. Defaults to `MAX_REMOVALS_PER_RUN`. */
  maxRemovals?: number;
  /** Checked before each removal; once aborted, nothing further is removed. */
  signal?: AbortSignal;
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

/** A real (non-link) directory's modification time, or `null` if it is not one. */
async function directoryMtime(fs: SweepFs, target: string): Promise<number | null> {
  try {
    const stats = await fs.lstat(target);
    if (stats.isSymbolicLink() || !stats.isDirectory()) return null;
    return stats.mtimeMs;
  } catch {
    return null;
  }
}

/**
 * The newest modification time across a candidate folder and its environment
 * sub-folders, or `null` when the folder does not have Vitest's shape.
 */
async function newestVitestMtime(fs: SweepFs, dir: string): Promise<number | null> {
  const own = await directoryMtime(fs, dir);
  if (own === null) return null;
  let newest = own;
  for (const name of ENVIRONMENT_DIRS) {
    const mtime = await directoryMtime(fs, path.join(dir, name));
    if (mtime === null) {
      if (name === REQUIRED_ENVIRONMENT_DIR) return null;
      continue;
    }
    newest = Math.max(newest, mtime);
  }
  return newest;
}

/**
 * Removes stale Vitest scratch folders from `tempRoot`. Resolves with what it
 * removed and what it failed to; never rejects.
 */
export async function sweepStaleVitestTempDirs(
  options: SweepOptions,
): Promise<SweepReport> {
  const fs = options.fs ?? nodeSweepFs;
  const keep = [...(options.keep ?? [])];
  const maxRemovals = options.maxRemovals ?? MAX_REMOVALS_PER_RUN;
  const report: SweepReport = { removed: [], failed: [] };

  let entries: Dirent[];
  try {
    entries = await fs.readdir(options.tempRoot);
  } catch (error) {
    report.failed.push({ path: options.tempRoot, error });
    return report;
  }

  const now = options.now();
  for (const entry of entries) {
    if (report.removed.length >= maxRemovals || options.signal?.aborted) break;
    // A Dirent for a symlink or junction reports `isDirectory() === false`, so
    // a link is rejected here without ever being resolved.
    if (!entry.isDirectory() || !VITEST_TEMP_DIR_NAME.test(entry.name)) continue;
    const dir = path.join(options.tempRoot, entry.name);
    if (keep.some((own) => samePath(own, dir))) continue;

    const newest = await newestVitestMtime(fs, dir);
    if (newest === null || now - newest <= options.maxAgeMs) continue;
    if (options.signal?.aborted) break;

    try {
      await fs.rm(dir);
      report.removed.push(dir);
    } catch (error) {
      report.failed.push({ path: dir, error });
    }
  }
  return report;
}

/**
 * Sets each folder's modification time to `now`, so a long-lived run's own
 * folders never look stale to a sweep started by another run. A folder that does
 * not exist yet (Vitest creates it lazily) is skipped. Never rejects.
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

export type TempSweepHandle = {
  /** Resolves with the report when the sweep finishes on its own. */
  done: Promise<SweepReport>;
  /** Stops the heartbeat and any further removals, then waits for the sweep. */
  stop(): Promise<SweepReport>;
};

/**
 * Starts a sweep in the background (tests begin at once rather than waiting
 * for folders to be deleted) and a heartbeat that keeps `keep` fresh. `stop()`
 * belongs in the global teardown: it lets the folder being removed finish,
 * removes no more, and so never holds the process open past the run.
 */
export function startVitestTempSweep(
  options: SweepOptions & { heartbeatMs?: number },
): TempSweepHandle {
  const controller = new AbortController();
  const keep = [...(options.keep ?? [])];
  const sweep = sweepStaleVitestTempDirs({
    ...options,
    keep,
    signal: controller.signal,
  }).catch((error: unknown): SweepReport => ({
    removed: [],
    failed: [{ path: options.tempRoot, error }],
  }));
  const heartbeat = setInterval(() => {
    void touchVitestTempDirs(keep, options.now);
  }, options.heartbeatMs ?? HEARTBEAT_INTERVAL_MS);
  heartbeat.unref();

  return {
    done: sweep,
    async stop() {
      clearInterval(heartbeat);
      controller.abort();
      return sweep;
    },
  };
}
