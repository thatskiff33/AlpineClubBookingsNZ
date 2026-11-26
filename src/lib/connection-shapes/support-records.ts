/**
 * What the Support area's record officer actions return (ALP-724,
 * `INV-MCP-006`): the audit log and the problem reports members send. The
 * catalogue entry and the route's `connectionJson` both read these
 * (`INV-SSOT`).
 *
 * Kept: what an officer reads to follow up a report or an event. Dropped: the
 * email addresses and roles of the people an entry or report names, an
 * entry's raw metadata, IP address, browser details and website links, the
 * filter lists drawn from every entry, a report's screenshot (never sent: it
 * is a picture of someone's screen) and the reporter's browser details.
 *
 * Which audit entries a connection may read at all is decided by the route
 * (`auditCategoriesReadableWith`), not by this shape.
 *
 * Types only from the lib modules: nothing here reaches the database.
 */
import type { AuditTimelineEntry, AuditTimelineResponse } from "@/lib/audit-query";
import { connectionShapeFor, type ConnectionShapeFor } from "@/lib/connection-projection";
import type { IssueReportScreenshotAccess } from "@/lib/issue-report-screenshot-access";

// ---------------------------------------------------------------------------
// The audit log
// ---------------------------------------------------------------------------

/** The audit log route's answer; the browser's also carries the filter lists. */
export type AdminAuditLogAnswer = AuditTimelineResponse & {
  eventType: string;
  filters: unknown;
  facets?: unknown;
  actions?: string[];
};

const AUDIT_PERSON_SHAPE = { id: true, firstName: true, lastName: true } as const;

const AUDIT_ENTRY_SHAPE = {
  id: true,
  action: true,
  category: true,
  severity: true,
  outcome: true,
  summary: true,
  description: true,
  details: true,
  createdAt: true,
  actor: AUDIT_PERSON_SHAPE,
  actorDisplayName: true,
  subject: AUDIT_PERSON_SHAPE,
  subjectDisplayName: true,
  subjectMemberId: true,
  entityType: true,
  entityId: true,
  requestId: true,
} as const satisfies ConnectionShapeFor<AuditTimelineEntry>;

export const ADMIN_AUDIT_LOG_CONNECTION_SHAPE = connectionShapeFor<AdminAuditLogAnswer>({
  data: AUDIT_ENTRY_SHAPE,
  total: true,
  page: true,
  pageSize: true,
  totalPages: true,
  category: true,
});

// ---------------------------------------------------------------------------
// Problem reports
// ---------------------------------------------------------------------------

/** Who sent a report. */
interface IssueReportMember {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
}

/** One report as the queue lists it. */
export interface IssueReportSummaryAnswer {
  id: string;
  pageUrl: string;
  pageTitle: string | null;
  description: string;
  screenshot: {
    capturedAt: Date | null;
    expiresAt: Date | null;
    deletedAt: Date | null;
    retained: boolean;
    withheld: boolean;
    disposition: IssueReportScreenshotAccess["disposition"];
  };
  browserInfo: { expiresAt: Date | null; deletedAt: Date | null; retained: boolean };
  resolvedAt: Date | null;
  resolvedById: string | null;
  resolutionNote: string | null;
  createdAt: Date;
  updatedAt: Date;
  member: IssueReportMember;
}

/** One report as its own read, and each decision, answer it. */
export interface IssueReportDetailAnswer extends Omit<IssueReportSummaryAnswer, "screenshot" | "browserInfo"> {
  screenshot: IssueReportSummaryAnswer["screenshot"] & {
    dataUrl: string | null;
    deletedById: string | null;
    deleteReason: string | null;
  };
  browserInfo: IssueReportSummaryAnswer["browserInfo"] & { value: string | null };
}

const ISSUE_REPORT_FIELDS = {
  id: true,
  pageUrl: true,
  pageTitle: true,
  description: true,
  browserInfo: { expiresAt: true, deletedAt: true, retained: true },
  resolvedAt: true,
  resolvedById: true,
  resolutionNote: true,
  createdAt: true,
  updatedAt: true,
  member: { id: true, firstName: true, lastName: true },
} as const;

const SCREENSHOT_STATE_FIELDS = {
  capturedAt: true,
  expiresAt: true,
  deletedAt: true,
  retained: true,
  withheld: true,
  disposition: true,
} as const;

export const ISSUE_REPORT_LIST_CONNECTION_SHAPE = connectionShapeFor<{
  reports: IssueReportSummaryAnswer[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}>({
  reports: { ...ISSUE_REPORT_FIELDS, screenshot: SCREENSHOT_STATE_FIELDS },
  total: true,
  page: true,
  pageSize: true,
  totalPages: true,
});

export const ISSUE_REPORT_CONNECTION_SHAPE = connectionShapeFor<{ report: IssueReportDetailAnswer | null }>({
  report: { ...ISSUE_REPORT_FIELDS, screenshot: { ...SCREENSHOT_STATE_FIELDS, deleteReason: true } },
});
