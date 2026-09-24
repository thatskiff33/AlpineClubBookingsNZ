import { beforeEach, describe, expect, it, vi } from "vitest";
import { strToU8 } from "fflate";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/backup", () => ({ runDatabaseBackup: vi.fn() }));
vi.mock("@/lib/audit", () => ({ createAuditLog: vi.fn(async () => undefined) }));

import type { PrismaClient } from "@prisma/client";

import { createAuditLog } from "@/lib/audit";
import { runDatabaseBackup, type BackupResult } from "@/lib/backup";
import {
  applyConfigImport,
  ConfigImportBackupError,
} from "@/lib/config-transfer/apply";
import { buildBundle } from "@/lib/config-transfer/bundle";
import { buildImportPlan } from "@/lib/config-transfer/import";
import type { ReadDb } from "@/lib/config-transfer/import-types";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";

// ADR-002 pre-apply backup durability gate. With backups enabled but no S3
// destination configured (in-app, #2095), runDatabaseBackup "succeeds" onto the
// web slot's LOCAL disk only — a file the next blue/green deploy wipes. That is
// NOT a safety backup: the import must refuse to clobber config it cannot
// restore, and the audit record must state the durability truthfully instead of
// implying a recoverable backup exists.

const GENERATED_AT = "2026-07-10T00:00:00.000Z";

function committeeBundle(): Uint8Array {
  return buildBundle({
    entries: [
      {
        path: "committee/roles.csv",
        category: "committee",
        rowCount: 1,
        bytes: strToU8(
          "key,name,description,contactEmail,isActive,sortOrder\npresident,President,,,true,1\n",
        ),
      },
    ],
    appVersion: "0.10.1",
    prismaMigration: null,
    includedCategories: ["committee"],
    doorCodesIncluded: false,
    generatedAt: GENERATED_AT,
  });
}

/** Empty-DB read side for the dry-run that mints the expected fingerprint. */
function planDb(): ReadDb {
  return {
    committeeRole: { findMany: vi.fn().mockResolvedValue([]) },
  } as unknown as ReadDb;
}

/** Prisma double whose mutation spies prove whether the import wrote. */
function applyHarness() {
  const create = vi.fn(async () => ({}));
  const update = vi.fn(async () => ({}));
  const committeeRole = {
    findMany: vi.fn(async () => []),
    create,
    update,
  };
  const tx = { committeeRole, $executeRaw: vi.fn(async () => 0) };
  const $transaction = vi.fn(
    async (fn: (t: typeof tx) => Promise<void>) => fn(tx),
  );
  const prisma = { committeeRole, $transaction } as unknown as PrismaClient;
  return { prisma, create, update, $transaction };
}

const DURABLE_BACKUP: BackupResult = {
  success: true,
  filename: "tacbookings-x.sql.gz",
  filepath: "/tmp/backups/tacbookings-x.sql.gz",
  uploadedToS3: true,
  s3Key: "tacbookings_s3backup/tacbookings-x.sql.gz",
  s3ReadbackVerified: true,
  sizeBytes: 2048,
};

const LOCAL_ONLY_BACKUP: BackupResult = {
  success: true,
  filename: "tacbookings-x.sql.gz",
  filepath: "/tmp/backups/tacbookings-x.sql.gz",
  uploadedToS3: false,
  sizeBytes: 2048,
};

async function applyWith(
  prisma: PrismaClient,
  mode: "merge" | "overwrite",
): Promise<ReturnType<typeof applyConfigImport>> {
  const zip = committeeBundle();
  const plan = await buildImportPlan(planDb(), zip, { format: CLUB_FORMAT_TEST, mode });
  return applyConfigImport({
    format: CLUB_FORMAT_TEST,
    prisma,
    bundleBytes: zip,
    actorMemberId: "admin-1",
    expectedFingerprint: plan.fingerprint,
    mode,
  });
}

describe("config import pre-apply backup durability gate (ADR-002)", () => {
  beforeEach(() => {
    vi.mocked(runDatabaseBackup).mockReset();
    vi.mocked(createAuditLog).mockClear();
  });

  it("refuses an overwrite import when the backup is local-only, before any write", async () => {
    vi.mocked(runDatabaseBackup).mockResolvedValue(LOCAL_ONLY_BACKUP);
    const { prisma, create, update, $transaction } = applyHarness();

    await expect(applyWith(prisma, "overwrite")).rejects.toThrow(
      ConfigImportBackupError,
    );
    // Operator-actionable: names the missing durable destination.
    await expect(applyWith(prisma, "overwrite")).rejects.toThrow(
      /S3 destination in Admin -> Backups/,
    );

    // The gate fires BEFORE the destructive transaction: nothing was written.
    expect($transaction).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it("refuses a merge import too — merge still creates and updates rows", async () => {
    vi.mocked(runDatabaseBackup).mockResolvedValue(LOCAL_ONLY_BACKUP);
    const { prisma, create, $transaction } = applyHarness();

    await expect(applyWith(prisma, "merge")).rejects.toThrow(
      ConfigImportBackupError,
    );
    expect($transaction).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it("proceeds when the backup is durable, and audits the durability", async () => {
    vi.mocked(runDatabaseBackup).mockResolvedValue(DURABLE_BACKUP);
    const { prisma, create } = applyHarness();

    const result = await applyWith(prisma, "overwrite");

    expect(create).toHaveBeenCalledTimes(1);
    expect(result.totals.created).toBe(1);
    expect(result.backup).toEqual({ attempted: true, skipped: false });

    // The audit record states the ACTUAL durability, not just "not skipped".
    expect(createAuditLog).toHaveBeenCalledTimes(1);
    const { metadata } = vi.mocked(createAuditLog).mock.calls[0][0];
    expect((metadata as Record<string, unknown>).backup).toEqual({
      skipped: false,
      uploadedToS3: true,
      s3Key: "tacbookings_s3backup/tacbookings-x.sql.gz",
    });
  });

  it("keeps the operator opt-out: a skipped backup (backups disabled) still applies, audited as non-durable", async () => {
    vi.mocked(runDatabaseBackup).mockResolvedValue({
      success: false,
      skipped: true,
      reason: "Backups are disabled. Enable them on Admin → Backups.",
    });
    const { prisma, create } = applyHarness();

    const result = await applyWith(prisma, "overwrite");

    expect(create).toHaveBeenCalledTimes(1);
    expect(result.backup).toEqual({ attempted: true, skipped: true });
    const { metadata } = vi.mocked(createAuditLog).mock.calls[0][0];
    expect((metadata as Record<string, unknown>).backup).toEqual({
      skipped: true,
      uploadedToS3: false,
    });
  });

  it("still hard-fails a backup that errored outright", async () => {
    vi.mocked(runDatabaseBackup).mockResolvedValue({
      success: false,
      error: "pg_dump failed: boom",
    });
    const { prisma, $transaction } = applyHarness();

    await expect(applyWith(prisma, "overwrite")).rejects.toThrow(
      ConfigImportBackupError,
    );
    expect($transaction).not.toHaveBeenCalled();
  });
});
