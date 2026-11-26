/**
 * The Support area's records: the audit log and the problem reports members
 * send. Part of the Support & System officer actions (ALP-724): spread into
 * `MCP_ACTIONS`.
 *
 * The audit log keeps its visibility rules (`INV-PRIV`, the audit log guide):
 * a connection is read by a model, so it reads only the categories its
 * officer's areas may correlate, as AI Diagnostics does; the route decides
 * that, not the app's filters.
 *
 * Kinds: each decision on a problem report is `destructive`. It changes
 * another person's report (owner decision, #5305 comment 7092977781), and
 * deleting the screenshot cannot be undone. Problem reports are sent from the
 * website (`needs-browser`): an app reads and decides them, never sends one.
 */
import { adminAuditLogQuerySchema } from "@/lib/audit-admin-query";
import {
  issueReportDeleteScreenshotBodySchema,
  issueReportListQuerySchema,
  issueReportResolveBodySchema,
} from "@/lib/admin-support-api/system";
import {
  ADMIN_AUDIT_LOG_CONNECTION_SHAPE,
  ISSUE_REPORT_CONNECTION_SHAPE,
  ISSUE_REPORT_LIST_CONNECTION_SHAPE,
} from "@/lib/connection-shapes/support-records";
import { routeIdParamsSchema } from "@/lib/route-id-params";

import type { McpAction } from "../catalogue";

export const SUPPORT_RECORD_MCP_ACTIONS: readonly McpAction[] = [
  // --- The audit log ----------------------------------------------------------
  {
    id: "search_audit_log",
    title: "Search the audit log",
    summary:
      "Officer: what the site recorded, newest first, with who acted, who it affected, the outcome and a summary. Filter by `eventType` (the recorded action), `category`, `memberId` with `memberScope` (`involves`, `actor` or `subject`), `from` and `to` (YYYY-MM-DD, club days), `outcome`, `severity`, `entityType`, or free text `q`; page with `page` and `pageSize`. Only entries in categories this officer's areas may read are searched: Support alone reads admin, security and system; booking needs Bookings, payment and xero Finance, lodge Lodge Operations, and account, family, communication and privacy Membership.",
    method: "GET",
    path: "/api/admin/audit-log",
    query: adminAuditLogQuerySchema,
    kind: "read",
    returns: ADMIN_AUDIT_LOG_CONNECTION_SHAPE,
    core: false,
  },

  // --- Problem reports --------------------------------------------------------
  {
    id: "list_issue_reports",
    title: "List problem reports",
    summary:
      "Officer: problem reports members sent from the website, newest first: `OPEN` by default, or `RESOLVED` or `ALL`. Each has the page it came from, what the member wrote, who sent it, whether a screenshot is still kept, and how it was resolved. Every read is recorded in the audit log.",
    method: "GET",
    path: "/api/admin/issue-reports",
    query: issueReportListQuerySchema,
    kind: "read",
    returns: ISSUE_REPORT_LIST_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "get_issue_report",
    title: "Read a problem report",
    summary:
      "Officer: one problem report (`id` from `list_issue_reports`) as `list_issue_reports` shows it, with why a screenshot was deleted. The screenshot itself is never sent; open it on the website. Every read is recorded in the audit log.",
    method: "GET",
    path: "/api/admin/issue-reports/[id]",
    params: routeIdParamsSchema,
    kind: "read",
    returns: ISSUE_REPORT_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "resolve_issue_report",
    title: "Resolve a problem report",
    summary:
      "Officer: marks a problem report (`id` from `list_issue_reports`) resolved, with an optional `note` of what was done. Answers the report.",
    method: "PATCH",
    path: "/api/admin/issue-reports/[id]",
    params: routeIdParamsSchema,
    body: issueReportResolveBodySchema,
    fixedBody: { action: "resolve" },
    kind: "destructive",
    returns: ISSUE_REPORT_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "reopen_issue_report",
    title: "Reopen a problem report",
    summary:
      "Officer: opens a resolved problem report (`id` from `list_issue_reports`) again, clearing its resolution note. Answers the report.",
    method: "PATCH",
    path: "/api/admin/issue-reports/[id]",
    params: routeIdParamsSchema,
    fixedBody: { action: "reopen" },
    kind: "destructive",
    returns: ISSUE_REPORT_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "delete_issue_report_screenshot",
    title: "Delete a problem report's screenshot",
    summary:
      "Officer: deletes a problem report's screenshot (`id` from `list_issue_reports`) before it expires, with an optional `reason`. It cannot be undone. Answers the report.",
    method: "PATCH",
    path: "/api/admin/issue-reports/[id]",
    params: routeIdParamsSchema,
    body: issueReportDeleteScreenshotBodySchema,
    fixedBody: { action: "deleteScreenshot" },
    kind: "destructive",
    returns: ISSUE_REPORT_CONNECTION_SHAPE,
    core: false,
  },
];
