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

const mockedPrisma = vi.mocked(prisma);
const mockedAuth = vi.mocked(auth);
const mockedLogAudit = vi.mocked(logAudit);
const mockedSendAdminIssueReportAlert = vi.mocked(sendAdminIssueReportAlert);

describe("issue reports API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedAuth.mockResolvedValue({
      user: { id: "member-1", role: "MEMBER" },
    } as never);
    mockedPrisma.member.count.mockResolvedValue(1 as never);
    mockedPrisma.member.findUnique.mockResolvedValue({
      id: "member-1",
      firstName: "Casey",
      lastName: "Member",
      email: "casey@example.com",
    } as never);
    mockedPrisma.issueReport.create.mockResolvedValue({ id: "issue-1" } as never);
    mockedSendAdminIssueReportAlert.mockResolvedValue(undefined as never);
  });

  it("stores the report and sends admin notifications", async () => {
    const req = new NextRequest("http://localhost/api/issue-reports", {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": "Vitest Browser" },
      body: JSON.stringify({
        pageUrl: "http://localhost/book",
        pageTitle: "Book | TAC Bookings",
        description: "The review step shows the wrong guest ages after editing the guest list.",
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(201);

    expect(mockedPrisma.issueReport.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        memberId: "member-1",
        pageUrl: "http://localhost/book",
        pageTitle: "Book | TAC Bookings",
        browserInfo: "Vitest Browser",
      }),
      select: { id: true },
    });

    expect(mockedSendAdminIssueReportAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        memberName: "Casey Member",
        memberEmail: "casey@example.com",
        pageUrl: "http://localhost/book",
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

  it("rejects invalid screenshot payloads", async () => {
    const req = new NextRequest("http://localhost/api/issue-reports", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pageUrl: "http://localhost/book",
        description: "The screenshot upload should be rejected when the payload is malformed.",
        screenshotDataUrl: "not-a-valid-data-url",
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(400);
    expect(mockedPrisma.issueReport.create).not.toHaveBeenCalled();
    expect(mockedSendAdminIssueReportAlert).not.toHaveBeenCalled();
  });
});
