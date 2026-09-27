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
 *   including clean, green runs (vitest-dev/vitest#11224; fix in review as
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
 *   `client`), and each one is a real directory under the same ownership rule.
 *   Any other child, or a marker name that is a file or a link, disqualifies
 *   the folder.
 * - The newest modification time of the folder and of its marker children is
 *   older than `STALE_AFTER_MS` (24 hours). Adding a module adds a file to a
 *   marker directory, which moves that directory's time forward. The heartbeat
 *   below keeps an idle run's own folders fresh as well.
 * - It is not one of the current run's own folders (`keep`).
 * - Checked last, and only for a folder that is already old enough: EVERY
 *   entry in each marker directory is a regular file whose whole name is a
 *   40-hex SHA-1 (a module) or starts `.tmp-` (Vitest's atomic writer). One
 *   file of anyone else's disqualifies the folder.
 *
 * A folder that qualifies is first renamed, in the same parent, to
 * `<name>.vitest-sweep-trash`, and only the renamed path is deleted. That way
 * a Vitest process still writing to the old path cannot write into a folder
 * being deleted, and a delete that is cut short leaves a trash folder that no
 * longer looks like Vitest's. The next sweep removes those trash folders first,
 * with the same link and ownership checks but no age check, because only this
 * module creates that name.
 *
 * ## Concurrency
 *
 * One sweeper at a time per temp root and user: a sweep first creates the
 * lock file (`lockFileName`) exclusively, recording its pid, and a sweep that
 * finds a live, recent lock skips. A lock is taken over only when its pid is
 * dead or the lock is older than `LOCK_STALE_MS`.
 *
 * The lock is an optimisation, never a gate. Only `EEXIST` on the exclusive
 * create means "held". Any other failure means the sweep runs without the lock
 * rather than skipping forever: a full disk or read-only temp root that cannot
 * create or write it, a stale lock that cannot be removed, or something that
 * is not a file at the lock path. An empty lock this sweep created but could
 * not write is removed again. Running unlocked, like a non-atomic takeover
 * where two sweepers find the same stale lock at once, costs duplicate
 * `EPERM`/`ENOENT` noise, not data: each candidate is still claimed by an
 * atomic `rename`, and only one sweeper can win it.
 *
 * Both passes visit entries in a shuffled order. A handful of folders that
 * always fail, such as ones Windows holds open, therefore cannot sit at the
 * front of the directory listing and use up the attempt cap on every run.
 *
 * ## What is and is not guaranteed
 *
 * The checks never follow a link, and nothing outside the temp root is ever
 * chosen as a target. Node's recursive `rm` is not atomic, though. A process
 * that can write inside a candidate folder while it is being deleted could swap
 * a sub-folder for a junction between Node's check and its descent. On Windows,
 * `%TEMP%` is per-user, so that process would already have to be running as
 * you. Off Windows, the ownership check keeps the sweep off folders another user
 * owns in a shared `/tmp`.
 *
 * ## Cost
 *
 * The sweep runs in a detached child process at below-normal priority
 * (`launchSweep`). Its working directory is the temp root, so it never holds a
 * worktree open, and its environment is built from an allowlist, so an
 * inherited `NODE_OPTIONS` such as `--inspect-brk` cannot hang it. The test run
 * neither waits for it nor shares its I/O thread pool, and the child outlives a
 * short run, so even many short `vitest related` runs make progress. Each sweep
 * makes at most `MAX_ATTEMPTS_PER_RUN` removal attempts, failures included. The
 * only in-process work is the heartbeat: one `utimes` per own folder every ten
 * minutes.
 *
 * Nothing here throws into Vitest. Every failure is recorded or swallowed,
 * because disposable-cache housekeeping must never fail or slow a test run.
 *
 * This file is also the child's entry point:
 * `node scripts/lib/vitest-temp-sweep.ts --vitest-temp-sweep-child`. It runs
 * through Node 24's built-in type stripping, so it imports only Node built-ins
 * and uses only erasable TypeScript syntax.
 */
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import type { Dirent } from "node:fs";
import {
  lstat,
  open,
  readdir,
  readFile,
  rename,
  rm,
  unlink,
  utimes,
} from "node:fs/promises";
import { constants as osConstants, setPriority, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Vitest's folder name: `nanoid()` — 21 characters of `A-Za-z0-9_-`. */
export const VITEST_TEMP_DIR_NAME = /^[A-Za-z0-9_-]{21}$/;

/** The suffix a claimed folder is renamed to before it is deleted. */
export const TRASH_SUFFIX = ".vitest-sweep-trash";

/** A folder this module claimed but did not finish deleting. */
export const VITEST_TRASH_DIR_NAME = /^[A-Za-z0-9_-]{21}\.vitest-sweep-trash$/;

/** The Vite environment sub-folders Vitest writes; the only children allowed. */
export const MARKER_DIRS: readonly string[] = ["ssr", "client"];

/** A whole module-file name (`<sha1>`), or Vitest's atomic-write temp file. */
export const MARKER_ENTRY_NAME = /^(?:[0-9a-f]{40}|\.tmp-.*)$/;

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

/** The longest teardown waits for a heartbeat tick already in flight. */
export const HEARTBEAT_STOP_WAIT_MS = 5000;

/**
 * The single-sweeper lock, a direct child of the temp root. Off Windows the
 * name carries the uid, because `/tmp` is shared: another user's lock must not
 * be able to block this user's sweep, and cannot be removed anyway (sticky bit).
 */
export function lockFileName(uid: number | null): string {
  return uid === null ? "vitest-temp-sweep.lock" : `vitest-temp-sweep-${uid}.lock`;
}

/** A lock older than this is abandoned whatever its pid says. */
export const LOCK_STALE_MS = 60 * 60 * 1000;

/** An environment: `process.env`, or a plain object in a test. */
export type Env = Readonly<Record<string, string | undefined>>;

/** The environment variable that carries the child's options. */
export const SWEEP_OPTIONS_ENV = "VITEST_TEMP_SWEEP_OPTIONS";

/** The argument that makes this file run a sweep when Node executes it. */
export const CHILD_FLAG = "--vitest-temp-sweep-child";

/**
 * The only variables the child inherits, compared case-insensitively. It needs
 * a working Node (the path and the Windows system root) and nothing else, so
 * `NODE_OPTIONS`, inspector variables and every secret in the parent's
 * environment stay behind.
 */
const CHILD_ENV_ALLOWLIST = new Set([
  "PATH",
  "SYSTEMROOT",
  "WINDIR",
  "TEMP",
  "TMP",
  "TMPDIR",
  "HOME",
  "USERPROFILE",
  "LOCALAPPDATA",
  "APPDATA",
]);

export type SweepStats = {
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
  mtimeMs: number;
  uid: number;
};

/** The file-system calls the sweep makes, injectable so a test can fail one. */
export type SweepFs = {
  readdir(dir: string): Promise<Dirent[]>;
  lstat(target: string): Promise<SweepStats>;
  rename(from: string, to: string): Promise<void>;
  rm(target: string): Promise<void>;
  /**
   * Creates `target` exclusively (rejecting with `EEXIST` if anything is
   * there) and writes `content` through the SAME handle, so it can never
   * overwrite a file another process created at that path. Rejects only when
   * the create itself fails. Resolves `unwritten` when the file was created
   * but the write failed (ENOSPC/EDQUOT), so the caller knows the empty file
   * is its own.
   */
  createExclusive(target: string, content: string): Promise<"written" | "unwritten">;
  readText(target: string): Promise<string>;
  unlink(target: string): Promise<void>;
};

export const nodeSweepFs: SweepFs = {
  readdir: (dir) => readdir(dir, { withFileTypes: true }),
  lstat: (target) => lstat(target),
  rename: (from, to) => rename(from, to),
  rm: (target) => rm(target, { recursive: true, force: true }),
  createExclusive: async (target, content) => {
    const handle = await open(target, "wx");
    try {
      await handle.writeFile(content, "utf8");
      return "written";
    } catch {
      return "unwritten";
    } finally {
      await handle.close().catch(() => {});
    }
  },
  readText: (target) => readFile(target, "utf8"),
  unlink: (target) => unlink(target),
};

/** The current user's uid off Windows; `null` (no ownership check) on Windows. */
export function currentUid(): number | null {
  if (process.platform === "win32" || typeof process.getuid !== "function") {
    return null;
  }
  return process.getuid();
}

/** Whether a process with this pid exists. `EPERM` means it does. */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
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
  /** Uniform in [0, 1); orders the visit. Defaults to `Math.random`. */
  random?: () => number;
  /** Whether a lock holder's pid is alive. Defaults to `isProcessAlive`. */
  isAlive?: (pid: number) => boolean;
  fs?: SweepFs;
};

export type SweepReport = {
  removed: string[];
  failed: Array<{ path: string; error: unknown }>;
  /** True when another sweeper held the lock, so nothing was attempted. */
  skipped: boolean;
  /**
   * True when this sweep held the lock. False when it skipped, or swept without
   * the lock because the lock could not be used (a full disk, a read-only temp
   * root, an unremovable or non-file lock).
   */
  locked: boolean;
};

function samePath(a: string, b: string): boolean {
  const left = path.resolve(a);
  const right = path.resolve(b);
  return process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

/** A Fisher–Yates shuffle into a new array. */
function shuffled<T>(items: readonly T[], random: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    const held = out[i] as T;
    out[i] = out[j] as T;
    out[j] = held;
  }
  return out;
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
 * The cheap shape-and-age check: the newest modification time of a candidate
 * and its marker children, and those children's paths. `null` when the folder
 * does not have Vitest's shape.
 */
async function vitestFolderShape(
  fs: SweepFs,
  dir: string,
  uid: number | null,
): Promise<{ newest: number; markers: string[] } | null> {
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
  const markers: string[] = [];
  for (const child of children) {
    if (!MARKER_DIRS.includes(child.name)) return null;
    const markerDir = path.join(dir, child.name);
    const stats = await realDirectory(fs, markerDir, uid);
    if (stats === null) return null;
    newest = Math.max(newest, stats.mtimeMs);
    markers.push(markerDir);
  }
  return { newest, markers };
}

/** Every entry of every marker directory is one of Vitest's files. */
async function holdsOnlyVitestFiles(
  fs: SweepFs,
  markers: readonly string[],
): Promise<boolean> {
  for (const marker of markers) {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(marker);
    } catch {
      return false;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !MARKER_ENTRY_NAME.test(entry.name)) return false;
    }
  }
  return true;
}

/**
 * What `acquireLock` decided. `held`: a live, recent sweeper has it, so skip.
 * `locked`: this sweep holds it. `unlocked`: the lock could not be used, so
 * sweep without it. `release` removes only a lock that is still this sweep's.
 */
type LockOutcome =
  | { state: "held" }
  | { state: "locked" | "unlocked"; release(): Promise<void> };

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | null)?.code;
}

/**
 * Takes the single-sweeper lock. Only `EEXIST` from the exclusive create
 * counts as the lock being held; every other failure (see the module docstring)
 * returns `unlocked` so the sweep still runs.
 */
async function acquireLock(
  fs: SweepFs,
  lockPath: string,
  now: number,
  isAlive: (pid: number) => boolean,
): Promise<LockOutcome> {
  const token = `${process.pid}:${now}:${Math.random().toString(36).slice(2)}`;
  // Set once this sweep has created a file at the lock path.
  let created = false;

  const release = async () => {
    if (!created) return;
    try {
      const content = await fs.readText(lockPath);
      // Ours: our token, or the empty file we created but could not write.
      if (content === "" || content.includes(token)) await fs.unlink(lockPath);
    } catch {
      // Already gone, or taken over: not ours to remove.
    }
  };
  const unlocked: LockOutcome = { state: "unlocked", release };

  /** `exists`, `locked`, or `unusable` (any other failure). */
  const tryCreate = async (): Promise<"exists" | "locked" | "unusable"> => {
    let written: "written" | "unwritten";
    try {
      written = await fs.createExclusive(
        lockPath,
        JSON.stringify({ pid: process.pid, token }),
      );
    } catch (error) {
      return errorCode(error) === "EEXIST" ? "exists" : "unusable";
    }
    created = true;
    // ENOSPC/EDQUOT after the create: the empty file is ours, and `release`
    // removes it.
    return written === "written" ? "locked" : "unusable";
  };

  const first = await tryCreate();
  if (first === "locked") return { state: "locked", release };
  if (first === "unusable") return unlocked;

  let abandoned: boolean;
  try {
    const stats = await fs.lstat(lockPath);
    // A directory or link at the lock path would block every sweep forever.
    if (!stats.isFile() || stats.isSymbolicLink()) return unlocked;
    let pid: unknown;
    try {
      pid = (JSON.parse(await fs.readText(lockPath)) as { pid?: unknown }).pid;
    } catch {
      pid = undefined; // Being written right now, or corrupt: judge by age.
    }
    abandoned =
      // Either direction: a lock dated in the future (the clock was wound
      // back) would otherwise never age out.
      Math.abs(now - stats.mtimeMs) > LOCK_STALE_MS ||
      (typeof pid === "number" && !isAlive(pid));
  } catch {
    return unlocked; // Released between our create and our read.
  }
  if (!abandoned) return { state: "held" };

  try {
    await fs.unlink(lockPath);
  } catch (error) {
    // Already gone is fine; anything else (EPERM, EBUSY) means the lock cannot
    // be cleared, and waiting would mean waiting forever.
    if (errorCode(error) !== "ENOENT") return unlocked;
  }
  const second = await tryCreate();
  if (second === "locked") return { state: "locked", release };
  // Another sweeper took it over first, which is exactly what the lock is for.
  if (second === "exists") return { state: "held" };
  return unlocked;
}

/**
 * Removes stale Vitest scratch folders, and this module's own unfinished trash,
 * from `tempRoot`. Resolves with what it removed and what it failed to remove;
 * never rejects.
 */
export async function sweepStaleVitestTempDirs(
  options: SweepOptions,
): Promise<SweepReport> {
  const report: SweepReport = {
    removed: [],
    failed: [],
    skipped: false,
    locked: false,
  };
  let lock: LockOutcome | null = null;
  try {
    const now = options.now();
    lock = await acquireLock(
      options.fs ?? nodeSweepFs,
      path.join(
        options.tempRoot,
        lockFileName(options.uid === undefined ? currentUid() : options.uid),
      ),
      now,
      options.isAlive ?? isProcessAlive,
    );
    report.locked = lock.state === "locked";
    if (lock.state === "held") {
      report.skipped = true;
      return report;
    }
    await sweepUnderLock(options, now, report);
  } catch (error) {
    report.failed.push({ path: options.tempRoot, error });
  } finally {
    if (lock && lock.state !== "held") await lock.release();
  }
  return report;
}

async function sweepUnderLock(
  options: SweepOptions,
  now: number,
  report: SweepReport,
): Promise<void> {
  const fs = options.fs ?? nodeSweepFs;
  const uid = options.uid === undefined ? currentUid() : options.uid;
  const keep = [...(options.keep ?? [])].filter(
    (dir): dir is string => typeof dir === "string",
  );
  const maxAttempts = options.maxAttempts ?? MAX_ATTEMPTS_PER_RUN;
  const attempts = () => report.removed.length + report.failed.length;

  let listed: Dirent[];
  try {
    listed = await fs.readdir(options.tempRoot);
  } catch (error) {
    report.failed.push({ path: options.tempRoot, error });
    return;
  }
  const entries = shuffled(listed, options.random ?? Math.random);

  // Unfinished trash first: only this module creates the name, so no age check.
  // A Dirent for a symlink or junction reports `isDirectory() === false`, so a
  // link is rejected here without ever being resolved, and again by `lstat`.
  for (const entry of entries) {
    if (attempts() >= maxAttempts) return;
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

  for (const entry of entries) {
    if (attempts() >= maxAttempts) return;
    if (!entry.isDirectory() || !VITEST_TEMP_DIR_NAME.test(entry.name)) continue;
    const dir = path.join(options.tempRoot, entry.name);
    if (keep.some((own) => samePath(own, dir))) continue;

    const shape = await vitestFolderShape(fs, dir, uid);
    if (shape === null || now - shape.newest <= options.maxAgeMs) continue;
    if (!(await holdsOnlyVitestFiles(fs, shape.markers))) continue;

    const trash = dir + TRASH_SUFFIX;
    try {
      await fs.rename(dir, trash);
    } catch (error) {
      // Claimed by another sweeper, or held open: leave it for a later run.
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

/**
 * Starts the heartbeat. The returned function stops it, and resolves once any
 * tick already in flight has finished, so no touch can land after it. That
 * wait is capped at `stopWaitMs`, so a hung `utimes` cannot hold teardown.
 */
export function startHeartbeat(
  dirs: readonly string[],
  now: () => number,
  intervalMs: number = HEARTBEAT_INTERVAL_MS,
  touch: typeof touchVitestTempDirs = touchVitestTempDirs,
  stopWaitMs: number = HEARTBEAT_STOP_WAIT_MS,
): () => Promise<void> {
  let inFlight: Promise<void> | null = null;
  const timer = setInterval(() => {
    if (inFlight) return;
    inFlight = touch(dirs, now).finally(() => {
      inFlight = null;
    });
  }, intervalMs);
  timer.unref();
  return async () => {
    clearInterval(timer);
    if (!inFlight) return;
    let cap: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      inFlight,
      new Promise<void>((resolve) => {
        cap = setTimeout(resolve, stopWaitMs);
        cap.unref();
      }),
    ]);
    clearTimeout(cap);
  };
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
export type ChildOptions = { tempRoot: string; maxAgeMs: number; keep: string[] };

type SpawnFn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

/** This file, which is also the child's entry point. */
export const SWEEP_SCRIPT = fileURLToPath(import.meta.url);

/**
 * The child's environment: the allowlisted variables, plus its options. It
 * starts from a copy of `source` and deletes the rest, which keeps the result a
 * `NodeJS.ProcessEnv` for `spawn` without a cast.
 */
export function buildChildEnv(
  source: NodeJS.ProcessEnv,
  options: ChildOptions,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...source };
  for (const key of Object.keys(env)) {
    if (env[key] === undefined || !CHILD_ENV_ALLOWLIST.has(key.toUpperCase())) {
      delete env[key];
    }
  }
  env[SWEEP_OPTIONS_ENV] = JSON.stringify(options);
  return env;
}

/**
 * Starts a sweep in a detached, below-normal-priority child process that the
 * run does not wait for. Returns the child, or `null` if it could not be
 * started. Never throws.
 */
export function launchSweep(
  options: ChildOptions,
  spawnFn: SpawnFn = spawn,
  script: string = SWEEP_SCRIPT,
): ChildProcess | null {
  try {
    const child = spawnFn(process.execPath, ["--no-warnings", script, CHILD_FLAG], {
      cwd: options.tempRoot,
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: buildChildEnv(process.env, options),
    });
    child.on("error", () => {});
    child.unref();
    if (typeof child.pid === "number") {
      try {
        setPriority(child.pid, osConstants.priority.PRIORITY_BELOW_NORMAL);
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
  heartbeat?: (dirs: readonly string[], now: () => number) => () => Promise<void>;
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
): () => Promise<void> {
  const warn = deps.warn ?? console.warn;
  try {
    const env = deps.env ?? process.env;
    if (env.FAKETIME) {
      // The clock-rollover canary runs under libfaketime. Every folder would
      // look stale, and heartbeat mtimes would be written in the faked future.
      warn("[vitest-temp-sweep] FAKETIME is set; skipping the temp sweep (#3671).");
      return async () => {};
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
    return async () => {
      try {
        await stop();
      } catch {
        // Nothing to clean up that could matter to the run.
      }
    };
  } catch (error) {
    warn(`[vitest-temp-sweep] temp sweep not started (#3671): ${String(error)}`);
    return async () => {};
  }
}

/** The child's work: read its options, sweep once. Never rejects. */
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

/**
 * Whether this process was started as the sweep child. An explicit flag rather
 * than comparing `argv[1]` with `import.meta.url`: Node resolves the main
 * module through links, so launching via a junction or symlink would make that
 * comparison fail and the child would silently do nothing.
 */
export function isSweepChild(argv: readonly string[] = process.argv): boolean {
  return argv.slice(2).includes(CHILD_FLAG);
}

if (isSweepChild()) {
  void runSweepFromEnv();
}
