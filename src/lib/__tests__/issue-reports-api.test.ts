import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    member: {
      count: vi.fn(),
      findUnique: vi.fn(),
    },
    issueReport: {
      create: vi.fn(),
    },
    auditLog: {
      create: vi.fn(),
    },
  },
}));

vi.mock("@/lib/auth", () => ({
  auth: vi.fn(),
}));
const mockRequireActiveSessionUser = vi.fn(async () => null);
vi.mock("@/lib/session-guards", () => ({
  requireActiveSessionUser: (...args: unknown[]) => mockRequireActiveSessionUser(...args),
}));

vi.mock("@/lib/audit", () => ({
  logAudit: vi.fn(),
}));

vi.mock("@/lib/email", () => ({
  sendAdminIssueReportAlert: vi.fn(),
}));

vi.mock("@/lib/logger", () => ({
  default: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { prisma } from "@/lib/prisma";
import { auth } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { sendAdminIssueReportAlert } from "@/lib/email";
import { POST } from "@/app/api/issue-reports/route";

const mockedAuth = vi.mocked(auth);
const mockedLogAudit = vi.mocked(logAudit);
const mockedSendAdminIssueReportAlert = vi.mocked(sendAdminIssueReportAlert);
const mockedMemberCount = vi.mocked(prisma.member.count);
const mockedMemberFindUnique = vi.mocked(prisma.member.findUnique);
const mockedIssueReportCreate = vi.mocked(prisma.issueReport.create);

describe("issue reports API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedAuth.mockResolvedValue({
      user: { id: "member-1", role: "MEMBER" },
    } as never);
    mockedMemberCount.mockResolvedValue(1 as never);
    mockedMemberFindUnique.mockResolvedValue({
      id: "member-1",
      firstName: "Casey",
      lastName: "Member",
      email: "casey@example.com",
    } as never);
    mockedIssueReportCreate.mockResolvedValue({ id: "issue-1" } as never);
    mockedSendAdminIssueReportAlert.mockResolvedValue(undefined as never);
  });

  it("stores the report and sends admin notifications", async () => {
    const req = new NextRequest("http://localhost:3000/api/issue-reports", {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": "Vitest Browser" },
      body: JSON.stringify({
        pageUrl: "http://localhost:3000/book",
        pageTitle: "Book | TAC Bookings",
        description: "The review step shows the wrong guest ages after editing the guest list.",
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(201);

    expect(mockedIssueReportCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        memberId: "member-1",
        pageUrl: "http://localhost:3000/book",
        pageTitle: "Book | TAC Bookings",
        browserInfo: "Vitest Browser",
        browserInfoExpiresAt: expect.any(Date),
        screenshotDataUrl: null,
        screenshotCapturedAt: null,
        screenshotExpiresAt: null,
      }),
      select: { id: true },
    });

    expect(mockedSendAdminIssueReportAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        memberName: "Casey Member",
        memberEmail: "casey@example.com",
        pageUrl: "http://localhost:3000/book",
        issueReportUrl: "http://localhost:3000/admin/issue-reports?report=issue-1",
        hasScreenshot: false,
      })
    );

    expect(mockedLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "issue.reported",
        memberId: "member-1",
        targetId: "issue-1",
      })
    );
  });

  it("normalizes relative page URLs to same-origin absolute URLs", async () => {
    const req = new NextRequest("https://tokoroa.org.nz/api/issue-reports", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pageUrl: "/book?step=review",
        description: "The relative page URL should be stored as an internal absolute link.",
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(201);

    expect(mockedIssueReportCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        pageUrl: "https://tokoroa.org.nz/book?step=review",
      }),
      select: { id: true },
    });

    expect(mockedSendAdminIssueReportAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        pageUrl: "https://tokoroa.org.nz/book?step=review",
      })
    );
  });

  it("accepts public page URLs when the app is behind a local proxy origin", async () => {
    const req = new NextRequest("http://127.0.0.1:3000/api/issue-reports", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://tokoroa.org.nz",
      },
      body: JSON.stringify({
        pageUrl: "https://tokoroa.org.nz/admin/audit-log?page=2",
        pageTitle: "Audit Log",
        description: "The report should keep the public page URL from the browser.",
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(201);

    expect(mockedIssueReportCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        pageUrl: "https://tokoroa.org.nz/admin/audit-log?page=2",
      }),
      select: { id: true },
    });

    expect(mockedSendAdminIssueReportAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        pageUrl: "https://tokoroa.org.nz/admin/audit-log?page=2",
        issueReportUrl: "https://tokoroa.org.nz/admin/issue-reports?report=issue-1",
      })
    );
  });

  it("stores screenshots for in-app review without emailing attachments", async () => {
    const screenshotDataUrl = `data:image/png;base64,${Buffer.from("png").toString("base64")}`;
    const req = new NextRequest("http://localhost:3000/api/issue-reports", {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": "Vitest Browser" },
      body: JSON.stringify({
        pageUrl: "http://localhost:3000/book",
        description: "The screenshot should stay inside the admin issue report surface.",
        screenshotDataUrl,
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(201);

    expect(mockedIssueReportCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        screenshotDataUrl,
        screenshotCapturedAt: expect.any(Date),
        screenshotExpiresAt: expect.any(Date),
      }),
      select: { id: true },
    });
    expect(mockedSendAdminIssueReportAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        hasScreenshot: true,
      })
    );
    expect(mockedSendAdminIssueReportAlert).not.toHaveBeenCalledWith(
      expect.objectContaining({
        screenshot: expect.anything(),
      })
    );
  });

  it("rejects external page URLs", async () => {
    const req = new NextRequest("https://tokoroa.org.nz/api/issue-reports", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pageUrl: "https://evil.example/phish",
        description: "This should be rejected because it points outside the app origin.",
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(400);
    expect(mockedIssueReportCreate).not.toHaveBeenCalled();
    expect(mockedSendAdminIssueReportAlert).not.toHaveBeenCalled();
  });

  it("rejects invalid screenshot payloads", async () => {
    const req = new NextRequest("http://localhost:3000/api/issue-reports", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pageUrl: "http://localhost:3000/book",
        description: "The screenshot upload should be rejected when the payload is malformed.",
        screenshotDataUrl: "not-a-valid-data-url",
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(400);
    expect(mockedIssueReportCreate).not.toHaveBeenCalled();
    expect(mockedSendAdminIssueReportAlert).not.toHaveBeenCalled();
  });
});
