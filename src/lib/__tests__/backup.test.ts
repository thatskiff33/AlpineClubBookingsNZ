import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "child_process";
import path from "node:path";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "fs";

vi.mock("child_process", () => ({
  execFileSync: vi.fn(),
}));

vi.mock("fs", async () => {
  const actual = (await vi.importActual("fs")) as typeof import("fs");
  return {
    ...actual,
    existsSync: vi.fn(),
    mkdirSync: vi.fn(),
    readdirSync: vi.fn(),
    statSync: vi.fn(),
    unlinkSync: vi.fn(),
    writeFileSync: vi.fn(),
  };
});

vi.mock("@/lib/logger", () => ({
  default: {
    error: vi.fn(),
    info: vi.fn(),
  },
}));

// Backup config is DB-only (#2095): mock the resolver rather than setting env.
// PARTIAL, not wholesale: the module also exports the pure
// `isAnyBackupDestinationEnabled` predicate the engine now gates on, and
// replacing the whole module left it undefined — killing every case in this
// file with "No isAnyBackupDestinationEnabled export is defined on the mock".
vi.mock("@/lib/backup-config", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("@/lib/backup-config");
  return { ...actual, resolveBackupConfig: vi.fn() };
});

import {
  applyLegacyBackupEnvGate,
  buildBackupCronOutcome,
  describeMissingCommand,
  LEGACY_BACKUP_ENV_UNMIGRATED_MESSAGE,
  runDatabaseBackup,
  sanitizePostgresUrlForPgDump,
  splitPostgresPassword,
} from "@/lib/backup";
import {
  resolveBackupConfig,
  type ResolvedBackupConfig,
} from "@/lib/backup-config";
import logger from "@/lib/logger";

const BACKUP_DIRECTORY_FRAGMENT =
  path.join("/tmp", "tacbookings-backups") + path.sep;

function makeConfig(
  overrides: Partial<ResolvedBackupConfig> = {},
): ResolvedBackupConfig {
  return {
    enabled: true,
    bucket: null,
    region: "ap-southeast-2",
    retentionDays: 7,
    accessKeyId: null,
    secretAccessKey: null,
    restoreValidationUrl: null,
    // Local backups off by default here, so every existing case in this file
    // keeps asserting the S3/ephemeral behaviour it was written for.
    localEnabled: false,
    localPath: null,
    needsReentry: false,
    ...overrides,
  };
}

describe("backup", () => {
  const originalEnv = { ...process.env };
  const execFileSyncMock = vi.mocked(execFileSync);
  const existsSyncMock = vi.mocked(existsSync);
  const mkdirSyncMock = vi.mocked(mkdirSync);
  const readdirSyncMock = vi.mocked(readdirSync);
  const statSyncMock = vi.mocked(statSync);
  const unlinkSyncMock = vi.mocked(unlinkSync);
  const writeFileSyncMock = vi.mocked(writeFileSync);
  const loggerErrorMock = vi.mocked(logger.error);
  const resolveBackupConfigMock = vi.mocked(resolveBackupConfig);

  function setConfig(overrides: Partial<ResolvedBackupConfig> = {}) {
    resolveBackupConfigMock.mockResolvedValue(makeConfig(overrides));
  }

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
    // A live source database URL stays env-driven (bootstrap config).
    process.env.DATABASE_URL =
      "postgresql://postgres:postgres@postgres:5432/tacbookings";
    setConfig();
    existsSyncMock.mockReturnValue(true);
    readdirSyncMock.mockReturnValue([] as never);
    statSyncMock.mockReturnValue({ size: 1024, mtimeMs: Date.now() } as never);
    execFileSyncMock.mockImplementation((file, args) => {
      if (file === "psql" && Array.isArray(args) && args.includes("-At")) {
        return "3|4|5\n" as never;
      }

      if (file === "gunzip") {
        return Buffer.from("-- restored sql") as never;
      }

      return Buffer.from("-- database dump") as never;
    });
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns a skipped result when backups are disabled", async () => {
    setConfig({ enabled: false });

    await expect(runDatabaseBackup()).resolves.toEqual({
      success: false,
      skipped: true,
      reason: "Backups are disabled. Enable them on Admin → Backups.",
    });
  });

  it("fails loudly when stored credentials cannot be decrypted", async () => {
    setConfig({ needsReentry: true });

    await expect(runDatabaseBackup()).resolves.toEqual({
      success: false,
      error:
        "Backup credentials could not be decrypted (the app auth secret changed). Re-enter the S3 credentials on Admin → Backups.",
    });

    // A decrypt failure is a FAILURE the cron alerts on, never a silent skip.
    expect(
      buildBackupCronOutcome({
        success: false,
        error:
          "Backup credentials could not be decrypted (the app auth secret changed). Re-enter the S3 credentials on Admin → Backups.",
      }).status,
    ).toBe("FAILURE");
  });

  it("classifies a successful backup as SUCCESS", () => {
    expect(
      buildBackupCronOutcome({
        success: true,
        filename: "backup.sql.gz",
        sizeBytes: 1024,
        uploadedToS3: true,
      })
    ).toEqual({
      status: "SUCCESS",
      resultSummary: {
        filename: "backup.sql.gz",
        sizeBytes: 1024,
        minSizeBytes: 128,
        s3: true,
      },
    });
  });

  it("downgrades S3-less local backups to a not-durable FAILURE", () => {
    expect(
      buildBackupCronOutcome({
        success: true,
        filename: "backup.sql.gz",
        sizeBytes: 1024,
        uploadedToS3: false,
      })
    ).toEqual({
      status: "FAILURE",
      error:
        "Backup completed only to local ephemeral storage; configure an S3 destination on Admin → Backups for durable backups",
      resultSummary: {
        filename: "backup.sql.gz",
        sizeBytes: 1024,
        minSizeBytes: 128,
        s3: false,
        healthSignal: "backup-not-durable",
      },
    });
  });

  it("does not call a local-only backup 'not durable'", () => {
    // A club that backs up to a configured on-host directory HAS a destination.
    // Before local backups existed, "no S3" and "nowhere at all" were the same
    // state, so the nightly run failed; treating them the same now would fail
    // every local-only club's cron every night, for a backup that worked.
    expect(
      buildBackupCronOutcome({
        success: true,
        filename: "backup.sql.gz",
        sizeBytes: 1024,
        uploadedToS3: false,
        storedLocally: true,
        localPruned: ["tacbookings-old.sql.gz"],
      }),
    ).toEqual({
      status: "SUCCESS",
      resultSummary: {
        filename: "backup.sql.gz",
        sizeBytes: 1024,
        minSizeBytes: 128,
        s3: false,
        local: true,
        localPruned: 1,
      },
    });
  });

  it("still fails a run that reached NEITHER destination", () => {
    // The guard that keeps the case above honest: without a destination the
    // dump is in the container's ephemeral /tmp and a restart discards it.
    expect(
      buildBackupCronOutcome({
        success: true,
        filename: "backup.sql.gz",
        sizeBytes: 1024,
        uploadedToS3: false,
        storedLocally: false,
      }).status,
    ).toBe("FAILURE");
  });

  describe("applyLegacyBackupEnvGate (#2095 MAJOR-1)", () => {
    const skipped = buildBackupCronOutcome({
      success: false,
      skipped: true,
      reason: "Backups are disabled. Enable them on Admin → Backups.",
    });

    it("upgrades a SKIPPED run to FAILURE when legacy backup env is present", () => {
      const gated = applyLegacyBackupEnvGate(skipped, {
        legacyEnvPresent: true,
      });
      expect(gated.status).toBe("FAILURE");
      expect(gated.error).toBe(LEGACY_BACKUP_ENV_UNMIGRATED_MESSAGE);
      expect(gated.resultSummary).toMatchObject({
        healthSignal: "backup-legacy-env-unmigrated",
      });
    });

    it("leaves a SKIPPED run quiet when no legacy backup env is present", () => {
      expect(
        applyLegacyBackupEnvGate(skipped, { legacyEnvPresent: false }),
      ).toBe(skipped);
    });

    it("does not touch a non-SKIPPED outcome even with legacy env present", () => {
      const failure = buildBackupCronOutcome({
        success: false,
        error:
          "Backup credentials could not be decrypted (the app auth secret changed). Re-enter the S3 credentials on Admin → Backups.",
      });
      // needsReentry / not-durable FAILUREs are already loud; the gate is a no-op.
      expect(applyLegacyBackupEnvGate(failure, { legacyEnvPresent: true })).toBe(
        failure,
      );

      const success = buildBackupCronOutcome({
        success: true,
        filename: "backup.sql.gz",
        sizeBytes: 1024,
        uploadedToS3: true,
      });
      expect(applyLegacyBackupEnvGate(success, { legacyEnvPresent: true })).toBe(
        success,
      );
    });
  });

  it("classifies a skipped backup as SKIPPED", () => {
    expect(
      buildBackupCronOutcome({
        success: false,
        skipped: true,
        reason: "Backups are disabled. Enable them on Admin → Backups.",
      })
    ).toEqual({
      status: "SKIPPED",
      resultSummary: {
        reason: "Backups are disabled. Enable them on Admin → Backups.",
      },
    });
  });

  it("classifies a failed backup as FAILURE", () => {
    expect(
      buildBackupCronOutcome({
        success: false,
        error: "pg_dump failed",
      })
    ).toEqual({
      status: "FAILURE",
      error: "pg_dump failed",
    });
  });

  it("passes the postgres password via PGPASSWORD, never on the command line", async () => {
    await expect(runDatabaseBackup()).resolves.toMatchObject({ success: true });

    // The URL on argv has the password stripped…
    expect(execFileSyncMock).toHaveBeenCalledWith(
      "pg_dump",
      ["postgresql://postgres@postgres:5432/tacbookings"],
      expect.objectContaining({
        env: expect.objectContaining({ PGPASSWORD: "postgres" }),
      })
    );
  });

  it("splits a postgres password out of a connection URL", () => {
    expect(
      splitPostgresPassword("postgresql://user:s3cr3t@host:5432/db"),
    ).toEqual({
      argvUrl: "postgresql://user@host:5432/db",
      password: "s3cr3t",
    });
    expect(splitPostgresPassword("postgresql://user@host:5432/db")).toEqual({
      argvUrl: "postgresql://user@host:5432/db",
    });
  });

  it("never returns an unparseable conninfo with its password intact (#2095 MAJOR-2)", () => {
    // libpq keyword form — new URL() cannot parse it, but the password must not
    // survive onto argv or into any persisted error.
    const keyword = splitPostgresPassword(
      "host=db.internal port=5432 dbname=shadow user=tac password=s3cr3t",
    );
    expect(keyword.password).toBeUndefined();
    expect(keyword.argvUrl).not.toContain("s3cr3t");

    // A URI with an out-of-range port that URL() rejects — the userinfo password
    // is stripped rather than returned verbatim.
    const badPort = splitPostgresPassword(
      "postgresql://tac:s3cr3t@db.internal:99999/shadow",
    );
    expect(badPort.password).toBeUndefined();
    expect(badPort.argvUrl).not.toContain("s3cr3t");
  });

  it("fails when an S3 upload is configured but denied", async () => {
    setConfig({
      bucket: "tacbookings-backups",
      region: "ap-southeast-2",
      accessKeyId: "AKIA-test",
      secretAccessKey: "secret-test",
    });

    execFileSyncMock.mockImplementation((file) => {
      if (file === "aws") {
        throw new Error("AccessDenied");
      }

      return Buffer.from("-- database dump") as never;
    });

    await expect(runDatabaseBackup()).resolves.toMatchObject({
      success: false,
      filename: expect.stringMatching(/^tacbookings-/),
      filepath: expect.stringContaining(BACKUP_DIRECTORY_FRAGMENT),
      sizeBytes: 1024,
      error: expect.stringContaining("S3 upload/readback failed: AccessDenied"),
    });

    expect(loggerErrorMock).toHaveBeenCalledWith(
      expect.objectContaining({
        err: expect.any(Error),
        job: "backup",
      }),
      "S3 upload or readback failed"
    );
    expect(execFileSyncMock).toHaveBeenCalledWith(
      "aws",
      [
        "s3",
        "cp",
        expect.stringContaining(BACKUP_DIRECTORY_FRAGMENT),
        expect.stringMatching(/s3:\/\/tacbookings-backups\/tacbookings_s3backup\/tacbookings-/),
        "--region",
        "ap-southeast-2",
      ],
      expect.objectContaining({
        env: expect.objectContaining({
          AWS_ACCESS_KEY_ID: "AKIA-test",
          AWS_SECRET_ACCESS_KEY: "secret-test",
        }),
      })
    );
    expect(mkdirSyncMock).not.toHaveBeenCalled();
    expect(unlinkSyncMock).not.toHaveBeenCalled();
  });

  it("fails closed when pg_dump produces a suspiciously tiny gzip artifact", async () => {
    execFileSyncMock.mockReturnValue(Buffer.from("-- database dump") as never);
    statSyncMock.mockReturnValue({ size: 20, mtimeMs: Date.now() } as never);

    await expect(runDatabaseBackup()).resolves.toMatchObject({
      success: false,
      error: "Backup file is suspiciously small",
      sizeBytes: 20,
      minSizeBytes: 128,
      healthSignal: "backup-suspiciously-small",
    });

    expect(unlinkSyncMock).toHaveBeenCalledTimes(1);
  });

  it("surfaces suspicious backup size as operator-visible cron metadata", () => {
    expect(
      buildBackupCronOutcome({
        success: false,
        error: "Backup file is suspiciously small",
        filename: "backup.sql.gz",
        sizeBytes: 20,
        minSizeBytes: 128,
        healthSignal: "backup-suspiciously-small",
      })
    ).toEqual({
      status: "FAILURE",
      error: "Backup file is suspiciously small",
      resultSummary: {
        healthSignal: "backup-suspiciously-small",
        filename: "backup.sql.gz",
        sizeBytes: 20,
        minSizeBytes: 128,
      },
    });
  });

  it("strips Prisma-only query parameters before invoking pg_dump", async () => {
    process.env.DATABASE_URL =
      "postgresql://postgres:postgres@postgres:5432/tacbookings?connection_limit=5&pool_timeout=10&schema=bookings&sslmode=require";

    await expect(runDatabaseBackup()).resolves.toMatchObject({
      success: true,
      sizeBytes: 1024,
    });

    expect(execFileSyncMock).toHaveBeenCalledWith(
      "pg_dump",
      ["postgresql://postgres@postgres:5432/tacbookings?sslmode=require"],
      expect.objectContaining({
        env: expect.objectContaining({ PGPASSWORD: "postgres" }),
      })
    );
  });

  it("returns sanitized postgres URLs for external callers", () => {
    const sanitized = sanitizePostgresUrlForPgDump(
      "postgresql://tac:password@postgres:5432/tacbookings?connection_limit=5&pool_timeout=10&pgbouncer=true&schema=public&sslmode=require"
    );

    const parsed = new URL(sanitized);
    expect(parsed.searchParams.get("connection_limit")).toBeNull();
    expect(parsed.searchParams.get("pool_timeout")).toBeNull();
    expect(parsed.searchParams.get("pgbouncer")).toBeNull();
    expect(parsed.searchParams.get("schema")).toBeNull();
    expect(parsed.searchParams.get("sslmode")).toBe("require");
  });

  it("says WHICH tool is missing when pg_dump is not installed", async () => {
    // The reported failure was `pg_dump failed: spawnSync pg_dump ENOENT`, which
    // names no package, suggests a code fault, and lands on the disaster-recovery
    // screen. The image ships postgresql16-client, so this fires on a host that
    // does not — where the reader needs to be told what to install.
    vi.mocked(resolveBackupConfig).mockResolvedValue(makeConfig());
    vi.mocked(existsSync).mockReturnValue(true);
    const enoent = Object.assign(new Error("spawnSync pg_dump ENOENT"), {
      code: "ENOENT",
      syscall: "spawnSync pg_dump",
      path: "pg_dump",
    });
    vi.mocked(execFileSync).mockImplementation(() => {
      throw enoent;
    });

    const result = await runDatabaseBackup();

    expect(result.success).toBe(false);
    expect(result.error).toContain("pg_dump is not installed on the server");
    expect(result.error).toContain("PostgreSQL client tools");
    // The raw spawn text is gone rather than appended.
    expect(result.error).not.toContain("spawnSync");
  });

  it("does not mislabel a missing FILE as a missing command", () => {
    // ENOENT is also what a missing backup file reports. Only a failed LAUNCH
    // (`syscall: spawnSync …`) is a missing executable.
    expect(
      describeMissingCommand(
        Object.assign(new Error("ENOENT: no such file"), {
          code: "ENOENT",
          syscall: "open",
          path: "/var/backups/gone.sql.gz",
        }),
      ),
    ).toBeNull();
    expect(describeMissingCommand(new Error("boom"))).toBeNull();
  });

  it("names the AWS CLI rather than postgres when the aws command is missing", () => {
    expect(
      describeMissingCommand(
        Object.assign(new Error("spawnSync aws ENOENT"), {
          code: "ENOENT",
          syscall: "spawnSync aws",
          path: "aws",
        }),
      ),
    ).toContain("the AWS CLI");
  });

  it("fails closed when pg_dump exits non-zero", async () => {
    process.env.DATABASE_URL =
      "postgresql://postgres:postgres@postgres:5432/tacbookings?connection_limit=5&pool_timeout=10";
    execFileSyncMock.mockImplementation((file) => {
      if (file === "pg_dump") {
        throw new Error('pg_dump: error: invalid URI query parameter: "connection_limit"');
      }

      return Buffer.from("") as never;
    });

    await expect(runDatabaseBackup()).resolves.toEqual({
      success: false,
      error: expect.stringContaining("pg_dump failed:"),
    });

    expect(writeFileSyncMock).not.toHaveBeenCalled();
  });

  it("verifies S3 readback after upload before declaring success", async () => {
    setConfig({
      bucket: "tacbookings-backups",
      region: "ap-southeast-2",
      accessKeyId: "AKIA-test",
      secretAccessKey: "secret-test",
    });

    await expect(runDatabaseBackup()).resolves.toMatchObject({
      success: true,
      uploadedToS3: true,
      s3Key: expect.stringMatching(/^tacbookings_s3backup\/tacbookings-/),
      s3ReadbackVerified: true,
      s3ReadbackSizeBytes: 1024,
    });

    expect(execFileSyncMock).toHaveBeenCalledWith(
      "aws",
      [
        "s3",
        "cp",
        expect.stringContaining(BACKUP_DIRECTORY_FRAGMENT),
        expect.stringMatching(/s3:\/\/tacbookings-backups\/tacbookings_s3backup\/tacbookings-/),
        "--region",
        "ap-southeast-2",
      ],
      expect.any(Object)
    );
    expect(execFileSyncMock).toHaveBeenCalledWith(
      "aws",
      [
        "s3",
        "cp",
        expect.stringMatching(/s3:\/\/tacbookings-backups\/tacbookings_s3backup\/tacbookings-/),
        expect.stringContaining(".s3-readback"),
        "--region",
        "ap-southeast-2",
      ],
      expect.any(Object)
    );
    expect(unlinkSyncMock).toHaveBeenCalledWith(
      expect.stringContaining(".s3-readback")
    );
  });

  it("validates a restored backup against a disposable shadow database", async () => {
    setConfig({
      restoreValidationUrl:
        "postgresql://postgres:postgres@postgres:5432/tacbookings_restore?connection_limit=1",
    });

    const result = await runDatabaseBackup();

    expect(result).toMatchObject({
      success: true,
      restoreValidation: {
        source: "local-file",
        memberCount: 3,
        bookingCount: 4,
        paymentCount: 5,
      },
    });
    expect(execFileSyncMock).toHaveBeenCalledWith(
      "psql",
      [
        "postgresql://postgres@postgres:5432/tacbookings_restore",
        "-v",
        "ON_ERROR_STOP=1",
        "-c",
        "DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;",
      ],
      expect.objectContaining({
        env: expect.objectContaining({ PGPASSWORD: "postgres" }),
      })
    );
    expect(execFileSyncMock).toHaveBeenCalledWith(
      "gunzip",
      ["-c", expect.stringContaining(BACKUP_DIRECTORY_FRAGMENT)],
      expect.any(Object)
    );
  });

  it("fails backup when restore validation smoke counts are empty", async () => {
    setConfig({
      restoreValidationUrl:
        "postgresql://postgres:postgres@postgres:5432/tacbookings_restore",
    });
    execFileSyncMock.mockImplementation((file, args) => {
      if (file === "psql" && Array.isArray(args) && args.includes("-At")) {
        return "3|0|5\n" as never;
      }

      if (file === "gunzip") {
        return Buffer.from("-- restored sql") as never;
      }

      return Buffer.from("-- database dump") as never;
    });

    await expect(runDatabaseBackup()).resolves.toMatchObject({
      success: false,
      error: expect.stringContaining("Restore validation failed:"),
    });

    expect(loggerErrorMock).toHaveBeenCalledWith(
      expect.objectContaining({
        err: expect.any(Error),
        job: "backup",
      }),
      "Restore validation failed"
    );
  });

  it("refuses restore validation when the shadow URL points at the source database", async () => {
    process.env.DATABASE_URL =
      "postgresql://postgres:postgres@postgres:5432/tacbookings?connection_limit=5";
    setConfig({
      restoreValidationUrl:
        "postgresql://postgres:postgres@postgres:5432/tacbookings",
    });

    await expect(runDatabaseBackup()).resolves.toEqual({
      success: false,
      error:
        "The restore-validation URL must point at a disposable shadow database, not the live DATABASE_URL",
    });

    expect(execFileSyncMock).not.toHaveBeenCalled();
  });
});
