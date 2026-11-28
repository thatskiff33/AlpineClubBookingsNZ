import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readdir, readFile, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";

import type { Prisma } from "@prisma/client";

import { markAlertOwed } from "@/lib/alert-cooldown";
import logger from "@/lib/logger";

/**
 * #5297 (`INV-INT-045`): THE OWED-ALERT SPOOL. An alert raised while the
 * database refuses every write (an outage, a full disk, a failover) cannot
 * store its owed row (`markAlertOwed`), so the sweep that re-sends it would
 * have nothing to find. The row it would have written is kept on local disk
 * instead, and the once-ever alert sweep moves it into the database once the
 * database answers (`ingestSpooledAlerts`). The spool never sends anything:
 * the owed row's own sweep or drain makes the one send, through the alert's
 * once-ever claim, exactly as if the row had been written at the time.
 *
 * - One file per owed key, written to a temporary file, synced and renamed
 *   over: a repeat of the same alert overwrites it, never adds a second.
 * - A file holds exactly what the owed row would (its `replayAlert`: ids,
 *   cents, the error text), mode 0600 in a 0700 directory, outside anything
 *   web-served; it is deleted once its row is written.
 * - At most `ADMIN_ALERT_SPOOL_MAX_FILES` files: past that a new alert is only
 *   logged, as before #5297.
 */

/** An owed row, as `markAlertOwed` writes it (its `now` is the stamp the row records). */
type OwedAlert = Omit<Parameters<typeof markAlertOwed>[0], "store">;

/** What a spool file holds: the owed row's fields, and when it was spooled. */
type SpooledOwedAlert = {
  v: 1;
  key: string;
  due: OwedAlert["due"];
  retryAfterMs: number;
  replayAlert?: Prisma.InputJsonValue;
  spooledAt: string;
};

export const ADMIN_ALERT_SPOOL_MAX_FILES = 500;

/** A temporary file older than this was left by a write that never finished. */
const ABANDONED_TEMP_MS = 60 * 60_000;
const TEMP_PREFIX = ".tmp-";
const SPOOL_SUFFIX = ".json";

/**
 * `ADMIN_ALERT_SPOOL_DIR`, or `.admin-alert-spool` under the working directory.
 * The Docker images mount a named volume there that every app container shares
 * and that outlives a restart or a blue/green swap (`docker-compose.yml`).
 */
export function adminAlertSpoolDir(): string {
  const configured = process.env.ADMIN_ALERT_SPOOL_DIR?.trim();
  return path.resolve(configured || path.join(process.cwd(), ".admin-alert-spool"));
}

/**
 * Write the owed row, or keep it on disk when the database refuses it.
 * Rethrows the database's error only when the disk refuses it too. A spooled
 * row is logged as an error naming `label`, with `context`.
 */
export async function markAlertOwedOrSpool(
  owed: OwedAlert,
  { label, context }: { label: string; context: Record<string, unknown> },
): Promise<"stored" | "spooled"> {
  const now = owed.now ?? new Date();
  try {
    await markAlertOwed({ ...owed, now });
    return "stored";
  } catch (err) {
    if (!(await spoolOwedAlert({ ...owed, now }))) throw err;
    logger.error(
      { ...context, err, key: owed.key },
      `Failed to store the ${label} in the database; kept it on disk until the once-ever alert sweep can (#5297)`,
    );
    return "spooled";
  }
}

/** Keep an owed row on disk. Never throws; returns whether the file was written. */
async function spoolOwedAlert(owed: OwedAlert & { now: Date }): Promise<boolean> {
  const dir = adminAlertSpoolDir();
  const file = path.join(dir, spoolFileName(owed.key));
  const temp = path.join(dir, `${TEMP_PREFIX}${randomUUID()}`);
  const record: SpooledOwedAlert = {
    v: 1,
    key: owed.key,
    due: owed.due,
    retryAfterMs: owed.retryAfterMs,
    ...(owed.replayAlert === undefined ? {} : { replayAlert: owed.replayAlert }),
    spooledAt: owed.now.toISOString(),
  };
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    if (!(await exists(file)) && (await spooledFiles(dir)).length >= ADMIN_ALERT_SPOOL_MAX_FILES) {
      logger.error(
        { key: owed.key, dir, limit: ADMIN_ALERT_SPOOL_MAX_FILES },
        "The admin alert spool is full; this alert is not kept and the error log is its only record (#5297)",
      );
      return false;
    }
    const handle = await open(temp, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify(record));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temp, file);
    await syncDirectory(dir);
    return true;
  } catch (err) {
    logger.error({ err, key: owed.key, dir }, "Failed to keep an owed admin alert on disk (#5297)");
    await unlink(temp).catch(() => undefined);
    return false;
  }
}

/**
 * Move every spooled owed row into the database, then delete its file. The
 * write only creates and ignores a row already there, so a file read twice (a
 * crash before its delete, or two sweeps at once) writes one row. A file this
 * release cannot read is logged and deleted. Never throws; `failed` counts
 * what could not be read or written, left for the next run.
 */
export async function ingestSpooledAlerts(now: Date = new Date()): Promise<{ ingested: number; failed: number }> {
  const result = { ingested: 0, failed: 0 };
  const dir = adminAlertSpoolDir();
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (err) {
    if (isMissing(err)) return result;
    result.failed += 1;
    logger.error({ err, dir }, "Failed to read the admin alert spool");
    return result;
  }
  for (const name of names.sort()) {
    const file = path.join(dir, name);
    if (name.startsWith(TEMP_PREFIX)) await removeAbandonedTemp(file, now);
    else if (name.endsWith(SPOOL_SUFFIX)) await ingestFile(file, result);
  }
  return result;
}

async function ingestFile(file: string, result: { ingested: number; failed: number }): Promise<void> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (err) {
    if (isMissing(err)) return;
    result.failed += 1;
    logger.error({ err, file }, "Failed to read a spooled admin alert");
    return;
  }
  const record = parseSpooledOwedAlert(text);
  if (!record) {
    logger.error({ file }, "Dropped a spooled admin alert this release cannot read; the error log is its only record (#5297)");
    await removeSpoolFile(file, result);
    return;
  }
  try {
    await markAlertOwed({
      key: record.key,
      due: record.due,
      retryAfterMs: record.retryAfterMs,
      ...(record.replayAlert === undefined ? {} : { replayAlert: record.replayAlert }),
      now: new Date(record.spooledAt),
    });
  } catch (err) {
    result.failed += 1;
    logger.error({ err, key: record.key }, "Failed to move a spooled admin alert into the database; the next sweep tries again");
    return;
  }
  if (await removeSpoolFile(file, result)) {
    result.ingested += 1;
    logger.warn(
      { key: record.key, spooledAt: record.spooledAt },
      "Moved an admin alert kept on disk during a database outage into the database (#5297)",
    );
  }
}

function parseSpooledOwedAlert(text: string): SpooledOwedAlert | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObject(value) || value.v !== 1) return null;
  const { key, due, retryAfterMs, replayAlert, spooledAt } = value;
  if (typeof key !== "string" || key === "") return null;
  if (due !== "next-run" && due !== "after-retry") return null;
  if (typeof retryAfterMs !== "number" || !Number.isFinite(retryAfterMs) || retryAfterMs < 0) return null;
  if (typeof spooledAt !== "string" || Number.isNaN(new Date(spooledAt).getTime())) return null;
  if (replayAlert !== undefined && !isObject(replayAlert)) return null;
  return {
    v: 1,
    key,
    due,
    retryAfterMs,
    ...(replayAlert === undefined ? {} : { replayAlert: replayAlert as Prisma.InputJsonObject }),
    spooledAt,
  };
}

/** Returns whether the file is gone. */
async function removeSpoolFile(file: string, result: { failed: number }): Promise<boolean> {
  try {
    await unlink(file);
    return true;
  } catch (err) {
    if (isMissing(err)) return true;
    result.failed += 1;
    logger.error({ err, file }, "Failed to delete a spooled admin alert; the next sweep reads it again and writes nothing new");
    return false;
  }
}

async function removeAbandonedTemp(file: string, now: Date): Promise<void> {
  try {
    if (now.getTime() - (await stat(file)).mtimeMs >= ABANDONED_TEMP_MS) await unlink(file);
  } catch (err) {
    if (!isMissing(err)) logger.warn({ err, file }, "Failed to remove an unfinished admin alert spool file");
  }
}

/** The key is hashed: it may hold characters a file name cannot. */
function spoolFileName(key: string): string {
  return `${createHash("sha256").update(key).digest("hex")}${SPOOL_SUFFIX}`;
}

async function spooledFiles(dir: string): Promise<string[]> {
  return (await readdir(dir)).filter((name) => name.endsWith(SPOOL_SUFFIX) && !name.startsWith(TEMP_PREFIX));
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch (err) {
    if (isMissing(err)) return false;
    throw err;
  }
}

/** Makes the rename itself durable; a platform that cannot sync a directory is not an error. */
async function syncDirectory(dir: string): Promise<void> {
  const handle = await open(dir, "r").catch(() => null);
  if (!handle) return;
  try {
    await handle.sync();
  } catch {
    // Not every filesystem syncs a directory handle.
  } finally {
    await handle.close();
  }
}

function isMissing(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
