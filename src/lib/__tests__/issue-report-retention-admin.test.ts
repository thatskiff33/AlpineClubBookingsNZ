import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  requireActiveSessionUser: vi.fn(async () => null),
  logAudit: vi.fn(),
  issueReportFindMany: vi.fn(),
  issueReportCount: vi.fn(),
  issueReportFindUnique: vi.fn(),
  issueReportUpdate: vi.fn(),
  issueReportUpdateMany: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  auth: mocks.auth,
}));

vi.mock("@/lib/session-guards", () => ({
  requireActiveSessionUser: mocks.requireActiveSessionUser,
}));

vi.mock("@/lib/audit", () => ({
  logAudit: mocks.logAudit,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    issueReport: {
      findMany: mocks.issueReportFindMany,
      count: mocks.issueReportCount,
      findUnique: mocks.issueReportFindUnique,
      update: mocks.issueReportUpdate,
      updateMany: mocks.issueReportUpdateMany,
    },
  },
}));

vi.mock("@/lib/logger", () => ({
  default: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { redactExpiredIssueReportSensitiveData } from "@/lib/issue-report-retention";
import { GET as listIssueReports } from "@/app/api/admin/issue-reports/route";
import {
  GET as getIssueReport,
  PATCH as patchIssueReport,
} from "@/app/api/admin/issue-reports/[id]/route";

function adminSession() {
  mocks.auth.mockResolvedValue({
    user: { id: "admin-1", role: "ADMIN" },
  } as never);
}

function memberSession() {
  mocks.auth.mockResolvedValue({
    user: { id: "member-1", role: "MEMBER" },
  } as never);
}

function reportRecord() {
  return {
    id: "issue-1",
    pageUrl: "https://tac.example/book",
    pageTitle: "Book",
    description: "Something broke on the booking form.",
    screenshotDataUrl: "data:image/png;base64,cG5n",
    screenshotCapturedAt: new Date("2026-05-11T00:00:00Z"),
    screenshotExpiresAt: new Date("2026-06-10T00:00:00Z"),
    screenshotDeletedAt: null,
    screenshotDeletedById: null,
    screenshotDeleteReason: null,
    browserInfo: "Vitest Browser",
    browserInfoExpiresAt: new Date("2026-06-10T00:00:00Z"),
    browserInfoDeletedAt: null,
    resolvedAt: null,
    resolvedById: null,
    resolutionNote: null,
    createdAt: new Date("2026-05-11T00:00:00Z"),
    updatedAt: new Date("2026-05-11T00:00:00Z"),
    member: {
      id: "member-1",
      firstName: "Casey",
      lastName: "Member",
      email: "casey@example.com",
    },
  };
}

describe("issue report retention and admin triage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireActiveSessionUser.mockResolvedValue(null);
  });

  it("redacts expired screenshots and browser info", async () => {
    const now = new Date("2026-06-11T00:00:00Z");
    mocks.issueReportUpdateMany
      .mockResolvedValueOnce({ count: 2 })
      .mockResolvedValueOnce({ count: 3 });

    const result = await redactExpiredIssueReportSensitiveData(now);

    expect(result).toEqual({
      screenshotsRedacted: 2,
      browserInfoRedacted: 3,
    });
    expect(mocks.issueReportUpdateMany).toHaveBeenNthCalledWith(1, {
      where: {
        screenshotDataUrl: { not: null },
        screenshotExpiresAt: { lte: now },
      },
      data: {
        screenshotDataUrl: null,
        screenshotDeletedAt: now,
        screenshotDeletedById: null,
        screenshotDeleteReason: "retention_expired",
      },
    });
    expect(mocks.issueReportUpdateMany).toHaveBeenNthCalledWith(2, {
      where: {
        browserInfo: { not: null },
        browserInfoExpiresAt: { lte: now },
      },
      data: {
        browserInfo: null,
        browserInfoDeletedAt: now,
      },
    });
  });

  it("requires admin access to view issue reports", async () => {
    memberSession();

    const response = await getIssueReport(
      new NextRequest("http://localhost/api/admin/issue-reports/issue-1"),
      { params: Promise.resolve({ id: "issue-1" }) }
    );

    expect(response.status).toBe(403);
    expect(mocks.issueReportFindUnique).not.toHaveBeenCalled();
  });

  it("lists issue reports without selecting screenshot blobs", async () => {
    adminSession();
    mocks.issueReportFindMany.mockResolvedValue([reportRecord()]);
    mocks.issueReportCount.mockResolvedValue(1);

    const response = await listIssueReports(
      new NextRequest("http://localhost/api/admin/issue-reports?status=OPEN")
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.reports[0].screenshot.retained).toBe(true);
    expect(body.reports[0].screenshot.dataUrl).toBeUndefined();
    expect(mocks.issueReportFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.not.objectContaining({
          screenshotDataUrl: true,
        }),
      })
    );
  });

  it("returns detail screenshots through the audited admin route", async () => {
    adminSession();
    mocks.issueReportFindUnique.mockResolvedValue(reportRecord());

    const response = await getIssueReport(
      new NextRequest("http://localhost/api/admin/issue-reports/issue-1"),
      { params: Promise.resolve({ id: "issue-1" }) }
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.report.screenshot.dataUrl).toBe("data:image/png;base64,cG5n");
    expect(mocks.logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "issue_report.admin_viewed",
        memberId: "admin-1",
        targetId: "issue-1",
      })
    );
  });

  it("deletes screenshots without deleting report metadata", async () => {
    adminSession();
    mocks.issueReportFindUnique
      .mockResolvedValueOnce({
        id: "issue-1",
        screenshotDataUrl: "data:image/png;base64,cG5n",
        screenshotDeletedAt: null,
      })
      .mockResolvedValueOnce({
        ...reportRecord(),
        screenshotDataUrl: null,
        screenshotDeletedAt: new Date("2026-05-11T01:00:00Z"),
        screenshotDeletedById: "admin-1",
        screenshotDeleteReason: "Sensitive data visible",
      });
    mocks.issueReportUpdate.mockResolvedValue({ id: "issue-1" });

    const response = await patchIssueReport(
      new NextRequest("http://localhost/api/admin/issue-reports/issue-1", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "deleteScreenshot",
          reason: "Sensitive data visible",
        }),
      }),
      { params: Promise.resolve({ id: "issue-1" }) }
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mocks.issueReportUpdate).toHaveBeenCalledWith({
      where: { id: "issue-1" },
      data: expect.objectContaining({
        screenshotDataUrl: null,
        screenshotDeletedById: "admin-1",
        screenshotDeleteReason: "Sensitive data visible",
      }),
    });
    expect(body.report.screenshot.dataUrl).toBeNull();
    expect(mocks.logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "issue_report.screenshot_deleted",
        memberId: "admin-1",
        targetId: "issue-1",
      })
    );
  });
});
