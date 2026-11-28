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
const mockRequireActiveSessionUser = vi.fn<(...args: unknown[]) => Promise<Response | null>>(async () => null);
vi.mock("@/lib/session-guards", () => ({
  requireActiveSessionUser: (...args: Parameters<typeof mockRequireActiveSessionUser>) => mockRequireActiveSessionUser(...args),
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

async function withNextAuthUrl<T>(
  nextAuthUrl: string | undefined,
  action: () => Promise<T>
) {
  const originalNextAuthUrl = process.env.NEXTAUTH_URL;

  if (nextAuthUrl === undefined) {
    delete process.env.NEXTAUTH_URL;
  } else {
    process.env.NEXTAUTH_URL = nextAuthUrl;
  }

  try {
    return await action();
  } finally {
    if (originalNextAuthUrl === undefined) {
      delete process.env.NEXTAUTH_URL;
    } else {
      process.env.NEXTAUTH_URL = originalNextAuthUrl;
    }
  }
}

describe("issue reports API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedAuth.mockResolvedValue({
      user: { id: "member-1", role: "MEMBER", accessRoles: [{ role: "USER" }] },
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

  it("uses the configured app origin for relative page URLs", async () => {
    await withNextAuthUrl("https://club.example", async () => {
      const req = new NextRequest("https://proxy.internal/api/issue-reports", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pageUrl: "/book?step=review",
          description:
            "The relative page URL should be stored against the configured app origin.",
        }),
      });

      const res = await POST(req);
      expect(res.status).toBe(201);

      expect(mockedIssueReportCreate).toHaveBeenCalledWith({
        data: expect.objectContaining({
          pageUrl: "https://club.example/book?step=review",
        }),
        select: { id: true },
      });

      expect(mockedSendAdminIssueReportAlert).toHaveBeenCalledWith(
        expect.objectContaining({
          pageUrl: "https://club.example/book?step=review",
          issueReportUrl: "https://club.example/admin/issue-reports?report=issue-1",
        })
      );
    });
  });

  it("never takes the site's address from the request when none is configured", async () => {
    await withNextAuthUrl(undefined, async () => {
      const req = new NextRequest("https://example.org/api/issue-reports", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pageUrl: "/book?step=review",
          description:
            "With no configured address the built-in default is used, not the request's.",
        }),
      });

      const res = await POST(req);
      expect(res.status).toBe(201);

      expect(mockedIssueReportCreate).toHaveBeenCalledWith({
        data: expect.objectContaining({
          pageUrl: "http://localhost:3000/book?step=review",
        }),
        select: { id: true },
      });

      expect(mockedSendAdminIssueReportAlert).toHaveBeenCalledWith(
        expect.objectContaining({
          pageUrl: "http://localhost:3000/book?step=review",
          issueReportUrl: "http://localhost:3000/admin/issue-reports?report=issue-1",
        })
      );
    });
  });

  // GHSA-q9f4-243m-6f54. A caller who can set `X-Forwarded-Host` (or `Host`)
  // used to choose the origin of the link in the officers' alert and of the
  // stored page address. Every case below sends headers and a body that name
  // another site and asserts that only the configured origin comes out.
  it.each([
    {
      name: "a forwarded host that matches the submitted page address",
      requestUrl: "http://127.0.0.1:3000/api/issue-reports",
      headers: {
        "x-forwarded-host": "evil.example",
        "x-forwarded-proto": "https",
      },
      pageUrl: "https://evil.example/admin/audit-log?page=2",
      expected: "https://club.example/admin/audit-log?page=2",
    },
    {
      name: "a Host header that matches the submitted page address",
      requestUrl: "http://127.0.0.1:3000/api/issue-reports",
      headers: { host: "evil.example" },
      pageUrl: "https://evil.example/dashboard#top",
      expected: "https://club.example/dashboard#top",
    },
    {
      name: "a request whose own URL is on the submitted page address's host",
      requestUrl: "https://evil.example/api/issue-reports",
      headers: {},
      pageUrl: "https://evil.example/bookings",
      expected: "https://club.example/bookings",
    },
    {
      name: "Origin and Referer headers naming another site",
      requestUrl: "http://127.0.0.1:3000/api/issue-reports",
      headers: {
        Origin: "https://evil.example",
        Referer: "https://evil.example/dashboard",
      },
      pageUrl: "https://evil.example/admin/audit-log?page=2",
      expected: "https://club.example/admin/audit-log?page=2",
    },
    {
      name: "a path that starts with two slashes",
      requestUrl: "http://127.0.0.1:3000/api/issue-reports",
      headers: { "x-forwarded-host": "evil.example" },
      pageUrl: "https://club.example//evil.example/phish",
      expected: "https://club.example/evil.example/phish",
    },
    {
      name: "a scheme-relative address",
      requestUrl: "http://127.0.0.1:3000/api/issue-reports",
      headers: {},
      pageUrl: "//evil.example/phish",
      expected: "https://club.example/phish",
    },
    {
      name: "credentials and a port in the submitted address",
      requestUrl: "http://127.0.0.1:3000/api/issue-reports",
      headers: {},
      pageUrl: "https://club.example:443@evil.example:8443/phish?x=1",
      expected: "https://club.example/phish?x=1",
    },
  ])(
    "keeps only the page of this site and links only to the configured origin: $name",
    async ({ requestUrl, headers, pageUrl, expected }) => {
      await withNextAuthUrl("https://club.example", async () => {
        const req = new NextRequest(requestUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(headers as Record<string, string>),
          },
          body: JSON.stringify({
            pageUrl,
            pageTitle: "Audit Log",
            description: "No host from the request or its body may be kept.",
          }),
        });

        const res = await POST(req);
        expect(res.status).toBe(201);

        expect(mockedIssueReportCreate).toHaveBeenCalledWith({
          data: expect.objectContaining({ pageUrl: expected }),
          select: { id: true },
        });
        expect(mockedSendAdminIssueReportAlert).toHaveBeenCalledWith(
          expect.objectContaining({
            pageUrl: expected,
            issueReportUrl:
              "https://club.example/admin/issue-reports?report=issue-1",
          })
        );

        const stored = JSON.stringify(mockedIssueReportCreate.mock.calls);
        const emailed = JSON.stringify(
          mockedSendAdminIssueReportAlert.mock.calls
        );
        const audited = JSON.stringify(mockedLogAudit.mock.calls);
        for (const written of [stored, emailed, audited]) {
          expect(written).not.toContain("//evil.example");
          expect(written).not.toContain("@evil.example");
        }
      });
    }
  );

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

  it.each([
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "ftp://club.example/file",
    "dashboard",
    "\\\\evil.example\\phish",
  ])("rejects a page address that is not a page of a website: %s", async (pageUrl) => {
    await withNextAuthUrl("https://club.example", async () => {
      const req = new NextRequest("https://club.example/api/issue-reports", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pageUrl,
          description: "This should be rejected because it names no page of this site.",
        }),
      });

      const res = await POST(req);
      expect(res.status).toBe(400);
      expect(mockedIssueReportCreate).not.toHaveBeenCalled();
      expect(mockedSendAdminIssueReportAlert).not.toHaveBeenCalled();
    });
  });

  it("rejects a page address that no longer fits once it is placed on this site's origin", async () => {
    await withNextAuthUrl("https://a-long-club-name.example", async () => {
      // 2,048 characters as submitted, so the schema accepts it; longer than
      // the column once the short host is replaced by the configured one.
      const pageUrl = `http://a/${"x".repeat(2048 - "http://a/".length)}`;
      expect(pageUrl).toHaveLength(2048);
      const req = new NextRequest("https://a-long-club-name.example/api/issue-reports", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pageUrl,
          description: "A re-based address must still fit the stored column.",
        }),
      });

      const res = await POST(req);
      expect(res.status).toBe(400);
      expect(mockedIssueReportCreate).not.toHaveBeenCalled();
      expect(mockedSendAdminIssueReportAlert).not.toHaveBeenCalled();
    });
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
