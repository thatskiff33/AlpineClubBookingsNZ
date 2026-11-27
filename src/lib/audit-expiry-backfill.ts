// Seven-year expiry for audit entries recorded before every writer derived one
// (#5265, owner decision 20 Nov 2026).
//
// Before v0.14.0, 82 kinds of audit entry were written with no category, so
// `buildAuditLogCreateData` gave them no retention class and no expiry: kept
// for ever. #2581 gave those rows a category and deliberately no expiry. The
// owner has now decided they get seven years counted from the day each was
// recorded, applied by the owner after reading the counts this module reports.
//
// THE SELECTOR is the pre-v0.14.0 state exactly: no retention class AND no
// expiry. A row with a class and no expiry is the deliberate keep-for-ever
// escape hatch (`expiresAt: null` at the writer) and is never touched; it is
// only counted. Only `expiresAt` is written. `retentionClass` stays empty, so
// the prune's unclassified branches delete the row at exactly seven years, and
// an incident-preserved row still waits for its ten-year floor.
//
// THE EXPIRY is `getAuditRetentionExpiresAt("critical", createdAt)`, the
// writer's own function, so there is one seven-year rule. Some kinds would be
// classed shorter today (a `sensitive_access` view, two years); by the
// decision they still get seven years, and the report lists them on their own.
//
// The owner runs every mode. An agent never points this at a real database.
// Census and dry run write nothing. Apply refuses unless the operator repeats
// the live total and, when some rows would be deleted at the next nightly
// prune, that count too. Each batch is one transaction of guarded
// `updateMany`s plus one audit entry; a batch that updates nothing writes no
// entry, so a second apply changes nothing. No advisory lock (INV-LOCK-001):
// no booking, capacity or money writer is involved, every write is guarded on
// the selector, and the nightly retention job writes other columns.
import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";

import {
  classifyAuditRetention,
  createAuditLog,
  getAuditRetentionExpiresAt,
  type AuditSeverity,
} from "@/lib/audit";
import { isAuditCategory } from "@/lib/audit-categories";
import type { AuditRetentionClass } from "@/lib/audit-retention-classes";
import { getAuditLogRetentionCutoffs } from "@/lib/audit-retention";

export const AUDIT_EXPIRY_BACKFILL_ACTION = "AUDIT_EXPIRY_BACKFILLED";
export const AUDIT_EXPIRY_BACKFILL_SOURCE = "#5265";
export const AUDIT_EXPIRY_BACKFILL_DEFAULT_BATCH_SIZE = 500;
const AUDIT_SEVERITIES: readonly AuditSeverity[] = ["info", "important", "critical"];
const MAX_BATCH_SIZE = 5_000;
const SCAN_PAGE_SIZE = 5_000;
// Per-row updates: 500 small statements need more than Prisma's 5-second default.
const BATCH_TRANSACTION_OPTIONS = { maxWait: 10_000, timeout: 120_000 } as const;

/** The pre-v0.14.0 state: no class and no expiry. The only rows this module writes. */
export const AUDIT_EXPIRY_BACKFILL_WHERE = {
  retentionClass: null,
  expiresAt: null,
} satisfies Prisma.AuditLogWhereInput;

/** A class but no expiry: the writer's deliberate keep-for-ever. Counted, never changed. */
const KEPT_FOR_EVER_WHERE = {
  retentionClass: { not: null },
  expiresAt: null,
} satisfies Prisma.AuditLogWhereInput;

export type AuditExpiryBackfillMode = "census" | "dry-run" | "apply";

export type AuditExpiryBackfillDb = Pick<
  PrismaClient,
  "auditLog" | "member" | "$queryRaw" | "$transaction"
>;

export class AuditExpiryBackfillRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuditExpiryBackfillRefusal";
  }
}

export interface AuditExpiryBackfillKind {
  action: string;
  category: string | null;
  severity: string | null;
  count: number;
  firstRecordedAt: string;
  lastRecordedAt: string;
  /** UTC year recorded -> rows. */
  countsByYear: Record<string, number>;
  earliestNewExpiresAt: string;
  latestNewExpiresAt: string;
  /** Rows whose new expiry is already past. */
  alreadyExpired: number;
  /** The class today's writer gives a new entry of this kind. Reported, never written. */
  writerRetentionClass: AuditRetentionClass;
  writerRetentionPeriod: string;
}

export interface AuditExpiryBackfillBatch {
  batchNumber: number;
  rowsUpdated: number;
}

export interface AuditExpiryBackfillReport {
  mode: AuditExpiryBackfillMode;
  now: string;
  total: number;
  /** New expiry already past, preserved rows included. */
  alreadyExpired: number;
  /** What the next nightly prune would delete: past expiry and not held by the ten-year floor. */
  deletableAtNextPrune: number;
  incidentPreserved: { count: number; heldByTenYearFloor: number };
  keptForeverWithClass: number;
  kinds: AuditExpiryBackfillKind[];
  /** Kinds whose writer class today is not `critical`: they still get seven years. */
  shorterClassKinds: AuditExpiryBackfillKind[];
  batchSize: number;
  plannedBatches: number;
  applyCommand: string | null;
  apply: {
    runId: string;
    actorMemberId: string;
    rowsUpdated: number;
    batches: AuditExpiryBackfillBatch[];
  } | null;
}

export interface RunAuditExpiryBackfillOptions {
  mode: AuditExpiryBackfillMode;
  db: AuditExpiryBackfillDb;
  now?: Date;
  batchSize?: number;
  actorMemberId?: string | null;
  confirmTotal?: number | null;
  allowDelete?: number | null;
}

interface CandidateRow {
  id: string;
  action: string;
  category: string | null;
  severity: string | null;
  createdAt: Date;
  incidentPreserved: boolean;
}

const CANDIDATE_SELECT = {
  id: true,
  action: true,
  category: true,
  severity: true,
  createdAt: true,
  incidentPreserved: true,
} satisfies Prisma.AuditLogSelect;

const OLDEST_FIRST = [{ createdAt: "asc" }, { id: "asc" }] satisfies
  Prisma.AuditLogOrderByWithRelationInput[];

/** The single seven-year rule, as the writer applies it to a new `critical` entry. */
export function auditBackfillExpiresAt(createdAt: Date): Date {
  return getAuditRetentionExpiresAt("critical", createdAt);
}

/** "7 years", "2 years", "90 days": read off the writer's own function. */
export function describeAuditRetentionPeriod(retentionClass: AuditRetentionClass): string {
  const from = new Date(Date.UTC(2001, 0, 1));
  const to = getAuditRetentionExpiresAt(retentionClass, from);
  if (to.getUTCDate() === 1) {
    const months =
      (to.getUTCFullYear() - from.getUTCFullYear()) * 12 + to.getUTCMonth() - from.getUTCMonth();
    return months % 12 === 0 ? `${months / 12} years` : `${months} months`;
  }
  return `${Math.round((to.getTime() - from.getTime()) / 86_400_000)} days`;
}

function writerRetentionClass(row: Pick<CandidateRow, "action" | "category" | "severity">) {
  return classifyAuditRetention({
    action: row.action,
    category: isAuditCategory(row.category) ? row.category : null,
    severity: AUDIT_SEVERITIES.find((severity) => severity === row.severity) ?? null,
  });
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Every candidate, oldest first, a page at a time. */
async function* scanCandidates(db: AuditExpiryBackfillDb): AsyncGenerator<CandidateRow> {
  let last: { createdAt: Date; id: string } | null = null;
  for (;;) {
    const where: Prisma.AuditLogWhereInput = last
      ? {
          AND: [
            AUDIT_EXPIRY_BACKFILL_WHERE,
            {
              OR: [
                { createdAt: { gt: last.createdAt } },
                { createdAt: last.createdAt, id: { gt: last.id } },
              ],
            },
          ],
        }
      : AUDIT_EXPIRY_BACKFILL_WHERE;
    const page: CandidateRow[] = await db.auditLog.findMany({
      where,
      select: CANDIDATE_SELECT,
      orderBy: OLDEST_FIRST,
      take: SCAN_PAGE_SIZE,
    });
    yield* page;
    if (page.length < SCAN_PAGE_SIZE) return;
    const tail = page[page.length - 1]!;
    last = { createdAt: tail.createdAt, id: tail.id };
  }
}

interface KindAccumulator {
  action: string;
  category: string | null;
  severity: string | null;
  count: number;
  first: Date;
  last: Date;
  countsByYear: Record<string, number>;
  alreadyExpired: number;
}

async function measure(db: AuditExpiryBackfillDb, now: Date) {
  const preservedCutoff = getAuditLogRetentionCutoffs(now).incidentPreserved;
  const kinds = new Map<string, KindAccumulator>();
  let total = 0;
  let alreadyExpired = 0;
  let deletableAtNextPrune = 0;
  let preserved = 0;
  let heldByTenYearFloor = 0;

  for await (const row of scanCandidates(db)) {
    total += 1;
    const expired = auditBackfillExpiresAt(row.createdAt) < now;
    const held = row.incidentPreserved && row.createdAt >= preservedCutoff;
    if (expired) alreadyExpired += 1;
    if (expired && !held) deletableAtNextPrune += 1;
    if (row.incidentPreserved) preserved += 1;
    if (expired && held) heldByTenYearFloor += 1;

    const key = JSON.stringify([row.action, row.category, row.severity]);
    let kind = kinds.get(key);
    if (!kind) {
      kind = {
        action: row.action,
        category: row.category,
        severity: row.severity,
        count: 0,
        first: row.createdAt,
        last: row.createdAt,
        countsByYear: {},
        alreadyExpired: 0,
      };
      kinds.set(key, kind);
    }
    kind.count += 1;
    if (row.createdAt < kind.first) kind.first = row.createdAt;
    if (row.createdAt > kind.last) kind.last = row.createdAt;
    const year = String(row.createdAt.getUTCFullYear());
    kind.countsByYear[year] = (kind.countsByYear[year] ?? 0) + 1;
    if (expired) kind.alreadyExpired += 1;
  }

  const kindLines: AuditExpiryBackfillKind[] = [...kinds.values()]
    .map((kind) => {
      const retentionClass = writerRetentionClass(kind);
      return {
        action: kind.action,
        category: kind.category,
        severity: kind.severity,
        count: kind.count,
        firstRecordedAt: kind.first.toISOString(),
        lastRecordedAt: kind.last.toISOString(),
        countsByYear: kind.countsByYear,
        earliestNewExpiresAt: auditBackfillExpiresAt(kind.first).toISOString(),
        latestNewExpiresAt: auditBackfillExpiresAt(kind.last).toISOString(),
        alreadyExpired: kind.alreadyExpired,
        writerRetentionClass: retentionClass,
        writerRetentionPeriod: describeAuditRetentionPeriod(retentionClass),
      };
    })
    .sort(
      (a, b) =>
        b.count - a.count ||
        a.action.localeCompare(b.action) ||
        String(a.category).localeCompare(String(b.category)) ||
        String(a.severity).localeCompare(String(b.severity)),
    );

  const keptForeverWithClass = await db.auditLog.count({ where: KEPT_FOR_EVER_WHERE });

  return {
    total,
    alreadyExpired,
    deletableAtNextPrune,
    incidentPreserved: { count: preserved, heldByTenYearFloor },
    keptForeverWithClass,
    kinds: kindLines,
    shorterClassKinds: kindLines.filter((kind) => kind.writerRetentionClass !== "critical"),
  };
}

function normaliseBatchSize(batchSize: number | undefined): number {
  const size = batchSize ?? AUDIT_EXPIRY_BACKFILL_DEFAULT_BATCH_SIZE;
  if (!Number.isInteger(size) || size < 1 || size > MAX_BATCH_SIZE) {
    throw new AuditExpiryBackfillRefusal(
      `Batch size must be a whole number from 1 to ${MAX_BATCH_SIZE}; got ${size}.`,
    );
  }
  return size;
}

export function buildAuditExpiryBackfillApplyCommand(params: {
  total: number;
  deletableAtNextPrune: number;
  batchSize: number;
}): string {
  const parts = [
    "pnpm run audit:expiry-backfill -- --apply --actor <your-member-id>",
    `--confirm-total ${params.total}`,
  ];
  if (params.deletableAtNextPrune > 0) parts.push(`--allow-delete ${params.deletableAtNextPrune}`);
  if (params.batchSize !== AUDIT_EXPIRY_BACKFILL_DEFAULT_BATCH_SIZE) {
    parts.push(`--batch-size ${params.batchSize}`);
  }
  return parts.join(" ");
}

async function assertCanUpdateExpiresAt(db: AuditExpiryBackfillDb): Promise<void> {
  const rows = await db.$queryRaw<{ allowed: boolean }[]>(Prisma.sql`
    SELECT has_column_privilege(current_user, '"AuditLog"', 'expiresAt', 'UPDATE') AS allowed
  `);
  if (rows[0]?.allowed !== true) {
    throw new AuditExpiryBackfillRefusal(
      'This database connection may not UPDATE "AuditLog"."expiresAt". Under the ' +
        "least-privilege roles neither the application role nor the audit-retention role " +
        "can; run apply with DATABASE_URL naming the operator connection (POSTGRES_USER).",
    );
  }
}

async function applyBatch(params: {
  db: AuditExpiryBackfillDb;
  now: Date;
  runId: string;
  batchNumber: number;
  batchSize: number;
  actorMemberId: string;
}): Promise<number> {
  const { now, runId, batchNumber, batchSize, actorMemberId } = params;
  return params.db.$transaction(async (tx) => {
    const rows: CandidateRow[] = await tx.auditLog.findMany({
      where: AUDIT_EXPIRY_BACKFILL_WHERE,
      select: CANDIDATE_SELECT,
      orderBy: OLDEST_FIRST,
      take: batchSize,
    });
    const countsByAction: Record<string, number> = {};
    let updated = 0;
    let alreadyExpired = 0;
    let createdFrom: Date | null = null;
    let createdTo: Date | null = null;
    for (const row of rows) {
      const expiresAt = auditBackfillExpiresAt(row.createdAt);
      const { count } = await tx.auditLog.updateMany({
        where: { id: row.id, ...AUDIT_EXPIRY_BACKFILL_WHERE },
        data: { expiresAt },
      });
      if (count === 0) continue;
      updated += count;
      countsByAction[row.action] = (countsByAction[row.action] ?? 0) + count;
      if (expiresAt < now) alreadyExpired += count;
      if (!createdFrom || row.createdAt < createdFrom) createdFrom = row.createdAt;
      if (!createdTo || row.createdAt > createdTo) createdTo = row.createdAt;
    }
    if (updated === 0) return 0;

    await createAuditLog(
      {
        action: AUDIT_EXPIRY_BACKFILL_ACTION,
        category: "admin",
        severity: "info",
        outcome: "success",
        actorMemberId,
        entityType: "AuditLog",
        entityId: runId,
        summary: `Gave ${updated} older audit entries a seven-year expiry (batch ${batchNumber})`,
        metadata: {
          runId,
          batchNumber,
          rowsUpdated: updated,
          countsByAction,
          createdFrom: createdFrom?.toISOString() ?? null,
          createdTo: createdTo?.toISOString() ?? null,
          alreadyExpired,
          source: AUDIT_EXPIRY_BACKFILL_SOURCE,
        },
      },
      tx,
    );
    return updated;
  }, BATCH_TRANSACTION_OPTIONS);
}

export async function runAuditExpiryBackfill(
  options: RunAuditExpiryBackfillOptions,
): Promise<AuditExpiryBackfillReport> {
  const { mode, db } = options;
  const now = options.now ?? new Date();
  const batchSize = normaliseBatchSize(options.batchSize);
  const actorMemberId = options.actorMemberId?.trim() || null;

  if (mode === "apply" && !actorMemberId) {
    throw new AuditExpiryBackfillRefusal("Apply needs --actor <member id>: the member recorded as doing it.");
  }

  const measured = await measure(db, now);
  const report: AuditExpiryBackfillReport = {
    mode,
    now: now.toISOString(),
    ...measured,
    batchSize,
    plannedBatches: Math.ceil(measured.total / batchSize),
    applyCommand:
      mode === "dry-run" && measured.total > 0
        ? buildAuditExpiryBackfillApplyCommand({ ...measured, batchSize })
        : null,
    apply: null,
  };
  if (mode !== "apply" || measured.total === 0) return report;

  if (options.confirmTotal !== measured.total) {
    throw new AuditExpiryBackfillRefusal(
      `--confirm-total must equal the live total, ${measured.total}; got ${options.confirmTotal ?? "none"}. ` +
        "Re-run the dry run and read it again.",
    );
  }
  if ((options.allowDelete ?? 0) !== measured.deletableAtNextPrune) {
    throw new AuditExpiryBackfillRefusal(
      `${measured.deletableAtNextPrune} entries would be deleted for good at the next nightly ` +
        `clean-up; --allow-delete must equal that number, got ${options.allowDelete ?? "none"}.`,
    );
  }
  const actor = await db.member.findUnique({ where: { id: actorMemberId! }, select: { id: true } });
  if (!actor) {
    throw new AuditExpiryBackfillRefusal(`No member has id ${actorMemberId}; --actor must name a real member.`);
  }
  await assertCanUpdateExpiresAt(db);

  const runId = randomUUID();
  const batches: AuditExpiryBackfillBatch[] = [];
  let rowsUpdated = 0;
  for (let batchNumber = 1; ; batchNumber += 1) {
    const updated = await applyBatch({ db, now, runId, batchNumber, batchSize, actorMemberId: actor.id });
    if (updated === 0) break;
    batches.push({ batchNumber, rowsUpdated: updated });
    rowsUpdated += updated;
  }
  report.apply = { runId, actorMemberId: actor.id, rowsUpdated, batches };
  return report;
}

export function formatAuditExpiryBackfillReport(report: AuditExpiryBackfillReport): string {
  const lines: string[] = [];
  lines.push(`Older audit entries with no retention class and no expiry: ${report.total}`);
  lines.push(`Clock: ${report.now}. Each gets seven years from the day it was recorded (owner decision, #5265).`);
  lines.push(
    `Already past seven years: ${report.alreadyExpired}. ` +
      `The next nightly clean-up would delete ${report.deletableAtNextPrune} of them for good.`,
  );
  lines.push(
    `Incident-preserved among them: ${report.incidentPreserved.count} (included; ` +
      `${report.incidentPreserved.heldByTenYearFloor} past seven years are still kept by the ten-year floor).`,
  );
  lines.push(
    `Entries with a retention class but no expiry (deliberate keep-for-ever, never changed here): ` +
      `${report.keptForeverWithClass}`,
  );

  lines.push("", "By kind (action | category | severity):");
  for (const kind of report.kinds) {
    const years = Object.entries(kind.countsByYear)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([year, count]) => `${year}: ${count}`)
      .join(", ");
    lines.push(
      `- ${kind.action} | ${kind.category ?? "(none)"} | ${kind.severity ?? "(none)"}: ${kind.count} ` +
        `recorded ${isoDate(new Date(kind.firstRecordedAt))} to ${isoDate(new Date(kind.lastRecordedAt))} ` +
        `(${years}); new expiry ${isoDate(new Date(kind.earliestNewExpiresAt))} to ` +
        `${isoDate(new Date(kind.latestNewExpiresAt))}; already past: ${kind.alreadyExpired}; ` +
        `new entries today: ${kind.writerRetentionClass}, ${kind.writerRetentionPeriod}`,
    );
  }

  lines.push("", "Kinds a new entry of which would be kept for less than seven years today:");
  if (report.shorterClassKinds.length === 0) lines.push("- none");
  for (const kind of report.shorterClassKinds) {
    lines.push(
      `- ${kind.action} | ${kind.category ?? "(none)"}: ${kind.count} older entries. New ones are ` +
        `${kind.writerRetentionClass} (${kind.writerRetentionPeriod}); as decided, these older ones still get seven years.`,
    );
  }

  if (report.mode === "dry-run") {
    lines.push("", `Batches: ${report.plannedBatches} of up to ${report.batchSize}, oldest first.`);
    lines.push(report.applyCommand ? `To apply exactly this: ${report.applyCommand}` : "Nothing to apply.");
  }
  if (report.mode === "apply") {
    if (!report.apply) {
      lines.push("", "Nothing to apply: no entry is missing both a class and an expiry.");
    } else {
      lines.push(
        "",
        `Applied run ${report.apply.runId}: ${report.apply.rowsUpdated} entries in ` +
          `${report.apply.batches.length} batches, each recorded as one ${AUDIT_EXPIRY_BACKFILL_ACTION} entry.`,
      );
    }
  }
  return lines.join("\n");
}
