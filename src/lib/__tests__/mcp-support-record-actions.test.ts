/**
 * ALP-724 (`INV-MCP-006`, `INV-PRIV`): the audit log and problem report
 * actions an officer's AI app connection may run. Each route answers the
 * browser as before; the connection gets exactly the action's `returns`
 * fields (`expectActionContract`). Every handler runs twice (connection, then
 * browser), so the mocks answer both runs.
 *
 * The audit log keeps its visibility rules: a connection is read by a model,
 * so it searches only the categories its officer's areas may correlate, as
 * AI Diagnostics does (`auditCategoriesReadableWith`), whatever the app's
 * filters say. The officer's own screen still reads every entry.
 *
 * What a connection must never be sent here: email or IP addresses, browser
 * details, an audit entry's raw metadata, or a problem report's screenshot.
 */
import type { Session } from "next-auth";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  prisma: {
    auditLog: { findMany: vi.fn(), count: vi.fn() },
    member: { findMany: vi.fn() },
    issueReport: { findMany: vi.fn(), findUnique: vi.fn(), count: vi.fn(), update: vi.fn() },
  },
  requireAdmin: vi.fn(),
  logAudit: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/session-guards", () => ({ requireAdmin: h.requireAdmin }));
vi.mock("@/lib/prisma", () => ({ prisma: h.prisma }));
vi.mock("@/lib/audit", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/audit")),
  logAudit: h.logAudit,
}));
vi.mock("@/lib/club-time/server", () => ({ clubTimeZone: async () => "Pacific/Auckland" }));
vi.mock("@/lib/club-format-server", () => ({
  clubFormatValues: async () => ({ currencyCode: "NZD", locale: "en-NZ" }),
}));

import { GET as getAuditLog } from "@/app/api/admin/audit-log/route";
import { GET as getIssueReport, PATCH as patchIssueReport } from "@/app/api/admin/issue-reports/[id]/route";
import { GET as listIssueReports } from "@/app/api/admin/issue-reports/route";
import {
  buildActionRequest,
  expectActionContract,
  officerMemberSession,
} from "@/lib/__tests__/helpers/mcp-action-contract";
import { adminSession } from "@/lib/__tests__/helpers/sessions";
import { emptyAdminPermissionMatrix, type AdminPermissionMatrix } from "@/lib/admin-permissions";
import { AUDIT_CATEGORIES } from "@/lib/audit-categories";
import { findMcpAction, splitMcpActionArguments } from "@/lib/mcp/catalogue";
import { SUPPORT_RECORD_MCP_ACTIONS } from "@/lib/mcp/catalogue/support-records";

const STAMP = new Date("2026-06-30T00:00:00.000Z");

function officerWith(matrix: Partial<AdminPermissionMatrix>): Session {
  return adminSession({
    id: "officer-2",
    accessRoles: ["USER"],
    adminPermissionMatrix: { ...emptyAdminPermissionMatrix(), ...matrix },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  h.requireAdmin.mockResolvedValue({ ok: true, session: officerMemberSession() });
});

describe("the record entries", () => {
  it("are officer actions: reads for GET, destructive otherwise, none core", () => {
    for (const action of SUPPORT_RECORD_MCP_ACTIONS) {
      expect(action.summary.startsWith("Officer: "), action.id).toBe(true);
      expect(action.kind, action.id).toBe(action.method === "GET" ? "read" : "destructive");
      expect(action.core, action.id).toBe(false);
    }
  });

  it("never names an email address, a screenshot, browser details or metadata", () => {
    for (const action of SUPPORT_RECORD_MCP_ACTIONS) {
      expect(JSON.stringify(action.returns), action.id).not.toMatch(/email|dataUrl|userAgent|ipAddress|metadata|"value"/);
    }
  });
});

// ---------------------------------------------------------------------------
// The audit log
// ---------------------------------------------------------------------------

const AUDIT_ROW = {
  id: "audit-7",
  action: "MEMBER_UPDATED",
  memberId: "officer-9",
  targetId: "member-1",
  details: "Changed phone",
  ipAddress: "203.0.113.9",
  createdAt: STAMP,
  actorMemberId: "officer-9",
  subjectMemberId: "member-1",
  entityType: "Member",
  entityId: "member-1",
  category: "admin",
  severity: "info",
  outcome: "success",
  summary: "Member updated",
  metadata: { previousEmail: "old@example.test" },
  requestId: "request-1",
  userAgent: "Mozilla/5.0",
  retentionClass: "standard",
};

const PEOPLE = [
  { id: "officer-9", firstName: "Ana", lastName: "Reid", email: "ana@example.test", role: "ADMIN" },
  { id: "member-1", firstName: "Rua", lastName: "Tane", email: "rua@example.test", role: "USER" },
];

/** The `where` of the page read (not the filter-list reads, which pass `distinct`). */
function pageWheres(): unknown[] {
  return h.prisma.auditLog.findMany.mock.calls
    .map(([args]) => args as { where?: unknown; distinct?: unknown })
    .filter((args) => args.distinct === undefined)
    .map((args) => args.where);
}

describe("search_audit_log", () => {
  beforeEach(() => {
    h.prisma.auditLog.findMany.mockImplementation(async (args: { distinct?: unknown }) =>
      args.distinct ? [] : [AUDIT_ROW],
    );
    h.prisma.auditLog.count.mockResolvedValue(1);
    h.prisma.member.findMany.mockResolvedValue(PEOPLE);
  });

  it("sends each entry's people by name only, without addresses, browser details or metadata", async () => {
    const { connection, browser } = await expectActionContract({
      actionId: "search_audit_log",
      handler: getAuditLog,
      args: { memberId: "member-1", memberScope: "subject" },
    });
    const sent = JSON.stringify(connection);
    for (const hidden of ["ana@example.test", "203.0.113.9", "Mozilla", "old@example.test"]) {
      expect(sent).not.toContain(hidden);
    }
    expect(connection).toMatchObject({ data: [{ id: "audit-7", actor: { firstName: "Ana" }, requestId: "request-1" }] });
    expect(JSON.stringify(browser)).toContain("203.0.113.9");
    expect(browser).toHaveProperty("facets");
  });

  it("searches a Full Admin's connection in every category, and never an uncategorised entry", async () => {
    await expectActionContract({ actionId: "search_audit_log", handler: getAuditLog });
    const [connectionWhere, browserWhere] = pageWheres();
    expect(connectionWhere).toEqual({
      AND: [browserWhere, { category: { in: [...AUDIT_CATEGORIES] } }],
    });
  });

  it("searches a Support-only connection in admin, security and system alone, whatever the app filters on", async () => {
    h.requireAdmin.mockResolvedValue({ ok: true, session: officerWith({ support: "view" }) });
    const action = findMcpAction("search_audit_log")!;
    const { request } = buildActionRequest(action, { category: "communication" }, true);
    const response = await getAuditLog(request as never);
    expect(response.status).toBe(200);
    expect(pageWheres()[0]).toEqual({
      AND: [expect.anything(), { category: { in: ["admin", "security", "system"] } }],
    });
  });

  it("adds an area's categories once the officer holds it", async () => {
    h.requireAdmin.mockResolvedValue({ ok: true, session: officerWith({ support: "view", finance: "view" }) });
    const { request } = buildActionRequest(findMcpAction("search_audit_log")!, {}, true);
    await getAuditLog(request as never);
    expect(pageWheres()[0]).toEqual({
      AND: [expect.anything(), { category: { in: ["payment", "admin", "security", "xero", "system"] } }],
    });
  });

  it("leaves the officer's own screen unrestricted", async () => {
    h.requireAdmin.mockResolvedValue({ ok: true, session: officerWith({ support: "view" }) });
    const { request } = buildActionRequest(findMcpAction("search_audit_log")!, {}, false);
    await getAuditLog(request as never);
    expect(JSON.stringify(pageWheres()[0])).not.toContain('"in"');
  });
});

// ---------------------------------------------------------------------------
// Problem reports
// ---------------------------------------------------------------------------

const REPORT = {
  id: "report-1",
  pageUrl: "/bookings/new",
  pageTitle: "New booking",
  description: "The calendar would not load.",
  screenshotDataUrl: "data:image/png;base64,AAAA",
  screenshotOrigin: "MEMBER",
  screenshotCapturedAt: STAMP,
  screenshotExpiresAt: new Date("2099-01-01T00:00:00.000Z"),
  screenshotDeletedAt: null,
  screenshotDeletedById: "officer-9",
  screenshotDeleteReason: "Not needed",
  browserInfo: "Mozilla/5.0 (Example)",
  browserInfoExpiresAt: new Date("2099-01-01T00:00:00.000Z"),
  browserInfoDeletedAt: null,
  resolvedAt: STAMP,
  resolvedById: "officer-9",
  resolutionNote: "Fixed the calendar.",
  createdAt: STAMP,
  updatedAt: STAMP,
  member: { id: "member-1", firstName: "Rua", lastName: "Tane", email: "rua@example.test" },
};

describe("list_issue_reports and get_issue_report", () => {
  it("lists reports without the reporter's email address", async () => {
    h.prisma.issueReport.findMany.mockResolvedValue([REPORT]);
    h.prisma.issueReport.count.mockResolvedValue(1);
    const { connection, browser } = await expectActionContract({
      actionId: "list_issue_reports",
      handler: listIssueReports,
      args: { status: "ALL" },
    });
    expect(JSON.stringify(connection)).not.toContain("rua@example.test");
    expect(JSON.stringify(browser)).toContain("rua@example.test");
    expect(h.prisma.issueReport.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: {} }));
  });

  it("reads one report without its screenshot or browser details, which the browser still gets", async () => {
    h.prisma.issueReport.findUnique.mockResolvedValue(REPORT);
    const { connection, browser } = await expectActionContract({
      actionId: "get_issue_report",
      handler: getIssueReport,
      args: { id: "report-1" },
    });
    const sent = JSON.stringify(connection);
    expect(sent).not.toContain("data:image");
    expect(sent).not.toContain("Mozilla");
    expect(JSON.stringify(browser)).toContain("data:image");
    // The read is recorded, as on the website.
    expect(h.logAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "issue_report.admin_viewed", targetId: "report-1" }));
  });
});

describe("the problem report decisions", () => {
  beforeEach(() => {
    h.prisma.issueReport.findUnique.mockResolvedValue(REPORT);
    h.prisma.issueReport.update.mockResolvedValue(REPORT);
  });

  it("resolve_issue_report resolves with the note", async () => {
    const { connection } = await expectActionContract({
      actionId: "resolve_issue_report",
      handler: patchIssueReport,
      args: { id: "report-1", note: "Fixed the calendar." },
    });
    expect(JSON.stringify(connection)).not.toContain("data:image");
    expect(h.prisma.issueReport.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ resolutionNote: "Fixed the calendar." }) }),
    );
  });

  it("reopen_issue_report clears the resolution", async () => {
    await expectActionContract({ actionId: "reopen_issue_report", handler: patchIssueReport, args: { id: "report-1" } });
    expect(h.prisma.issueReport.update).toHaveBeenCalledWith({
      where: { id: "report-1" },
      data: { resolvedAt: null, resolvedById: null, resolutionNote: null },
    });
  });

  it("delete_issue_report_screenshot deletes the screenshot with the reason", async () => {
    await expectActionContract({
      actionId: "delete_issue_report_screenshot",
      handler: patchIssueReport,
      args: { id: "report-1", reason: "Shows a card" },
    });
    expect(h.prisma.issueReport.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ screenshotDataUrl: null, screenshotDeleteReason: "Shows a card" }),
      }),
    );
  });

  it("sends each decision's fixed `action`, whatever the app adds", () => {
    for (const [id, decision] of [
      ["resolve_issue_report", "resolve"],
      ["reopen_issue_report", "reopen"],
      ["delete_issue_report_screenshot", "deleteScreenshot"],
    ] as const) {
      const { body } = splitMcpActionArguments(findMcpAction(id)!, { id: "report-1", action: "deleteScreenshot" });
      expect(body, id).toMatchObject({ action: decision });
    }
  });
});
