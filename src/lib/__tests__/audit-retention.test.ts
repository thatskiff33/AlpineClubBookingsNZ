import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  updateMany: vi.fn(),
  deleteMany: vi.fn(),
  findMany: vi.fn(),
  loggerInfo: vi.fn(),
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
});
