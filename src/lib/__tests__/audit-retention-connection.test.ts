/**
 * #4453: which connection the audit retention job maintains `AuditLog` through.
 *
 * Under the least-privilege roles the application role may only INSERT and
 * SELECT audit rows, so the anonymisation UPDATE and the archive/prune DELETEs
 * run on `AUDIT_RETENTION_DATABASE_URL` when it is set. Unset, nothing changes:
 * the job uses the application client, as every deployment did before. The
 * client it builds is built the way the archive client is — one helper, the same
 * adapter and the same global omission (`INV-SSOT`, `INV-PRIV-022`).
 *
 * The real-PostgreSQL half (the role really can do this, and the application
 * role really cannot) is `database-roles.realdb.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AUDIT_ANONYMISED_REQUEST_COLUMNS } from "@/lib/audit-retention-classes";
import { PRISMA_CLIENT_GLOBAL_OMIT } from "@/lib/prisma-global-omit";

const mocks = vi.hoisted(() => {
  const appClient = {
    auditLog: {
      updateMany: vi.fn(async () => ({ count: 0 })),
      deleteMany: vi.fn(async () => ({ count: 0 })),
      findMany: vi.fn(async () => []),
    },
  };
  const constructed: Array<{ options: unknown; client: Record<string, unknown> }> = [];
  return {
    appClient,
    constructed,
    adapterFor: vi.fn((url: string) => ({ adapterFor: url })),
    loggerInfo: vi.fn(),
  };
});

vi.mock("@/lib/prisma", () => ({ prisma: mocks.appClient }));
vi.mock("@/lib/logger", () => ({
  default: { info: mocks.loggerInfo, warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@/lib/prisma-adapter", () => ({ createPrismaPgAdapter: mocks.adapterFor }));
vi.mock("@prisma/client", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("@prisma/client");
  class FakePrismaClient {
    auditLog = {
      updateMany: vi.fn(async () => ({ count: 2 })),
      deleteMany: vi.fn(async () => ({ count: 3 })),
      findMany: vi.fn(async () => []),
    };
    $executeRaw = vi.fn(async () => 0);
    $executeRawUnsafe = vi.fn(async () => 0);
    $disconnect = vi.fn(async () => {});
    constructor(options: unknown) {
      mocks.constructed.push({ options, client: this as unknown as Record<string, unknown> });
    }
  }
  return { ...actual, PrismaClient: FakePrismaClient };
});

import { runAuditLogRetentionJob } from "@/lib/audit-retention";

const NOW = new Date("2026-07-01T00:00:00.000Z");
const RETENTION_URL = "postgresql://tac_audit_retention:pw@postgres:5432/tacbookings?connection_limit=2";
const ARCHIVE_URL = "postgresql://archive:pw@archive:5432/audit_archive";

type FakeClient = {
  auditLog: Record<"updateMany" | "deleteMany" | "findMany", ReturnType<typeof vi.fn>>;
  $disconnect: ReturnType<typeof vi.fn>;
};

function constructedFor(url: string): FakeClient {
  const index = mocks.adapterFor.mock.calls.findIndex(([called]) => called === url);
  expect(index, `no client was built for ${url}`).toBeGreaterThanOrEqual(0);
  return mocks.constructed[index].client as unknown as FakeClient;
}

describe("audit retention connection (#4453)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.constructed.length = 0;
    vi.stubEnv("AUDIT_RETENTION_DATABASE_URL", "");
    vi.stubEnv("AUDIT_ARCHIVE_DATABASE_URL", "");
    vi.stubEnv("AUDIT_LOG_ARCHIVE_DATABASE_URL", "");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("falls back to the application client when AUDIT_RETENTION_DATABASE_URL is unset", async () => {
    await runAuditLogRetentionJob({ now: NOW });

    expect(mocks.constructed).toHaveLength(0);
    expect(mocks.appClient.auditLog.updateMany).toHaveBeenCalledTimes(1);
    expect(mocks.appClient.auditLog.deleteMany).toHaveBeenCalledTimes(1);
  });

  it("treats a blank AUDIT_RETENTION_DATABASE_URL as unset", async () => {
    vi.stubEnv("AUDIT_RETENTION_DATABASE_URL", "   ");
    await runAuditLogRetentionJob({ now: NOW });

    expect(mocks.constructed).toHaveLength(0);
    expect(mocks.appClient.auditLog.updateMany).toHaveBeenCalledTimes(1);
  });

  it("maintains AuditLog through a client built from AUDIT_RETENTION_DATABASE_URL, and never the app client", async () => {
    vi.stubEnv("AUDIT_RETENTION_DATABASE_URL", RETENTION_URL);
    const result = await runAuditLogRetentionJob({ now: NOW });

    const retention = constructedFor(RETENTION_URL);
    expect(retention.auditLog.updateMany).toHaveBeenCalledTimes(1);
    expect(retention.auditLog.deleteMany).toHaveBeenCalledTimes(1);
    expect(result.requestData.anonymized).toBe(2);
    expect(result.mainPrune.deleted).toBe(3);
    expect(mocks.appClient.auditLog.updateMany).not.toHaveBeenCalled();
    expect(mocks.appClient.auditLog.deleteMany).not.toHaveBeenCalled();
    expect(retention.$disconnect).toHaveBeenCalledTimes(1);
  });

  it("builds the retention client the way it builds the archive client: same adapter seam, same global omission", async () => {
    vi.stubEnv("AUDIT_RETENTION_DATABASE_URL", RETENTION_URL);
    vi.stubEnv("AUDIT_ARCHIVE_DATABASE_URL", ARCHIVE_URL);
    await runAuditLogRetentionJob({ now: NOW });

    expect(mocks.adapterFor.mock.calls.map(([url]) => url).sort()).toEqual(
      [ARCHIVE_URL, RETENTION_URL].sort(),
    );
    for (const { options } of mocks.constructed) {
      expect(options).toEqual({
        adapter: expect.any(Object),
        omit: PRISMA_CLIENT_GLOBAL_OMIT,
      });
    }
    // The archive's rows are read from, and deleted through, the retention client.
    expect(constructedFor(RETENTION_URL).auditLog.findMany).toHaveBeenCalledTimes(1);
    expect(constructedFor(ARCHIVE_URL).$disconnect).toHaveBeenCalledTimes(1);
  });

  it("disconnects the retention client when a step fails", async () => {
    vi.stubEnv("AUDIT_RETENTION_DATABASE_URL", RETENTION_URL);
    const failing = runAuditLogRetentionJob({
      now: NOW,
      archiveDb: {
        $executeRaw: vi.fn(async () => 0),
        $executeRawUnsafe: vi.fn(async () => {
          throw new Error("archive schema drifted");
        }),
      },
    });
    await expect(failing).rejects.toThrow(/archive schema drifted/);
    expect(constructedFor(RETENTION_URL).$disconnect).toHaveBeenCalledTimes(1);
  });

  it("an explicit db wins over the environment, and builds no client", async () => {
    vi.stubEnv("AUDIT_RETENTION_DATABASE_URL", RETENTION_URL);
    const db = {
      auditLog: {
        updateMany: vi.fn(async () => ({ count: 0 })),
        deleteMany: vi.fn(async () => ({ count: 0 })),
        findMany: vi.fn(async () => []),
      },
    };
    await runAuditLogRetentionJob({ now: NOW, db });

    expect(mocks.constructed).toHaveLength(0);
    expect(db.auditLog.updateMany).toHaveBeenCalledTimes(1);
  });

  it("retentionDatabaseUrl: null opts out of the environment variable", async () => {
    vi.stubEnv("AUDIT_RETENTION_DATABASE_URL", RETENTION_URL);
    await runAuditLogRetentionJob({ now: NOW, retentionDatabaseUrl: null });

    expect(mocks.constructed).toHaveLength(0);
    expect(mocks.appClient.auditLog.updateMany).toHaveBeenCalledTimes(1);
  });

  it("clears exactly the columns the audit-retention role may UPDATE", async () => {
    await runAuditLogRetentionJob({ now: NOW });

    const [{ data, where }] = mocks.appClient.auditLog.updateMany.mock.calls[0] as unknown as [
      { data: Record<string, unknown>; where: { OR: Array<Record<string, unknown>> } },
    ];
    expect(Object.keys(data).sort()).toEqual([...AUDIT_ANONYMISED_REQUEST_COLUMNS].sort());
    expect(Object.values(data).every((value) => value === null)).toBe(true);
    expect(where.OR.flatMap((clause) => Object.keys(clause)).sort()).toEqual(
      [...AUDIT_ANONYMISED_REQUEST_COLUMNS].sort(),
    );
  });
});
