import type { Prisma } from "@prisma/client";

// The closed set of audit retention classes. The column itself is free text, so
// the prune reads any other stored value as unclassified (#3940). The runbook's
// read-only queries (docs/AUDIT_RETENTION_ARCHIVE_RUNBOOK.md, "Rows with an
// unrecognised retention class") spell this list out; keep them in step.
export const AUDIT_RETENTION_CLASSES = [
  "critical",
  "sensitive_access",
  "diagnostic_high_volume",
  "standard",
] as const;

export type AuditRetentionClass = (typeof AUDIT_RETENTION_CLASSES)[number];

export function isAuditRetentionClass(value: unknown): value is AuditRetentionClass {
  return (AUDIT_RETENTION_CLASSES as readonly unknown[]).includes(value);
}

// #3940: a stored class outside the set matched no prune branch and was kept
// forever; it now reads as unclassified, like a NULL class (owner decision,
// 17 Oct 2026). `notIn` alone would miss NULL (SQL's NOT IN is unknown on
// NULL), so both arms are spelt out.
export const UNCLASSIFIED_RETENTION: Prisma.AuditLogWhereInput = {
  OR: [{ retentionClass: null }, { retentionClass: { notIn: [...AUDIT_RETENTION_CLASSES] } }],
};

type AuditLogColumnName = keyof typeof Prisma.AuditLogScalarFieldEnum;

// The request-data columns `anonymizeExpiredAuditRequestData` clears after 90
// days (#4453). ONE list for the job and for the database grant: the job builds
// its UPDATE from it, and the audit-retention role may UPDATE exactly these
// columns (`src/lib/database-roles.ts`), so the two cannot disagree in code.
// They CAN disagree in a database: the grant only changes when an operator re-runs
// `pnpm run db:provision-roles --apply`, and until then the nightly job fails with
// "permission denied". So a change to this list is a release whose upgrade note
// asks for that re-run, and it also needs a migration that extends the AuditLog
// "anonymise-only" trigger (20261125020000_audit_request_data_update_only_clears).
export const AUDIT_ANONYMISED_REQUEST_COLUMNS = [
  "ipAddress",
  "userAgent",
] as const satisfies readonly AuditLogColumnName[];
