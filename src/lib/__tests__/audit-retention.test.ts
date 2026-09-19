import { beforeEach, describe, expect, it, vi } from "vitest";
import { matchesWhere } from "@/lib/__tests__/support/prisma-where";

const mocks = vi.hoisted(() => ({
  updateMany: vi.fn(),
  deleteMany: vi.fn(),
  findMany: vi.fn(),
  loggerInfo: vi.fn(),
  loggerWarn: vi.fn(),
  loggerError: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    auditLog: {
      updateMany: mocks.updateMany,
      deleteMany: mocks.deleteMany,
      findMany: mocks.findMany,
    },
  },
}));

vi.mock("@/lib/logger", () => ({
  default: {
    info: mocks.loggerInfo,
    warn: mocks.loggerWarn,
    error: mocks.loggerError,
  },
}));

import {
  anonymizeExpiredAuditRequestData,
  archiveEligibleAuditLogs,
  getAuditLogRetentionCutoffs,
  isAuditLogArchivable,
  isAuditLogRetentionCritical,
  pruneAuditArchive,
  pruneExpiredAuditLogs,
  runAuditLogRetentionJob,
} from "@/lib/audit-retention";

function mockDb() {
  return {
    auditLog: {
      updateMany: mocks.updateMany,
      deleteMany: mocks.deleteMany,
      findMany: mocks.findMany,
    },
  };
}

function mockArchiveDb() {
  return {
    $executeRaw: vi.fn().mockResolvedValue(1),
    $executeRawUnsafe: vi.fn().mockResolvedValue(0),
    $disconnect: vi.fn().mockResolvedValue(undefined),
  };
}

function archiveRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "audit-1",
    action: "admin.member.view",
    memberId: "admin-1",
    targetId: "member-1",
    details: "Viewed member cardNumber=4242 4242 4242 4242",
    ipAddress: "203.0.113.10",
    createdAt: new Date("2024-01-01T00:00:00.000Z"),
    actorMemberId: "admin-1",
    subjectMemberId: "member-1",
    entityType: "Member",
    entityId: "member-1",
    category: "admin",
    severity: "info",
    outcome: "success",
    summary: "Viewed member profile",
    metadata: {
      rawBody: { token: "secret" },
      changedFields: ["email"],
      safeCardReference: "4242 4242 4242 4242",
    },
    requestId: "req-1",
    userAgent: "Vitest",
    retentionClass: "sensitive_access",
    expiresAt: new Date("2026-01-01T00:00:00.000Z"),
    archivedAt: null,
    incidentPreserved: false,
    ...overrides,
  };
}

// #2506: the prune test asserts WHICH rows actually survive — not merely the
// query shape — by applying the real `where` to an in-memory table through the
// shared `matchesWhere` (#3434). Removing the archive gate then reddens a test
// by showing an unarchived row genuinely deleted (the data loss the gate exists
// to prevent).
//
// `severity` is REQUIRED on a fixture row, not optional as it once was. The
// prune's unclassified branch is `NOT: { severity: "critical" }` and
// `AuditLog.severity` is nullable: PostgreSQL evaluates `NOT (NULL = 'critical')`
// to unknown and RETAINS a null-severity row, where the hand-rolled evaluator this
// replaced (`value !== cond`) would have deleted it. The shared evaluator throws
// on that negation rather than answer either way, so every row here names its
// severity explicitly; whether the production predicate in `audit-retention.ts`
// should prune a null-severity unclassified row is a question for that module,
// not for this fixture.
type PruneRow = {
  id: string;
  retentionClass: string | null;
  severity: string | null;
  createdAt: Date;
  expiresAt: Date | null;
  archivedAt: Date | null;
};

function makeFakeAuditDb(rows: PruneRow[]) {
  const state = [...rows];
  return {
    db: {
      auditLog: {
        updateMany: async () => ({ count: 0 }),
        findMany: async () => [],
        deleteMany: async ({ where }: { where: Record<string, unknown> }) => {
          const doomed = state.filter((row) => matchesWhere(row, where));
          for (const row of doomed) {
            state.splice(state.indexOf(row), 1);
          }
          return { count: doomed.length };
        },
      },
    },
    remainingIds: () => state.map((row) => row.id),
  };
}

describe("audit retention lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.AUDIT_ARCHIVE_DATABASE_URL;
    delete process.env.AUDIT_LOG_ARCHIVE_DATABASE_URL;
    mocks.updateMany.mockResolvedValue({ count: 0 });
    mocks.deleteMany.mockResolvedValue({ count: 0 });
    mocks.findMany.mockResolvedValue([]);
  });

  it("calculates policy cutoffs and classifies edge cases conservatively", () => {
    const now = new Date("2026-05-10T00:00:00.000Z");

    expect(getAuditLogRetentionCutoffs(now)).toEqual({
      requestData: new Date("2026-02-09T00:00:00.000Z"),
      archive: new Date("2025-05-10T00:00:00.000Z"),
      archivePrune: new Date("2019-05-10T00:00:00.000Z"),
      criticalMain: new Date("2019-05-10T00:00:00.000Z"),
    });
    expect(
      isAuditLogRetentionCritical({
        action: "admin.member.view",
        category: "admin",
      })
    ).toBe(false);
    expect(
      isAuditLogRetentionCritical({
        action: "privacy.data_export.downloaded",
        category: "privacy",
        severity: "critical",
      })
    ).toBe(true);
    expect(
      isAuditLogArchivable(
        {
          action: "admin.member.view",
          category: "admin",
          retentionClass: "sensitive_access",
          archivedAt: null,
          createdAt: new Date("2025-01-01T00:00:00.000Z"),
        },
        now
      )
    ).toBe(true);
    expect(
      isAuditLogArchivable(
        {
          action: "booking.confirmed",
          category: "booking",
          retentionClass: "critical",
          archivedAt: null,
          createdAt: new Date("2024-01-01T00:00:00.000Z"),
        },
        now
      )
    ).toBe(false);
    expect(
      isAuditLogArchivable(
        {
          action: "system.request.debug",
          category: "system",
          retentionClass: "diagnostic_high_volume",
          archivedAt: null,
          createdAt: new Date("2024-01-01T00:00:00.000Z"),
        },
        now
      )
    ).toBe(false);
  });

  it("purges raw IP address and user-agent after 90 days unless incident-preserved", async () => {
    mocks.updateMany.mockResolvedValue({ count: 3 });
    const now = new Date("2026-05-10T00:00:00.000Z");

    const result = await anonymizeExpiredAuditRequestData(mockDb() as never, now);

    expect(result).toEqual({
      cutoff: new Date("2026-02-09T00:00:00.000Z"),
      anonymized: 3,
    });
    expect(mocks.updateMany).toHaveBeenCalledWith({
      where: {
        createdAt: { lt: new Date("2026-02-09T00:00:00.000Z") },
        incidentPreserved: false,
        OR: [{ ipAddress: { not: null } }, { userAgent: { not: null } }],
      },
      data: {
        ipAddress: null,
        userAgent: null,
      },
    });
  });

  it("safely skips archive movement and pruning when archive DB is not configured", async () => {
    const now = new Date("2026-05-10T00:00:00.000Z");

    const result = await runAuditLogRetentionJob({
      db: mockDb() as never,
      archiveDatabaseUrl: null,
      now,
    });

    expect(result.archive).toMatchObject({
      configured: false,
      skipped: true,
      reason: "archive-db-not-configured",
      archived: 0,
      deletedFromMain: 0,
    });
    expect(result.archivePrune).toMatchObject({
      configured: false,
      skipped: true,
      reason: "archive-db-not-configured",
      pruned: 0,
    });
    expect(mocks.findMany).not.toHaveBeenCalled();
    expect(mocks.loggerInfo).toHaveBeenCalledWith(
      { job: "audit-retention", reason: "archive-db-not-configured" },
      "Audit archive skipped because no archive database is configured"
    );
  });

  it("archives eligible non-critical rows and removes them from the main DB", async () => {
    const now = new Date("2026-05-10T00:00:00.000Z");
    const archiveDb = mockArchiveDb();
    mocks.findMany.mockResolvedValue([
      archiveRow({ id: "audit-1" }),
      archiveRow({
        id: "audit-2",
        incidentPreserved: true,
        ipAddress: "198.51.100.5",
        userAgent: "Incident UA",
      }),
    ]);
    mocks.deleteMany.mockResolvedValue({ count: 2 });

    const result = await archiveEligibleAuditLogs(
      mockDb() as never,
      archiveDb,
      now,
      25
    );

    expect(result).toMatchObject({
      configured: true,
      skipped: false,
      selected: 2,
      archived: 2,
      deletedFromMain: 2,
    });
    expect(mocks.findMany).toHaveBeenCalledWith({
      where: {
        createdAt: { lt: new Date("2025-05-10T00:00:00.000Z") },
        archivedAt: null,
        retentionClass: { in: ["sensitive_access", "standard"] },
      },
      orderBy: { createdAt: "asc" },
      take: 25,
      select: expect.objectContaining({
        incidentPreserved: true,
        metadata: true,
        userAgent: true,
      }),
    });
    expect(mocks.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ["audit-1", "audit-2"] } },
    });

    const firstInsert = archiveDb.$executeRaw.mock.calls[0][0] as {
      values: unknown[];
    };
    expect(firstInsert.values[4]).toContain("cardNumber=[REDACTED]");
    expect(firstInsert.values[5]).toBeNull();
    expect(firstInsert.values[15]).toContain('"rawBody":"[REDACTED]"');
    expect(firstInsert.values[15]).toContain("[REDACTED_CARD]");
    expect(firstInsert.values[17]).toBeNull();

    const secondInsert = archiveDb.$executeRaw.mock.calls[1][0] as {
      values: unknown[];
    };
    expect(secondInsert.values[5]).toBe("198.51.100.5");
    expect(secondInsert.values[17]).toBe("Incident UA");
  });

  it("keeps critical records guarded by a 7-year main DB retention cutoff", async () => {
    const now = new Date("2026-05-10T00:00:00.000Z");
    mocks.deleteMany.mockResolvedValue({ count: 4 });

    const result = await pruneExpiredAuditLogs(mockDb() as never, now);

    expect(result).toEqual({
      cutoff: new Date("2019-05-10T00:00:00.000Z"),
      deleted: 4,
    });
    expect(mocks.deleteMany).toHaveBeenCalledWith({
      where: {
        OR: expect.arrayContaining([
          {
            retentionClass: "critical",
            createdAt: { lt: new Date("2019-05-10T00:00:00.000Z") },
            expiresAt: { lt: now },
          },
        ]),
      },
    });
  });

  it("prunes archive rows older than 7 years", async () => {
    const now = new Date("2026-05-10T00:00:00.000Z");
    const archiveDb = mockArchiveDb();
    archiveDb.$executeRaw.mockResolvedValue(9);

    const result = await pruneAuditArchive(archiveDb, now);

    expect(result).toEqual({
      configured: true,
      skipped: false,
      cutoff: new Date("2019-05-10T00:00:00.000Z"),
      pruned: 9,
    });
    const pruneQuery = archiveDb.$executeRaw.mock.calls[0][0] as {
      strings: string[];
      values: unknown[];
    };
    expect(pruneQuery.strings.join("")).toContain(
      'DELETE FROM "AuditLogArchive"'
    );
    expect(pruneQuery.values).toEqual([
      new Date("2019-05-10T00:00:00.000Z"),
    ]);
  });

  // -------------------------------------------------------------------------
  // #2506 — prune must NEVER outrun archival. The archive captures 500 rows a
  // night; a sustained high-volume club could otherwise have an expired-but-
  // unarchived row deleted before the archive ever received it.
  // -------------------------------------------------------------------------
  describe("prune archive gate", () => {
    const now = new Date("2026-05-10T00:00:00.000Z");

    // sensitive_access expires at createdAt + 24 months; a row created in early
    // 2023 is both archive-eligible (>12 months old) and expired by `now`, so it
    // is exactly the row a 500/night archive backlog can strand.
    function unarchivedExpiredSensitive(overrides: Partial<PruneRow> = {}): PruneRow {
      return {
        id: "sensitive-unarchived",
        retentionClass: "sensitive_access",
        severity: "info",
        createdAt: new Date("2023-01-01T00:00:00.000Z"),
        expiresAt: new Date("2025-01-01T00:00:00.000Z"),
        archivedAt: null,
        ...overrides,
      };
    }

    it("retains an expired but unarchived archivable row while the archive is active", async () => {
      const fake = makeFakeAuditDb([unarchivedExpiredSensitive()]);

      const result = await pruneExpiredAuditLogs(fake.db as never, now, {
        archiveActive: true,
      });

      // The row is expired, but not yet archived: prune must leave it alone.
      // Delete the `archivedAt: { not: null }` gate in pruneExpiredAuditLogs and
      // this reddens with the unarchived row pruned — i.e. silent data loss.
      expect(result.deleted).toBe(0);
      expect(fake.remainingIds()).toEqual(["sensitive-unarchived"]);
    });

    it("prunes the same archivable row once it is provably archived", async () => {
      const fake = makeFakeAuditDb([
        unarchivedExpiredSensitive({
          id: "sensitive-archived",
          archivedAt: new Date("2024-02-01T00:00:00.000Z"),
        }),
      ]);

      const result = await pruneExpiredAuditLogs(fake.db as never, now, {
        archiveActive: true,
      });

      // Proves the gate keys on the durable `archivedAt` marker, not a blanket
      // class exclusion: an archived copy exists, so the source row may go.
      expect(result.deleted).toBe(1);
      expect(fake.remainingIds()).toEqual([]);
    });

    it("prunes an expired unarchived archivable row by expiry when NO archive is configured", async () => {
      const fake = makeFakeAuditDb([unarchivedExpiredSensitive()]);

      const result = await pruneExpiredAuditLogs(fake.db as never, now, {
        archiveActive: false,
      });

      // No archive to protect the row and nowhere for the data to go, so data
      // minimisation still deletes it at expiry. A gate applied unconditionally
      // would over-retain forever and redden here.
      expect(result.deleted).toBe(1);
      expect(fake.remainingIds()).toEqual([]);
    });

    it("always prunes expired diagnostic_high_volume and unclassified rows even with the archive active", async () => {
      const fake = makeFakeAuditDb([
        {
          id: "diagnostic",
          retentionClass: "diagnostic_high_volume",
          severity: "info",
          createdAt: new Date("2025-01-01T00:00:00.000Z"),
          expiresAt: new Date("2025-04-01T00:00:00.000Z"),
          archivedAt: null,
        },
        {
          id: "legacy-null",
          retentionClass: null,
          severity: "info",
          createdAt: new Date("2024-01-01T00:00:00.000Z"),
          expiresAt: new Date("2025-01-01T00:00:00.000Z"),
          archivedAt: null,
        },
        unarchivedExpiredSensitive(),
      ]);

      const result = await pruneExpiredAuditLogs(fake.db as never, now, {
        archiveActive: true,
      });

      // The gate is scoped to the archivable classes only: never-archived rows
      // still prune on expiry, while the unarchived archivable row survives.
      expect(result.deleted).toBe(2);
      expect(fake.remainingIds()).toEqual(["sensitive-unarchived"]);
    });

    it("gates the job's main prune on archival when an archive DB is configured", async () => {
      const archiveDb = mockArchiveDb();

      const result = await runAuditLogRetentionJob({
        db: mockDb() as never,
        archiveDb,
        now,
      });

      expect(result.archive.configured).toBe(true);
      // findMany returns [] this run, so the archive step deletes nothing and the
      // only deleteMany is the main prune — assert it carries the archive gate.
      expect(mocks.deleteMany).toHaveBeenCalledTimes(1);
      expect(mocks.deleteMany).toHaveBeenCalledWith({
        where: {
          OR: expect.arrayContaining([
            {
              retentionClass: { in: ["sensitive_access", "standard"] },
              expiresAt: { lt: now },
              archivedAt: { not: null },
            },
          ]),
        },
      });
    });

    it("leaves the job's main prune ungated when no archive DB is configured", async () => {
      const result = await runAuditLogRetentionJob({
        db: mockDb() as never,
        archiveDatabaseUrl: null,
        now,
      });

      expect(result.archive.configured).toBe(false);
      // Without an archive, the archivable clause carries no archivedAt gate.
      expect(mocks.deleteMany).toHaveBeenCalledWith({
        where: {
          OR: expect.arrayContaining([
            {
              retentionClass: { in: ["sensitive_access", "standard"] },
              expiresAt: { lt: now },
            },
          ]),
        },
      });
    });

    it("keeps the nightly archive batch bounded at 500 rows by default", async () => {
      const archiveDb = mockArchiveDb();

      await archiveEligibleAuditLogs(mockDb() as never, archiveDb, now);

      // The bounded batch is what makes the gate necessary; assert it stays 500.
      expect(mocks.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 500 })
      );
    });

    it("warns of an archive backlog when the nightly batch comes back full", async () => {
      // A full batch means more archivable rows remain unarchived this run. Since
      // the #2506 gate now retains their expired members past the retention
      // window, that over-retention would otherwise be silent — assert the warn.
      mocks.findMany.mockResolvedValueOnce([
        archiveRow(),
        archiveRow({ id: "audit-2" }),
      ]);
      const archiveDb = mockArchiveDb();

      await archiveEligibleAuditLogs(mockDb() as never, archiveDb, now, 2);

      // Drop the `rows.length === batchSize` warn and this reddens — the drift
      // signal disappears.
      expect(mocks.loggerWarn).toHaveBeenCalledWith(
        expect.objectContaining({ reason: "archive-backlog", batchSize: 2 }),
        expect.stringContaining("Audit archive batch was full")
      );
    });

    it("stays silent when the nightly batch is not full (archive is keeping up)", async () => {
      mocks.findMany.mockResolvedValueOnce([archiveRow()]);
      const archiveDb = mockArchiveDb();

      await archiveEligibleAuditLogs(mockDb() as never, archiveDb, now, 2);

      // One row against a batch cap of two: no backlog, so no spurious warning.
      // A warn keyed on anything looser than a full batch would redden here.
      expect(mocks.loggerWarn).not.toHaveBeenCalled();
    });
  });
});
