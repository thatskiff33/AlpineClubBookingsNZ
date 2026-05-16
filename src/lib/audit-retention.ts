import { Prisma, PrismaClient } from "@prisma/client";
import { createPrismaPgAdapter } from "@/lib/prisma-adapter";
import {
  type AuditCategory,
  type AuditRetentionClass,
  type AuditSeverity,
  classifyAuditRetention,
  sanitizeAuditArchiveText,
  sanitizeAuditMetadata,
} from "@/lib/audit";
import logger from "@/lib/logger";
import { prisma } from "@/lib/prisma";

const RAW_REQUEST_DATA_RETENTION_DAYS = 90;
const ARCHIVE_AFTER_MONTHS = 12;
const ARCHIVE_PRUNE_AFTER_YEARS = 7;
const CRITICAL_MAIN_RETENTION_YEARS = 7;
const DEFAULT_ARCHIVE_BATCH_SIZE = 500;
const ARCHIVABLE_RETENTION_CLASSES: AuditRetentionClass[] = [
  "sensitive_access",
  "standard",
];

const auditArchiveSelect = {
  id: true,
  action: true,
  memberId: true,
  targetId: true,
  details: true,
  ipAddress: true,
  createdAt: true,
  actorMemberId: true,
  subjectMemberId: true,
  entityType: true,
  entityId: true,
  category: true,
  severity: true,
  outcome: true,
  summary: true,
  metadata: true,
  requestId: true,
  userAgent: true,
  retentionClass: true,
  expiresAt: true,
  archivedAt: true,
  incidentPreserved: true,
} satisfies Prisma.AuditLogSelect;

type AuditArchiveRow = Prisma.AuditLogGetPayload<{
  select: typeof auditArchiveSelect;
}>;

type AuditRetentionDbClient = {
  auditLog: {
    updateMany(
      args: Prisma.AuditLogUpdateManyArgs
    ): Promise<Prisma.BatchPayload>;
    deleteMany(
      args: Prisma.AuditLogDeleteManyArgs
    ): Promise<Prisma.BatchPayload>;
    findMany(args: Prisma.AuditLogFindManyArgs): Promise<AuditArchiveRow[]>;
  };
};

export type AuditArchiveDbClient = {
  $executeRaw(query: Prisma.Sql): Promise<number>;
  $executeRawUnsafe(query: string): Promise<number>;
  $disconnect?(): Promise<void>;
};

export type AuditLogRetentionJobResult = {
  requestData: {
    cutoff: Date;
    anonymized: number;
  };
  archive: {
    configured: boolean;
    skipped: boolean;
    reason?: string;
    cutoff: Date;
    selected: number;
    archived: number;
    deletedFromMain: number;
  };
  mainPrune: {
    cutoff: Date;
    deleted: number;
  };
  archivePrune: {
    configured: boolean;
    skipped: boolean;
    reason?: string;
    cutoff: Date;
    pruned: number;
  };
};

type AuditLogRetentionJobOptions = {
  db?: AuditRetentionDbClient;
  archiveDb?: AuditArchiveDbClient;
  archiveDatabaseUrl?: string | null;
  now?: Date;
  batchSize?: number;
};

function readEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value || undefined;
}

function addUtcMonths(date: Date, months: number): Date {
  const next = new Date(date);
  next.setUTCMonth(next.getUTCMonth() + months);
  return next;
}

function addUtcYears(date: Date, years: number): Date {
  const next = new Date(date);
  next.setUTCFullYear(next.getUTCFullYear() + years);
  return next;
}

function addUtcDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function resolveArchiveDatabaseUrl(
  options: AuditLogRetentionJobOptions
): string | undefined {
  if (Object.prototype.hasOwnProperty.call(options, "archiveDatabaseUrl")) {
    return options.archiveDatabaseUrl?.trim() || undefined;
  }
  return (
    readEnv("AUDIT_ARCHIVE_DATABASE_URL") ??
    readEnv("AUDIT_LOG_ARCHIVE_DATABASE_URL")
  );
}

function createArchiveClient(databaseUrl: string): PrismaClient {
  return new PrismaClient({
    adapter: createPrismaPgAdapter(databaseUrl),
  });
}

export function getAuditLogRetentionCutoffs(now = new Date()) {
  return {
    requestData: addUtcDays(now, -RAW_REQUEST_DATA_RETENTION_DAYS),
    archive: addUtcMonths(now, -ARCHIVE_AFTER_MONTHS),
    archivePrune: addUtcYears(now, -ARCHIVE_PRUNE_AFTER_YEARS),
    criticalMain: addUtcYears(now, -CRITICAL_MAIN_RETENTION_YEARS),
  };
}

export function isAuditLogRetentionCritical(input: {
  action: string;
  category?: string | null;
  severity?: string | null;
  retentionClass?: string | null;
}): boolean {
  if (input.retentionClass) {
    return input.retentionClass === "critical";
  }
  if (input.severity === "critical") {
    return true;
  }

  return (
    classifyAuditRetention({
      action: input.action,
      category: input.category as AuditCategory | null | undefined,
      severity: input.severity as AuditSeverity | null | undefined,
    }) === "critical"
  );
}

export function isAuditLogArchivable(input: {
  action: string;
  category?: string | null;
  severity?: string | null;
  retentionClass?: string | null;
  archivedAt?: Date | null;
  createdAt: Date;
}, now = new Date()): boolean {
  if (input.archivedAt || input.createdAt >= getAuditLogRetentionCutoffs(now).archive) {
    return false;
  }

  if (!input.retentionClass) {
    return false;
  }

  return ARCHIVABLE_RETENTION_CLASSES.includes(
    input.retentionClass as AuditRetentionClass
  );
}

export async function anonymizeExpiredAuditRequestData(
  db: AuditRetentionDbClient = prisma,
  now = new Date()
): Promise<{ cutoff: Date; anonymized: number }> {
  const { requestData: cutoff } = getAuditLogRetentionCutoffs(now);
  const { count } = await db.auditLog.updateMany({
    where: {
      createdAt: { lt: cutoff },
      incidentPreserved: false,
      OR: [{ ipAddress: { not: null } }, { userAgent: { not: null } }],
    },
    data: {
      ipAddress: null,
      userAgent: null,
    },
  });

  return { cutoff, anonymized: count };
}

async function ensureAuditArchiveSchema(
  archiveDb: AuditArchiveDbClient
): Promise<void> {
  await archiveDb.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "AuditLogArchive" (
      "id" TEXT PRIMARY KEY,
      "action" TEXT NOT NULL,
      "memberId" TEXT,
      "targetId" TEXT,
      "details" TEXT,
      "ipAddress" TEXT,
      "createdAt" TIMESTAMP(3) NOT NULL,
      "actorMemberId" TEXT,
      "subjectMemberId" TEXT,
      "entityType" TEXT,
      "entityId" TEXT,
      "category" TEXT,
      "severity" TEXT,
      "outcome" TEXT,
      "summary" TEXT,
      "metadata" JSONB,
      "requestId" TEXT,
      "userAgent" TEXT,
      "retentionClass" TEXT,
      "expiresAt" TIMESTAMP(3),
      "archivedAt" TIMESTAMP(3) NOT NULL,
      "incidentPreserved" BOOLEAN NOT NULL DEFAULT false
    )
  `);
  await archiveDb.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS "AuditLogArchive_createdAt_idx"
    ON "AuditLogArchive"("createdAt")
  `);
  await archiveDb.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS "AuditLogArchive_subjectMemberId_createdAt_idx"
    ON "AuditLogArchive"("subjectMemberId", "createdAt")
  `);
  await archiveDb.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS "AuditLogArchive_retentionClass_createdAt_idx"
    ON "AuditLogArchive"("retentionClass", "createdAt")
  `);
}

function sanitizeArchiveMetadata(
  metadata: Prisma.JsonValue | null
): string | null {
  if (metadata === null) {
    return null;
  }
  const sanitized = sanitizeAuditMetadata(metadata);
  return sanitized === undefined ? null : JSON.stringify(sanitized);
}

async function insertAuditArchiveRow(
  archiveDb: AuditArchiveDbClient,
  row: AuditArchiveRow,
  archivedAt: Date
): Promise<number> {
  const preserveRequestData = row.incidentPreserved;
  const metadataJson = sanitizeArchiveMetadata(row.metadata);

  return archiveDb.$executeRaw(Prisma.sql`
    INSERT INTO "AuditLogArchive" (
      "id",
      "action",
      "memberId",
      "targetId",
      "details",
      "ipAddress",
      "createdAt",
      "actorMemberId",
      "subjectMemberId",
      "entityType",
      "entityId",
      "category",
      "severity",
      "outcome",
      "summary",
      "metadata",
      "requestId",
      "userAgent",
      "retentionClass",
      "expiresAt",
      "archivedAt",
      "incidentPreserved"
    )
    VALUES (
      ${row.id},
      ${row.action},
      ${row.memberId},
      ${row.targetId},
      ${sanitizeAuditArchiveText(row.details)},
      ${preserveRequestData ? sanitizeAuditArchiveText(row.ipAddress) : null},
      ${row.createdAt},
      ${row.actorMemberId},
      ${row.subjectMemberId},
      ${row.entityType},
      ${row.entityId},
      ${row.category},
      ${row.severity},
      ${row.outcome},
      ${sanitizeAuditArchiveText(row.summary)},
      ${metadataJson}::jsonb,
      ${row.requestId},
      ${preserveRequestData ? sanitizeAuditArchiveText(row.userAgent) : null},
      ${row.retentionClass},
      ${row.expiresAt},
      ${archivedAt},
      ${row.incidentPreserved}
    )
    ON CONFLICT ("id") DO NOTHING
  `);
}

export async function archiveEligibleAuditLogs(
  db: AuditRetentionDbClient,
  archiveDb: AuditArchiveDbClient | undefined,
  now: Date,
  batchSize = DEFAULT_ARCHIVE_BATCH_SIZE
): Promise<AuditLogRetentionJobResult["archive"]> {
  const { archive: cutoff } = getAuditLogRetentionCutoffs(now);
  if (!archiveDb) {
    logger.info(
      { job: "audit-retention", reason: "archive-db-not-configured" },
      "Audit archive skipped because no archive database is configured"
    );
    return {
      configured: false,
      skipped: true,
      reason: "archive-db-not-configured",
      cutoff,
      selected: 0,
      archived: 0,
      deletedFromMain: 0,
    };
  }

  await ensureAuditArchiveSchema(archiveDb);

  const rows = await db.auditLog.findMany({
    where: {
      createdAt: { lt: cutoff },
      archivedAt: null,
      retentionClass: { in: ARCHIVABLE_RETENTION_CLASSES },
    },
    orderBy: { createdAt: "asc" },
    take: batchSize,
    select: auditArchiveSelect,
  });

  const archivedIds: string[] = [];
  for (const row of rows) {
    await insertAuditArchiveRow(archiveDb, row, now);
    archivedIds.push(row.id);
  }

  let deletedFromMain = 0;
  if (archivedIds.length > 0) {
    const { count } = await db.auditLog.deleteMany({
      where: { id: { in: archivedIds } },
    });
    deletedFromMain = count;
  }

  return {
    configured: true,
    skipped: false,
    cutoff,
    selected: rows.length,
    archived: archivedIds.length,
    deletedFromMain,
  };
}

export async function pruneExpiredAuditLogs(
  db: AuditRetentionDbClient = prisma,
  now = new Date()
): Promise<{ cutoff: Date; deleted: number }> {
  const { criticalMain: cutoff } = getAuditLogRetentionCutoffs(now);
  const { count } = await db.auditLog.deleteMany({
    where: {
      OR: [
        {
          retentionClass: { in: ["sensitive_access", "diagnostic_high_volume", "standard"] },
          expiresAt: { lt: now },
        },
        {
          retentionClass: null,
          expiresAt: { lt: now },
          NOT: { severity: "critical" },
        },
        {
          retentionClass: "critical",
          createdAt: { lt: cutoff },
          expiresAt: { lt: now },
        },
        {
          retentionClass: null,
          severity: "critical",
          createdAt: { lt: cutoff },
          expiresAt: { lt: now },
        },
      ],
    },
  });

  return { cutoff, deleted: count };
}

export async function pruneAuditArchive(
  archiveDb: AuditArchiveDbClient | undefined,
  now = new Date()
): Promise<AuditLogRetentionJobResult["archivePrune"]> {
  const { archivePrune: cutoff } = getAuditLogRetentionCutoffs(now);
  if (!archiveDb) {
    return {
      configured: false,
      skipped: true,
      reason: "archive-db-not-configured",
      cutoff,
      pruned: 0,
    };
  }

  await ensureAuditArchiveSchema(archiveDb);
  const pruned = await archiveDb.$executeRaw(Prisma.sql`
    DELETE FROM "AuditLogArchive"
    WHERE "createdAt" < ${cutoff}
  `);

  return {
    configured: true,
    skipped: false,
    cutoff,
    pruned,
  };
}

export async function runAuditLogRetentionJob(
  options: AuditLogRetentionJobOptions = {}
): Promise<AuditLogRetentionJobResult> {
  const db = options.db ?? prisma;
  const now = options.now ?? new Date();
  const archiveDatabaseUrl = resolveArchiveDatabaseUrl(options);
  const createdArchiveDb =
    options.archiveDb ?? (archiveDatabaseUrl ? createArchiveClient(archiveDatabaseUrl) : undefined);

  try {
    const requestData = await anonymizeExpiredAuditRequestData(db, now);
    const archive = await archiveEligibleAuditLogs(
      db,
      createdArchiveDb,
      now,
      options.batchSize ?? DEFAULT_ARCHIVE_BATCH_SIZE
    );
    const mainPrune = await pruneExpiredAuditLogs(db, now);
    const archivePrune = await pruneAuditArchive(createdArchiveDb, now);

    logger.info(
      {
        job: "audit-retention",
        anonymized: requestData.anonymized,
        archived: archive.archived,
        deletedFromMain: archive.deletedFromMain + mainPrune.deleted,
        archivePruned: archivePrune.pruned,
        archiveConfigured: archive.configured,
      },
      "Audit log retention job complete"
    );

    return {
      requestData,
      archive,
      mainPrune,
      archivePrune,
    };
  } finally {
    if (!options.archiveDb && createdArchiveDb?.$disconnect) {
      await createdArchiveDb.$disconnect();
    }
  }
}
