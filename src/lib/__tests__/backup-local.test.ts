import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import path from "path";

import {
  directoryAdviceForThisRuntime,
  diskSpaceLevel,
  ensureLocalBackupDirectory,
  DISK_SPACE_CRITICAL_BYTES,
  DISK_SPACE_WARNING_BYTES,
  isValidLocalBackupPath,
  listLocalBackups,
  LocalBackupPathError,
  pruneLocalBackups,
  resolveLocalBackupDirectory,
  resolveLocalBackupFile,
} from "@/lib/backup-local";

/**
 * The local-backup filesystem rules.
 *
 * This suite is mostly about REFUSALS, because that is where the feature's risk
 * is: the directory decides where a full `pg_dump` of the club database lands,
 * and the filename decides what gets piped into `psql` over the live database.
 * A permissive bug in either is a data-exfiltration or arbitrary-SQL hole, not a
 * cosmetic one.
 */

let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "backup-local-"));
});

afterEach(() => {
  rmSync(root, { force: true, recursive: true });
});

function writeBackup(directory: string, filename: string, mtime?: Date) {
  const filepath = path.join(directory, filename);
  writeFileSync(filepath, "-- dump");
  if (mtime) utimesSync(filepath, mtime, mtime);
  return filepath;
}

describe("resolveLocalBackupDirectory", () => {
  it("accepts an absolute path outside the application, unchanged", () => {
    // POSIX in, POSIX out — deliberately NOT `path.resolve`, which on a Windows
    // developer machine would answer `D:\var\backups\...` and take the value
    // out of the shape the Linux container will use it in.
    expect(resolveLocalBackupDirectory("/var/backups/tacbookings")).toBe(
      "/var/backups/tacbookings",
    );
    expect(resolveLocalBackupDirectory("/var/backups/./tacbookings/")).toBe(
      "/var/backups/tacbookings/",
    );
  });

  it.each([
    ["an empty path", ""],
    ["a relative path", "backups/nightly"],
    ["a bare directory name", "backups"],
    ["a tilde path, which is shell expansion rather than a path", "~/backups"],
    ["a traversal", "/var/backups/../../etc"],
    ["the filesystem root", "/"],
  ])("refuses %s", (_label, input) => {
    expect(() => resolveLocalBackupDirectory(input)).toThrow(LocalBackupPathError);
    expect(isValidLocalBackupPath(input)).toBe(false);
  });

  it("refuses a NUL byte, which would truncate the path at the syscall", () => {
    // The check would otherwise be run against one string and the open against
    // a shorter one.
    expect(() => resolveLocalBackupDirectory("/var/backups\0/etc")).toThrow(
      LocalBackupPathError,
    );
  });

  it.each([
    "/etc",
    "/etc/cron.d",
    "/proc/self",
    "/sys/kernel",
    "/dev/shm",
    "/usr/local/bin",
    "/var/lib/postgresql/data",
  ])("refuses the system directory %s", (input) => {
    expect(() => resolveLocalBackupDirectory(input)).toThrow(LocalBackupPathError);
  });

  it("refuses a path inside the application directory", () => {
    // THE ONE THAT MATTERS MOST: `public/` is served verbatim, so a dump written
    // under the app root is the whole database one URL guess away.
    const appRoot = path.join(root, "app");
    mkdirSync(appRoot, { recursive: true });
    expect(() =>
      resolveLocalBackupDirectory(path.join(appRoot, "public", "backups"), {
        applicationRoot: appRoot,
      }),
    ).toThrow(/inside the application directory/);
    expect(() =>
      resolveLocalBackupDirectory(appRoot, { applicationRoot: appRoot }),
    ).toThrow(/inside the application directory/);
  });

  it("does not refuse a path that merely starts with the same characters", () => {
    // `/srv/app-backups` is not inside `/srv/app`. A prefix test without the
    // separator would have said it was.
    const appRoot = path.join(root, "app");
    expect(
      isValidLocalBackupPath(`${appRoot}-backups`, { applicationRoot: appRoot }),
    ).toBe(true);
  });
});

describe("ensureLocalBackupDirectory", () => {
  // THIS SUITE EXISTS BECAUSE THE FIRST VERSION SHIPPED BROKEN AND NOTHING HERE
  // NOTICED. The write probe copied `/dev/null`, which is a Linux device: on a
  // Windows developer machine every valid directory was reported as
  // "not writable by the application", with an ENOENT naming a Windows-shaped
  // path to that device. The path
  // RULES were tested exhaustively and the one function that actually touches
  // the filesystem was not called at all.
  it("accepts a writable directory that already exists", () => {
    expect(() => ensureLocalBackupDirectory(root)).not.toThrow();
  });

  it("creates a directory that does not exist yet", () => {
    const nested = path.join(root, "nested", "backups");
    ensureLocalBackupDirectory(nested);
    expect(existsSync(nested)).toBe(true);
  });

  it("leaves no probe file behind", () => {
    ensureLocalBackupDirectory(root);
    expect(readdirSync(root)).toEqual([]);
  });

  it("refuses a path the rules reject before touching the disk", () => {
    expect(() => ensureLocalBackupDirectory("relative/path")).toThrow(
      LocalBackupPathError,
    );
  });
});

describe("directoryAdviceForThisRuntime", () => {
  // The message an operator actually acts on. A real deployment created
  // /home/<user>/db_backup on the HOST, typed it here, and got back
  // "Could not create that directory: ENOENT" — true, and useless: the app runs
  // in a container with a read-only root, so a host path it was never shown does
  // not exist in its filesystem and cannot be created there either.
  const originalMountedDir = process.env.BACKUP_LOCAL_DIR;
  afterEach(() => {
    if (originalMountedDir === undefined) delete process.env.BACKUP_LOCAL_DIR;
    else process.env.BACKUP_LOCAL_DIR = originalMountedDir;
  });

  it("names the mounted path when the deployment has one", () => {
    process.env.BACKUP_LOCAL_DIR = "/backups";

    const advice = directoryAdviceForThisRuntime(true);

    expect(advice).toContain("mounted");
    expect(advice).toContain("/backups");
    // The specific confusion to clear: host path vs container path.
    expect(advice).toContain("host path");
  });

  it("says how to create the mount when the deployment has none", () => {
    delete process.env.BACKUP_LOCAL_DIR;

    const advice = directoryAdviceForThisRuntime(true);

    expect(advice).toContain("BACKUP_LOCAL_HOST_DIR");
    expect(advice).toContain("docker compose up -d app");
    // uid 1001 is the app user; a host directory owned by anyone else is
    // unwritable, which is the SECOND thing that stops an operator.
    expect(advice).toContain("1001");
  });

  it("does not talk about containers when it is not in one", () => {
    const advice = directoryAdviceForThisRuntime(false);

    expect(advice).not.toContain("container");
    expect(advice).not.toContain("BACKUP_LOCAL_HOST_DIR");
    expect(advice).toContain("can write to it");
  });
});

describe("listLocalBackups", () => {
  it("lists only this app's own backups, newest first", () => {
    writeBackup(root, "tacbookings-2026-08-01T03-00-00-000Z.sql.gz", new Date("2026-08-01T03:00:00Z"));
    writeBackup(root, "tacbookings-2026-08-03T03-00-00-000Z.sql.gz", new Date("2026-08-03T03:00:00Z"));
    // Not ours, and not offered for restore: an operator-dropped archive could
    // be anything, and a `.sql` file is executable SQL.
    writeBackup(root, "someone-elses-dump.sql.gz", new Date("2026-08-04T03:00:00Z"));
    writeBackup(root, "notes.txt", new Date("2026-08-04T03:00:00Z"));
    mkdirSync(path.join(root, "tacbookings-2026-08-05T03-00-00-000Z.sql.gz"));

    const listed = listLocalBackups(root);

    expect(listed.map((file) => file.filename)).toEqual([
      "tacbookings-2026-08-03T03-00-00-000Z.sql.gz",
      "tacbookings-2026-08-01T03-00-00-000Z.sql.gz",
    ]);
  });

  it("answers empty for a directory that does not exist", () => {
    // An unmounted volume must not throw the whole admin status page down.
    expect(listLocalBackups(path.join(root, "not-here"))).toEqual([]);
  });
});

describe("resolveLocalBackupFile", () => {
  it("resolves a backup that is really in the directory", () => {
    const filename = "tacbookings-2026-08-01T03-00-00-000Z.sql.gz";
    writeBackup(root, filename);
    expect(resolveLocalBackupFile(root, filename)).toBe(path.join(root, filename));
  });

  it.each([
    ["a traversal", "../../etc/passwd"],
    ["a traversal wearing the right suffix", "../tacbookings-2026-08-01T03-00-00-000Z.sql.gz"],
    ["an absolute path", "/etc/passwd"],
    ["a foreign archive in the same directory", "someone-elses-dump.sql.gz"],
  ])("refuses %s", (_label, candidate) => {
    writeBackup(root, "someone-elses-dump.sql.gz");
    expect(() => resolveLocalBackupFile(root, candidate)).toThrow(LocalBackupPathError);
  });

  it("refuses a well-formed name that is not actually there", () => {
    expect(() =>
      resolveLocalBackupFile(root, "tacbookings-2026-01-01T03-00-00-000Z.sql.gz"),
    ).toThrow(/no longer exists/);
  });
});

describe("pruneLocalBackups", () => {
  it("deletes backups older than the retention window and keeps the rest", () => {
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    writeBackup(root, "tacbookings-2026-05-22T03-00-00-000Z.sql.gz", new Date(now - 40 * day));
    writeBackup(root, "tacbookings-2026-06-02T03-00-00-000Z.sql.gz", new Date(now - 29 * day));
    writeBackup(root, "tacbookings-2026-06-30T03-00-00-000Z.sql.gz", new Date(now - 1 * day));

    const removed = pruneLocalBackups(root, 30);

    expect(removed).toEqual(["tacbookings-2026-05-22T03-00-00-000Z.sql.gz"]);
    expect(listLocalBackups(root).map((f) => f.filename).sort()).toEqual([
      "tacbookings-2026-06-02T03-00-00-000Z.sql.gz",
      "tacbookings-2026-06-30T03-00-00-000Z.sql.gz",
    ]);
  });

  it("never touches a file that is not one of ours", () => {
    const now = Date.now();
    writeBackup(root, "someone-elses-dump.sql.gz", new Date(now - 400 * 24 * 60 * 60 * 1000));
    expect(pruneLocalBackups(root, 1)).toEqual([]);
  });
});

describe("diskSpaceLevel", () => {
  it("is critical below 1 GB, warning below 5 GB, and ok above", () => {
    expect(diskSpaceLevel(DISK_SPACE_CRITICAL_BYTES - 1)).toBe("critical");
    expect(diskSpaceLevel(DISK_SPACE_CRITICAL_BYTES)).toBe("warning");
    expect(diskSpaceLevel(DISK_SPACE_WARNING_BYTES - 1)).toBe("warning");
    expect(diskSpaceLevel(DISK_SPACE_WARNING_BYTES)).toBe("ok");
    expect(diskSpaceLevel(0)).toBe("critical");
  });
});
