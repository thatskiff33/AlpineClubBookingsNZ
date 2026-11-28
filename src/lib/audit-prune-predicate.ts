// Which main-table audit rows the nightly prune deletes: the one home of that
// rule (INV-SSOT-001). `pruneExpiredAuditLogs` sends `buildAuditLogPruneWhere`
// to PostgreSQL; why each branch is there is told above that function in
// `audit-retention.ts`. The older-entry expiry census (#5265) has to answer
// "would the prune delete this row once it has an expiry?" for rows that have
// none yet, which no query can, so `pruneDeletesUnclassifiedAuditLog` states
// the unclassified branches as a function. It is a second form kept beside the
// first, not a derivation: evaluating the `where` itself would need a Prisma
// `where` interpreter in production code, and the one the tree has (#3434) is
// a test helper. `audit-prune-predicate.test.ts` runs both forms over every
// boundary and fails when either moves alone.
import type { Prisma } from "@prisma/client";

import {
  ARCHIVABLE_RETENTION_CLASSES,
  UNCLASSIFIED_RETENTION,
} from "@/lib/audit-retention-classes";

/** The instant the prune runs at and the two cut-offs it reads, from `getAuditLogRetentionCutoffs(now)`. */
export interface AuditPruneClock {
  now: Date;
  /** Seven years back: a `critical` row, by class or by severity, must be recorded before it. */
  criticalMain: Date;
  /** Ten years back: an incident-preserved row must be recorded before it. */
  incidentPreserved: Date;
}

export function buildAuditLogPruneWhere(
  clock: AuditPruneClock,
  options: { archiveActive?: boolean } = {}
): Prisma.AuditLogWhereInput {
  const { now, criticalMain: cutoff, incidentPreserved: preservedCutoff } = clock;

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

  return {
    // #3939: a preserved row also has to be ten years old, so it goes at the
    // LATER of its normal rule and the cap. The column is NOT NULL DEFAULT
    // false, so `incidentPreserved: false` has no NULL case.
    AND: [
      {
        OR: [
          { incidentPreserved: false },
          { createdAt: { lt: preservedCutoff } },
        ],
      },
    ],
    OR: [
      archivableExpiredClause,
      {
        // Never archived — pruned purely on its own 90-day expiry.
        retentionClass: "diagnostic_high_volume",
        expiresAt: { lt: now },
      },
      { AND: [UNCLASSIFIED_RETENTION, { expiresAt: { lt: now } }, { OR: [{ severity: null }, { severity: { not: "critical" } }] }] },
      {
        retentionClass: "critical",
        createdAt: { lt: cutoff },
        expiresAt: { lt: now },
      },
      { AND: [UNCLASSIFIED_RETENTION, { severity: "critical", createdAt: { lt: cutoff }, expiresAt: { lt: now } }] },
    ],
  };
}

/**
 * Whether the `where` above deletes a row that `UNCLASSIFIED_RETENTION`
 * matches (no class, or one outside the closed set). Meaningless for a row
 * with a recognised class, which other branches decide.
 */
export function pruneDeletesUnclassifiedAuditLog(
  row: {
    severity: string | null;
    createdAt: Date;
    expiresAt: Date | null;
    incidentPreserved: boolean;
  },
  clock: AuditPruneClock
): boolean {
  if (row.expiresAt === null || !(row.expiresAt < clock.now)) return false;
  if (row.incidentPreserved && !(row.createdAt < clock.incidentPreserved)) return false;
  return row.severity !== "critical" || row.createdAt < clock.criticalMain;
}
