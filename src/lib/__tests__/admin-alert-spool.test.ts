import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AlertCooldownFake } from "./helpers/alert-cooldown-fake";
import { appEnvironmentAnchor, readRepoFile } from "./helpers/compose";

const db = vi.hoisted(() => ({ fake: null as unknown as AlertCooldownFake }));
vi.mock("@/lib/prisma", async () => {
  const { createAlertCooldownFake } = await import("./helpers/alert-cooldown-fake");
  db.fake = createAlertCooldownFake();
  return { prisma: { alertCooldown: db.fake.delegate } };
});
const logger = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock("@/lib/logger", () => ({ default: logger }));

import { ADMIN_ALERT_SPOOL_MAX_FILES, ingestSpooledAlerts, markAlertOwedOrSpool } from "@/lib/admin-alert-spool";

/**
 * #5297 (`INV-INT-044`): an owed admin alert the database refuses is kept on
 * local disk, one file per key, and moved into the database by the sweep
 * exactly once. Driven over the in-memory `AlertCooldown` table and a real
 * temporary directory.
 */
const T0 = new Date("2026-07-01T00:00:00.000Z");
const KEY = "once-ever-owed:capacity-race-refund-shortfall:b1";
const REPLAY = { label: "shortfall alert", alert: { kind: "payment-recovery", bookingId: "b1", amountCents: 2000, paymentIntentId: "pi_1", errorMessage: "Refund $20.00 by hand" } };
const LOG = { label: "shortfall alert", context: { bookingId: "b1" } };
const owed = (key = KEY, now = T0) => ({ key, due: "after-retry" as const, retryAfterMs: 0, replayAlert: REPLAY, now });

let root: string;
let dir: string;
const files = () => readdirSync(dir);
const databaseDown = () => vi.spyOn(db.fake.delegate, "create").mockRejectedValue(new Error("Can't reach database server"));

beforeEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  db.fake.reset();
  root = mkdtempSync(path.join(tmpdir(), "admin-alert-spool-test-"));
  dir = path.join(root, "spool");
  process.env.ADMIN_ALERT_SPOOL_DIR = dir;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("markAlertOwedOrSpool", () => {
  it("writes the owed row and no file while the database answers", async () => {
    await expect(markAlertOwedOrSpool(owed(), LOG)).resolves.toBe("stored");
    expect(db.fake.rows.get(KEY)).toMatchObject({ lastAlertedAt: T0, replayAlert: REPLAY });
    expect(() => files()).toThrow(/ENOENT/);
  });

  it("keeps the row on disk, owner-only, holding only what the row would hold, when the database refuses it", async () => {
    databaseDown();
    await expect(markAlertOwedOrSpool(owed(), LOG)).resolves.toBe("spooled");

    expect(files()).toHaveLength(1);
    const file = path.join(dir, files()[0]!);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ v: 1, key: KEY, due: "after-retry", retryAfterMs: 0, replayAlert: REPLAY, spooledAt: T0.toISOString() });
    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ bookingId: "b1", key: KEY }), expect.stringContaining("kept it on disk"));
  });

  it("overwrites one file per key, so a repeat never makes a second", async () => {
    databaseDown();
    await markAlertOwedOrSpool(owed(KEY, T0), LOG);
    await markAlertOwedOrSpool(owed(KEY, new Date(T0.getTime() + 60_000)), LOG);
    await markAlertOwedOrSpool(owed(`${KEY}-other`), LOG);
    expect(files()).toHaveLength(2);
  });

  it("rethrows the database's error when the disk refuses the file too", async () => {
    writeFileSync(path.join(root, "not-a-directory"), "");
    process.env.ADMIN_ALERT_SPOOL_DIR = path.join(root, "not-a-directory", "spool");
    databaseDown();
    await expect(markAlertOwedOrSpool(owed(), LOG)).rejects.toThrow("Can't reach database server");
    expect(readdirSync(root)).toEqual(["not-a-directory"]);
  });

  it("writes no new file past the cap, but still replaces one already there", async () => {
    databaseDown();
    await markAlertOwedOrSpool(owed(), LOG);
    for (let i = 1; i < ADMIN_ALERT_SPOOL_MAX_FILES; i += 1) writeFileSync(path.join(dir, `filler-${i}.json`), "{}");

    await expect(markAlertOwedOrSpool(owed(`${KEY}-new`), LOG)).rejects.toThrow("Can't reach database server");
    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ key: `${KEY}-new` }), expect.stringContaining("spool is full"));
    await expect(markAlertOwedOrSpool(owed(), LOG)).resolves.toBe("spooled");
    expect(files()).toHaveLength(ADMIN_ALERT_SPOOL_MAX_FILES);
  });
});

describe("ingestSpooledAlerts", () => {
  async function spool(key = KEY, now = T0) {
    const down = databaseDown();
    await markAlertOwedOrSpool(owed(key, now), LOG);
    down.mockRestore();
  }

  it("finds nothing when no alert was ever spooled", async () => {
    await expect(ingestSpooledAlerts(T0)).resolves.toEqual({ ingested: 0, failed: 0 });
  });

  it("writes the row the database refused, stamped when it was raised, and deletes the file", async () => {
    const raisedAt = new Date(T0.getTime() - 3_600_000);
    await spool(KEY, raisedAt);

    await expect(ingestSpooledAlerts(T0)).resolves.toEqual({ ingested: 1, failed: 0 });
    expect(db.fake.rows.get(KEY)).toMatchObject({ lastAlertedAt: raisedAt, replayAlert: REPLAY });
    expect(files()).toEqual([]);
  });

  it("writes one row when a crash before the delete makes it read the file twice", async () => {
    await spool();
    const [name] = files();
    const copy = readFileSync(path.join(dir, name!), "utf8");
    await ingestSpooledAlerts(T0);
    writeFileSync(path.join(dir, name!), copy);

    await expect(ingestSpooledAlerts(T0)).resolves.toEqual({ ingested: 1, failed: 0 });
    expect([...db.fake.rows.keys()]).toEqual([KEY]);
    expect(files()).toEqual([]);
  });

  it("keeps the file for the next run while the database still refuses it", async () => {
    await spool();
    databaseDown();
    await expect(ingestSpooledAlerts(T0)).resolves.toEqual({ ingested: 0, failed: 1 });
    expect(files()).toHaveLength(1);
  });

  it("drops a file it cannot read, with an error, and moves the rest", async () => {
    await spool();
    writeFileSync(path.join(dir, "garbled.json"), "{not json");
    writeFileSync(path.join(dir, "future.json"), JSON.stringify({ v: 2, key: "k" }));

    await expect(ingestSpooledAlerts(T0)).resolves.toEqual({ ingested: 1, failed: 0 });
    expect(files()).toEqual([]);
    expect(logger.error).toHaveBeenCalledWith(expect.anything(), expect.stringContaining("cannot read"));
  });

  it("removes a temporary file an unfinished write left, once it is an hour old", async () => {
    mkdirSync(dir, { recursive: true });
    const temp = path.join(dir, ".tmp-abandoned");
    writeFileSync(temp, "{");
    const written = new Date(T0.getTime() - 30 * 60_000);
    utimesSync(temp, written, written);

    await ingestSpooledAlerts(T0);
    expect(files()).toEqual([".tmp-abandoned"]);
    await ingestSpooledAlerts(new Date(T0.getTime() + 31 * 60_000));
    expect(files()).toEqual([]);
  });
});

describe("the spool's storage in the Docker images", () => {
  it("is a named volume every app container mounts, owned by the app user in the image, outside /app", () => {
    const compose = readRepoFile("docker-compose.yml");
    expect(appEnvironmentAnchor(compose)?.split("\n")).toContain("  ADMIN_ALERT_SPOOL_DIR: /admin-alert-spool");
    const appAnchor = compose.split("\nx-app-service:")[1]?.split("\nservices:")[0];
    expect(appAnchor?.split("\n")).toContain("    - admin_alert_spool:/admin-alert-spool");
    expect(compose).toMatch(/^  admin_alert_spool:\n?$/m);
    expect(readRepoFile("Dockerfile").split("\n")).toContain(
      "RUN mkdir -p /admin-alert-spool && chown nextjs:nodejs /admin-alert-spool && chmod 700 /admin-alert-spool",
    );
  });
});
