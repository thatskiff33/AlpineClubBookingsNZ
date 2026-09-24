import { type AuditLog, Prisma, PrismaClient } from "@prisma/client";
import { createPrismaPgAdapter } from "@/lib/prisma-adapter";
import { PRISMA_CLIENT_GLOBAL_OMIT } from "@/lib/prisma-global-omit";
import {
  type AuditRetentionClass,
  type AuditSeverity,
  classifyAuditRetention,
  sanitizeAuditArchiveText,
  sanitizeAuditMetadata,
} from "@/lib/audit";
import { isAuditCategory } from "@/lib/audit-categories";
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

// ---------------------------------------------------------------------------
// Audit archive column manifest (#2290)
//
// Archived rows are DELETED from the main audit table, so any column the
// archive forgets is gone permanently. This manifest is the single source of
// truth for the three places that must never drift apart:
//
//   1. the Prisma `select` that reads eligible rows out of the main table,
//   2. the `CREATE TABLE` that provisions the archive table, and
//   3. the `INSERT` that writes each archived row.
//
// It is exhaustive by construction. The key type is derived from Prisma's
// generated `AuditLogScalarFieldEnum` — the AuditLog model's own column list —
// so adding a column to the model is a COMPILE ERROR here until that column is
// either archived or deliberately excluded with a reason. The old
// `satisfies Prisma.AuditLogSelect` only checked that the listed keys were
// *valid*, never that they were *complete*, so a new column was silently
// dropped on archival with nothing failing.
//
// `src/lib/__tests__/audit-archive-columns.test.ts` re-checks the same contract
// at runtime against the DMMF, because the `CREATE TABLE` and `INSERT` column
// lists are now derived from this one manifest rather than hand-maintained.
// ---------------------------------------------------------------------------

/** Every scalar column the AuditLog model declares, straight from the schema. */
type AuditLogColumn = keyof typeof Prisma.AuditLogScalarFieldEnum;

/**
 * Columns deliberately NOT copied into the archive, each mapped to the reason
 * it is dropped.
 *
 * Empty today: all 22 AuditLog columns are archived. Only add an entry when
 * dropping a column on archival is a deliberate decision, and write a reason
 * that explains it to a future maintainer reconstructing an incident from a
 * seven-year-old archive row — not "unused".
 */
export const AUDIT_ARCHIVE_EXCLUDED_COLUMNS = {} satisfies Partial<
  Record<AuditLogColumn, string>
>;

type ExcludedAuditLogColumn = keyof typeof AUDIT_ARCHIVE_EXCLUDED_COLUMNS;

/** Columns that must appear in the select, the CREATE TABLE, and the INSERT. */
type ArchivedAuditLogColumn = Exclude<AuditLogColumn, ExcludedAuditLogColumn>;

type AuditArchiveRow = Pick<AuditLog, ArchivedAuditLogColumn>;

type AuditArchiveInsertContext = {
  /**
   * When the archive copy is being written (the job's clock). This is not the
   * source row's own `archivedAt`, which is always null for an eligible row.
   */
  archivedAt: Date;
  /** Incident-preserved rows keep their raw request data through archival. */
  preserveRequestData: boolean;
};

type AuditArchiveColumnSpec<K extends ArchivedAuditLogColumn> = {
  /**
   * Column definition used verbatim by the archive `CREATE TABLE`.
   *
   * `NOT NULL` here describes a freshly provisioned archive only. An archive
   * database that predates the column is migrated by hand and adds it nullable
   * — see docs/AUDIT_RETENTION_ARCHIVE_RUNBOOK.md → "Adding a column to
   * AuditLog", step 2.
   */
  ddl: string;
  /** SQL cast appended to the bound parameter in the `INSERT`, e.g. `::jsonb`. */
  cast?: string;
  /**
   * Value written to the archive. Defaults to the source row's own value.
   *
   * Deliberately typed to the column's own model type rather than `unknown`:
   * in the old hand-written writer every bound value was syntactically the
   * row's own field, so a mismatch was impossible by construction. `unknown`
   * would let a transform return, say, an object for a `TEXT` column, which
   * the pg driver would silently stringify into a seven-year archive row whose
   * source row has already been deleted (#2290 review).
   */
  value?: (
    row: AuditArchiveRow,
    context: AuditArchiveInsertContext
  ) => AuditArchiveRow[K];
};

/** One spec per archived column, each bound to that column's own value type. */
type AuditArchiveManifest = {
  [K in ArchivedAuditLogColumn]: AuditArchiveColumnSpec<K>;
};

/**
 * The archive contract, in main-table column order. Order is load-bearing: the
 * `INSERT` column list and its bound values are both generated from this map's
 * key order, so they can never disagree.
 */
// Deliberately a plain annotated object literal, not `Object.freeze(...)`: the
// freeze overload makes TypeScript report a missing column as a bewildering
// `Type 'Function' is missing ...` overload failure, where the annotation alone
// reports the crisp `Property '<column>' is missing in type ... but required in
// type 'AuditArchiveManifest'`. That message is the whole point of the guard,
// so it wins over runtime immutability.
export const AUDIT_ARCHIVE_COLUMNS: AuditArchiveManifest = {
  id: { ddl: "TEXT PRIMARY KEY" },
  action: { ddl: "TEXT NOT NULL" },
  memberId: { ddl: "TEXT" },
  targetId: { ddl: "TEXT" },
  details: {
    ddl: "TEXT",
    value: (row) => sanitizeAuditArchiveText(row.details),
  },
  ipAddress: {
    ddl: "TEXT",
    value: (row, context) =>
      context.preserveRequestData
        ? sanitizeAuditArchiveText(row.ipAddress)
        : null,
  },
  createdAt: { ddl: "TIMESTAMP(3) NOT NULL" },
  actorMemberId: { ddl: "TEXT" },
  subjectMemberId: { ddl: "TEXT" },
  entityType: { ddl: "TEXT" },
  entityId: { ddl: "TEXT" },
  category: { ddl: "TEXT" },
  severity: { ddl: "TEXT" },
  outcome: { ddl: "TEXT" },
  summary: {
    ddl: "TEXT",
    value: (row) => sanitizeAuditArchiveText(row.summary),
  },
  metadata: {
    ddl: "JSONB",
    cast: "::jsonb",
    value: (row) => sanitizeArchiveMetadata(row.metadata),
  },
  requestId: { ddl: "TEXT" },
  userAgent: {
    ddl: "TEXT",
    value: (row, context) =>
      context.preserveRequestData
        ? sanitizeAuditArchiveText(row.userAgent)
        : null,
  },
  retentionClass: { ddl: "TEXT" },
  expiresAt: { ddl: "TIMESTAMP(3)" },
  archivedAt: {
    // NOT NULL in the archive even though it is nullable in the main table: the
    // archive copy always records when it was archived.
    ddl: "TIMESTAMP(3) NOT NULL",
    value: (_row, context) => context.archivedAt,
  },
  incidentPreserved: { ddl: "BOOLEAN NOT NULL DEFAULT false" },
};

const AUDIT_ARCHIVE_COLUMN_NAMES = Object.keys(
  AUDIT_ARCHIVE_COLUMNS
) as ArchivedAuditLogColumn[];

const auditArchiveSelect = Object.fromEntries(
  AUDIT_ARCHIVE_COLUMN_NAMES.map((name) => [name, true])
) as Record<ArchivedAuditLogColumn, true>;

// The manifest is the only source of the SQL fragments below, and every entry is
// a literal written in this file — no caller can reach it. These guards are
// belt-and-braces so that the shift from hand-written SQL to generated SQL can
// never become an injection surface, even if the manifest were later fed from
// somewhere less trustworthy.
const ARCHIVE_IDENTIFIER_PATTERN = /^[A-Za-z][A-Za-z0-9_]*$/;
const ARCHIVE_COLUMN_DDL_PATTERN = /^[A-Za-z0-9_() ]+$/;
const ARCHIVE_COLUMN_CAST_PATTERN = /^::[a-z][a-z0-9_]*$/;

// The three validators below are deliberately PURE (value in, checked value
// out) and exported rather than reading the manifest themselves, so their
// rejection paths can be driven with hostile input from
// `src/lib/__tests__/audit-archive-columns.test.ts`. They are the only stated
// compensating control for generating SQL instead of writing it literally, and
// an untested guard is one a future readability refactor can delete with the
// suite still green (#2290 review).

/** test seam — quotes a column name, rejecting anything that is not a bare identifier. */
export function archiveIdentifier(name: string): string {
  if (!ARCHIVE_IDENTIFIER_PATTERN.test(name)) {
    throw new Error(`Audit archive: unsafe column identifier "${name}"`);
  }
  return `"${name}"`;
}

/** test seam — checks a manifest `ddl` before it is concatenated into `CREATE TABLE`. */
export function archiveColumnDdl(column: string, ddl: string): string {
  if (!ARCHIVE_COLUMN_DDL_PATTERN.test(ddl)) {
    throw new Error(`Audit archive: unsafe column definition for "${column}"`);
  }
  return ddl;
}

/** test seam — checks a manifest `cast` before it is concatenated into the `INSERT`. */
export function archiveColumnCast(column: string, cast: string): string {
  if (!ARCHIVE_COLUMN_CAST_PATTERN.test(cast)) {
    throw new Error(`Audit archive: unsafe column cast for "${column}"`);
  }
  return cast;
}

function archiveColumnDefinition(name: ArchivedAuditLogColumn): string {
  const { ddl } = AUDIT_ARCHIVE_COLUMNS[name];
  return `${archiveIdentifier(name)} ${archiveColumnDdl(name, ddl)}`;
}

function archiveColumnCastFor(
  name: ArchivedAuditLogColumn
): string | undefined {
  const { cast } = AUDIT_ARCHIVE_COLUMNS[name];
  return cast === undefined ? undefined : archiveColumnCast(name, cast);
}

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

function createArchiveClient(databaseUrl: string): AuditArchiveDbClient {
  return new PrismaClient({
    adapter: createPrismaPgAdapter(databaseUrl),
    // The archive client only runs raw AuditLog statements, but every
    // application client carries the same omission so the census holds with
    // no exemption (`INV-PRIV-022`).
    omit: PRISMA_CLIENT_GLOBAL_OMIT,
  });
}

// test seam
export function getAuditLogRetentionCutoffs(now = new Date()) {
  return {
    requestData: addUtcDays(now, -RAW_REQUEST_DATA_RETENTION_DAYS),
    archive: addUtcMonths(now, -ARCHIVE_AFTER_MONTHS),
    archivePrune: addUtcYears(now, -ARCHIVE_PRUNE_AFTER_YEARS),
    criticalMain: addUtcYears(now, -CRITICAL_MAIN_RETENTION_YEARS),
  };
}

// test seam
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
      // NARROWED, not cast (#2581). This reads a STORED row's category, so the
      // value is whatever was written — including the historical `auth` and
      // `membership` rows the old open writer type let through, which #2581's
      // third child inventories rather than rewrites. `as AuditCategory` was
      // honest while that type ended in `| (string & {})` and accepted anything;
      // now the type is closed it would be a lie, and it would hide the case from
      // any future exhaustive check. The guard produces the same answer a cast
      // does — `classifyAuditRetention` only tests for `security`, `admin` and
      // `system`, so a non-canonical value falls through to `critical` either way.
      category: isAuditCategory(input.category) ? input.category : null,
      severity: input.severity as AuditSeverity | null | undefined,
    }) === "critical"
  );
}

// test seam
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

// test seam
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
  // Column list generated from AUDIT_ARCHIVE_COLUMNS — see the manifest comment.
  // This only provisions a *missing* archive table; an archive database that
  // already exists does not gain a newly added column here. See
  // docs/AUDIT_RETENTION_ARCHIVE_RUNBOOK.md → "Adding a column to AuditLog".
  const columnDefinitions = AUDIT_ARCHIVE_COLUMN_NAMES.map(
    (name) => `      ${archiveColumnDefinition(name)}`
  ).join(",\n");
  // One of the two interpolations into an `Unsafe` raw statement in non-test
  // `src/` (#2686); the other is `booking-envelope-invariants.ts`. It is a
  // CREATE TABLE column list built entirely from AUDIT_ARCHIVE_COLUMN_NAMES —
  // the committed const array at the top of THIS file (see the manifest at
  // `audit-retention.ts:177`, not a separate module: `audit-archive-columns.ts`
  // does not exist, only the test of that name does) — mapped through
  // `archiveColumnDefinition`, which itself only ever returns text from that
  // same manifest. No request value, no database value and no environment value
  // can reach this string, and Prisma cannot express CREATE TABLE at all, so
  // there is no parameterised form to move to.
  // `src/lib/__tests__/audit-archive-columns.test.ts` pins the generated DDL.
  // nosemgrep: acb-unsafe-raw-sql — DDL generated from the committed column manifest; no request-reachable input
  await archiveDb.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "AuditLogArchive" (
${columnDefinitions}
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
  const context: AuditArchiveInsertContext = {
    archivedAt,
    preserveRequestData: row.incidentPreserved,
  };

  // Column list and bound values are both generated from AUDIT_ARCHIVE_COLUMNS
  // in the same key order, so they cannot drift apart or omit a column.
  const columns = Prisma.join(
    AUDIT_ARCHIVE_COLUMN_NAMES.map((name) =>
      Prisma.raw(archiveIdentifier(name))
    )
  );
  const values = Prisma.join(
    AUDIT_ARCHIVE_COLUMN_NAMES.map((name) => {
      const spec = AUDIT_ARCHIVE_COLUMNS[name];
      const value = spec.value ? spec.value(row, context) : row[name];
      const cast = archiveColumnCastFor(name);
      return cast ? Prisma.sql`${value}${Prisma.raw(cast)}` : Prisma.sql`${value}`;
    })
  );

  return archiveDb.$executeRaw(Prisma.sql`
    INSERT INTO "AuditLogArchive" (${columns})
    VALUES (${values})
    ON CONFLICT ("id") DO NOTHING
  `);
}

// test seam
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

  // #2506: surface an archive backlog. The batch is bounded to `batchSize`
  // (500/night), and the #2506 prune gate now RETAINS expired archivable rows
  // that are not yet archived — so when the archive falls behind, over-retention
  // becomes silent. A full batch means more archivable rows remain unarchived
  // this run, so warn: it is the cheap nightly signal that archival is drifting
  // and expired rows are being held past their retention window until it catches
  // up. It self-clears the first night the batch is not full.
  if (rows.length === batchSize) {
    logger.warn(
      {
        job: "audit-retention",
        reason: "archive-backlog",
        batchSize,
        archived: archivedIds.length,
      },
      "Audit archive batch was full: archivable rows remain unarchived after " +
        "this run. Per #2506, any expired rows among them are retained in the " +
        "main database past their retention window until archival catches up. " +
        "If this persists, the archive is falling behind — investigate archive " +
        "throughput or raise the batch size."
    );
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

// test seam
//
// HARD INVARIANT (#2506): prune may NEVER delete an audit row that is destined
// for the archive but has not yet been archived.
//
// The archivable retention classes (`sensitive_access`, `standard`) are copied
// to the archive database and then deleted from the main table by
// `archiveEligibleAuditLogs`, which is bounded to 500 rows/night. Pruning
// deletes on `expiresAt` and knows nothing about whether a row was archived, so
// a club sustaining >500 archive-eligible rows/day could otherwise have an
// expired-but-unarchived row deleted here before the archive ever received it —
// silent, unrecoverable data loss (the archive copy is the only surviving
// record once the source row is gone).
//
// The gate: when an archive is configured (`archiveActive`), an archivable-class
// row is prune-eligible ONLY once it is provably archived, keyed on the durable
// per-row `archivedAt` marker. Archival writes the row to the archive DB and
// then removes it from the main table, so an archivable row still present in the
// main table has `archivedAt = null` and is retained here — the prune waits,
// rather than deleting an unarchived row, until archival catches up. Because the
// gate lives inside the single `deleteMany` predicate, PostgreSQL evaluates it
// atomically against committed rows: even if an archive run is committing
// concurrently, prune can only ever act on a row whose `archivedAt` state it
// reads under that statement, so there is no stale-watermark race to lose a row
// through. This is stricter than the cross-step guard in
// `runAuditLogRetentionJob` (which stops the whole job when archiving *throws*):
// this holds even when archiving *succeeds but is behind*.
//
// When NO archive is configured (`archiveActive` false), there is no archive to
// outrun and nowhere for the data to go, so archivable rows are pruned on
// `expiresAt` exactly as before — retaining them forever would break data
// minimisation. `diagnostic_high_volume` and the unclassified/`critical` classes
// are never archived, so they are always pruned purely on their own expiry.
export async function pruneExpiredAuditLogs(
  db: AuditRetentionDbClient = prisma,
  now = new Date(),
  options: { archiveActive?: boolean } = {}
): Promise<{ cutoff: Date; deleted: number }> {
  const { criticalMain: cutoff } = getAuditLogRetentionCutoffs(now);

  // Archivable-class rows: gated on the archive marker only when an archive is
  // active. `ARCHIVABLE_RETENTION_CLASSES` is the single source of which classes
  // the archive is responsible for, shared with `archiveEligibleAuditLogs`.
  const archivableExpiredClause: Prisma.AuditLogWhereInput = options.archiveActive
    ? {
        retentionClass: { in: ARCHIVABLE_RETENTION_CLASSES },
        expiresAt: { lt: now },
        archivedAt: { not: null },
      }
    : {
        retentionClass: { in: ARCHIVABLE_RETENTION_CLASSES },
        expiresAt: { lt: now },
      };

  const { count } = await db.auditLog.deleteMany({
    where: {
      OR: [
        archivableExpiredClause,
        {
          // Never archived — pruned purely on its own 90-day expiry.
          retentionClass: "diagnostic_high_volume",
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

// test seam
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
    // -----------------------------------------------------------------------
    // Why the steps below are NOT isolated from one another (#2290 review).
    //
    // A throw from `archiveEligibleAuditLogs` — most plausibly an archive
    // database whose schema has drifted behind the AuditLog model — aborts the
    // whole job, so neither prune runs. That is deliberate, not an oversight,
    // and it is the opposite of the per-step isolation the cron applies at
    // `src/instrumentation.node.ts` around independent cleanups.
    //
    // These steps are NOT independent, and the eligibility sets overlap. A
    // `sensitive_access` row is archive-eligible from 12 months
    // (ARCHIVE_AFTER_MONTHS) and prune-eligible from 24 months
    // (`getAuditRetentionExpiresAt` in src/lib/audit.ts); a `standard` row is
    // archive-eligible from 12 months and prune-eligible at 7 years. Two guards,
    // in depth, keep the prune from ever outrunning the archive:
    //
    //   1. This cross-step guard: a THROW from the archive step (most plausibly
    //      an archive schema drifted behind the AuditLog model) aborts the whole
    //      job, so neither prune runs — the opposite of the per-step isolation
    //      the cron applies at `src/instrumentation.node.ts`. Letting a prune run
    //      while archiving is broken would permanently DELETE rows the archive
    //      never received — unrecoverable.
    //
    //   2. The in-prune archive gate (#2506): even when the archive step
    //      SUCCEEDS but is BEHIND (a club sustaining >500 archive-eligible rows a
    //      day drains the 500/night batch slowly), `pruneExpiredAuditLogs`
    //      refuses to delete an archivable-class row that is not yet provably
    //      archived — see its `archiveActive` gate. Guard 1 alone cannot catch
    //      this case because nothing threw.
    //
    // Stopping everything over-retains expired rows instead: a data-
    // minimisation delay that reverses the moment the archive schema is fixed.
    // Unrecoverable loss loses to recoverable delay, so the job fails closed.
    //
    // The over-retention is a real cost and must not surprise whoever triages
    // the cron failure, so the error below names BOTH consequences, and
    // docs/AUDIT_RETENTION_ARCHIVE_RUNBOOK.md states the same blast radius.
    // -----------------------------------------------------------------------
    let archive: AuditLogRetentionJobResult["archive"];
    try {
      archive = await archiveEligibleAuditLogs(
        db,
        createdArchiveDb,
        now,
        options.batchSize ?? DEFAULT_ARCHIVE_BATCH_SIZE
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(
        "Audit archive step failed, so the whole audit retention job stopped: " +
          "nothing was archived AND no expired audit rows were pruned from the " +
          "main database or the archive. Expired rows are over-retained on " +
          "purpose until this is fixed, because pruning while archiving is " +
          "stalled would delete rows that were never archived. Fix the archive " +
          "database (docs/AUDIT_RETENTION_ARCHIVE_RUNBOOK.md, " +
          `"Adding a column to AuditLog") and the next run catches up. Cause: ${reason}`,
        { cause: error }
      );
    }
    // #2506: gate the main prune on archival. `archive.configured` is true only
    // when an archive DB is configured AND the archive step completed this run
    // (a configured archive that throws aborts the job above, before prune). So
    // it is a reliable "archive is active" signal: when true, prune retains
    // archivable rows until they are provably archived; when false (no archive
    // configured), prune falls back to expiry-only deletion.
    const mainPrune = await pruneExpiredAuditLogs(db, now, {
      archiveActive: archive.configured,
    });
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
