import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  requireActiveSessionUser: vi.fn(),
  noticeCreate: vi.fn(),
  noticeUpdate: vi.fn(),
  noticeDelete: vi.fn(),
  noticeFindUnique: vi.fn(),
  noticeFindMany: vi.fn(),
  noticeUpdateMany: vi.fn(),
  audienceDeleteMany: vi.fn(),
  audienceCreateMany: vi.fn(),
  auditLogCreate: vi.fn(),
  receiptGroupBy: vi.fn(),
  memberCount: vi.fn(),
  membershipTypeCount: vi.fn(),
  lodgeCount: vi.fn(),
  committeeRoleCount: vi.fn(),
  transaction: vi.fn(),
  buildStructuredAuditLogCreateArgs: vi.fn((event) => ({ data: event })),
  getAuditRequestContext: vi.fn(() => ({ id: "req-1" })),
  sendNoticePublishedEmails: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ auth: mocks.auth }));

vi.mock("@/lib/session-guards", async () => ({
  requireAdmin: (await import("./helpers/require-admin-mock"))
    .evaluateRequireAdminMock,
  requireActiveSessionUser: mocks.requireActiveSessionUser,
}));

vi.mock("@/lib/audit", () => ({
  buildStructuredAuditLogCreateArgs: mocks.buildStructuredAuditLogCreateArgs,
  getAuditRequestContext: mocks.getAuditRequestContext,
}));

vi.mock("@/lib/notices-email", () => ({
  sendNoticePublishedEmails: mocks.sendNoticePublishedEmails,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    notice: {
      create: mocks.noticeCreate,
      update: mocks.noticeUpdate,
      delete: mocks.noticeDelete,
      findUnique: mocks.noticeFindUnique,
      findMany: mocks.noticeFindMany,
      updateMany: mocks.noticeUpdateMany,
    },
    noticeAudience: {
      deleteMany: mocks.audienceDeleteMany,
      createMany: mocks.audienceCreateMany,
    },
    auditLog: { create: mocks.auditLogCreate },
    noticeReadReceipt: { groupBy: mocks.receiptGroupBy },
    member: { count: mocks.memberCount },
    membershipType: { count: mocks.membershipTypeCount },
    lodge: { count: mocks.lodgeCount },
    committeeRole: { count: mocks.committeeRoleCount },
    $transaction: mocks.transaction,
  },
}));

import {
  GET as listNotices,
  POST as createNotice,
} from "@/app/api/admin/notices/route";
import {
  DELETE as deleteNotice,
  PATCH as patchNotice,
} from "@/app/api/admin/notices/[id]/route";

const adminSession = {
  user: { id: "admin-1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }] },
};
const memberSession = {
  user: { id: "member-1", role: "MEMBER", accessRoles: [{ role: "USER" }] },
};

function noticeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "notice-1",
    title: "Hut closed",
    bodyHtml: "<p>Closed</p>",
    status: "DRAFT",
    publishedAt: null,
    expiresAt: null,
    pinned: false,
    requiresAcknowledgement: false,
    financialMembersOnly: false,
    emailedAt: null,
    createdByMemberId: "admin-1",
    updatedByMemberId: "admin-1",
    createdAt: new Date("2026-07-10T00:00:00.000Z"),
    updatedAt: new Date("2026-07-10T00:00:00.000Z"),
    ...overrides,
  };
}

function request(url: string, body: unknown, method = "POST") {
  return new NextRequest(url, {
    method,
    headers: { "Content-Type": "application/json", "x-request-id": "req-1" },
    body: JSON.stringify(body),
  });
}

function params(id: string) {
  return { params: Promise.resolve({ id }) };
}

const validCreateBody = {
  title: "Hut closed",
  bodyHtml: "<p>Closed for maintenance</p>",
  audiences: [{ kind: "ALL_MEMBERS" }],
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockResolvedValue(adminSession);
  mocks.requireActiveSessionUser.mockResolvedValue(null);
  mocks.noticeCreate.mockImplementation(async ({ data }) => noticeRow(data));
  mocks.noticeUpdate.mockImplementation(async ({ data }) =>
    noticeRow({ ...data, id: "notice-1" }),
  );
  mocks.noticeDelete.mockResolvedValue(noticeRow());
  mocks.noticeFindUnique.mockResolvedValue(noticeRow());
  mocks.noticeFindMany.mockResolvedValue([]);
  mocks.noticeUpdateMany.mockResolvedValue({ count: 1 });
  mocks.audienceDeleteMany.mockResolvedValue({ count: 0 });
  mocks.audienceCreateMany.mockResolvedValue({ count: 1 });
  mocks.auditLogCreate.mockResolvedValue({});
  mocks.receiptGroupBy.mockResolvedValue([]);
  mocks.memberCount.mockResolvedValue(1);
  mocks.membershipTypeCount.mockResolvedValue(1);
  mocks.lodgeCount.mockResolvedValue(1);
  mocks.committeeRoleCount.mockResolvedValue(1);
  mocks.sendNoticePublishedEmails.mockResolvedValue({ sent: 0, skipped: 0 });
  mocks.transaction.mockImplementation(async (callback: (tx: unknown) => unknown) =>
    callback({
      notice: { create: mocks.noticeCreate, update: mocks.noticeUpdate, delete: mocks.noticeDelete },
      noticeAudience: {
        deleteMany: mocks.audienceDeleteMany,
        createMany: mocks.audienceCreateMany,
      },
      auditLog: { create: mocks.auditLogCreate },
    }),
  );
});

describe("permission gating", () => {
  it("rejects unauthenticated list", async () => {
    mocks.auth.mockResolvedValue(null);
    const res = await listNotices(new NextRequest("http://x/api/admin/notices"));
    expect(res.status).toBe(401);
  });

  it("rejects non-membership-admin list (403)", async () => {
    mocks.auth.mockResolvedValue(memberSession);
    const res = await listNotices(new NextRequest("http://x/api/admin/notices"));
    expect(res.status).toBe(403);
    expect(mocks.noticeFindMany).not.toHaveBeenCalled();
  });

  it("rejects non-membership-admin create (403)", async () => {
    mocks.auth.mockResolvedValue(memberSession);
    const res = await createNotice(
      request("http://x/api/admin/notices", validCreateBody),
    );
    expect(res.status).toBe(403);
    expect(mocks.noticeCreate).not.toHaveBeenCalled();
  });
});

describe("POST create validation", () => {
  it("rejects a missing title", async () => {
    const res = await createNotice(
      request("http://x/api/admin/notices", { ...validCreateBody, title: "" }),
    );
    expect(res.status).toBe(400);
    expect(mocks.noticeCreate).not.toHaveBeenCalled();
  });

  it("rejects an empty audience list", async () => {
    const res = await createNotice(
      request("http://x/api/admin/notices", { ...validCreateBody, audiences: [] }),
    );
    expect(res.status).toBe(400);
  });

  it("rejects a member target that does not exist", async () => {
    mocks.memberCount.mockResolvedValue(0);
    const res = await createNotice(
      request("http://x/api/admin/notices", {
        ...validCreateBody,
        audiences: [{ kind: "MEMBER", memberId: "ghost" }],
      }),
    );
    expect(res.status).toBe(400);
    expect(mocks.noticeCreate).not.toHaveBeenCalled();
  });
});

describe("POST create behaviour", () => {
  it("sanitises bodyHtml on save (strips <script> and onerror)", async () => {
    await createNotice(
      request("http://x/api/admin/notices", {
        ...validCreateBody,
        bodyHtml: '<p>hi</p><script>alert(1)</script><img src=x onerror="alert(2)">',
      }),
    );
    const data = mocks.noticeCreate.mock.calls[0][0].data;
    expect(data.bodyHtml).not.toContain("<script");
    expect(data.bodyHtml).not.toContain("onerror");
    expect(data.bodyHtml).toContain("<p>hi</p>");
  });

  it("sets publishedAt when created PUBLISHED and null when DRAFT", async () => {
    await createNotice(
      request("http://x/api/admin/notices", {
        ...validCreateBody,
        status: "PUBLISHED",
      }),
    );
    expect(mocks.noticeCreate.mock.calls[0][0].data.publishedAt).toBeInstanceOf(Date);

    vi.clearAllMocks();
    mocks.auth.mockResolvedValue(adminSession);
    mocks.requireActiveSessionUser.mockResolvedValue(null);
    mocks.noticeCreate.mockImplementation(async ({ data }) => noticeRow(data));
    mocks.transaction.mockImplementation(async (cb: (tx: unknown) => unknown) =>
      cb({
        notice: { create: mocks.noticeCreate },
        noticeAudience: { deleteMany: mocks.audienceDeleteMany, createMany: mocks.audienceCreateMany },
        auditLog: { create: mocks.auditLogCreate },
      }),
    );
    await createNotice(
      request("http://x/api/admin/notices", { ...validCreateBody, status: "DRAFT" }),
    );
    expect(mocks.noticeCreate.mock.calls[0][0].data.publishedAt).toBeNull();
  });

  it("writes audience rows via replace-all and audits NOTICE_CREATED", async () => {
    await createNotice(
      request("http://x/api/admin/notices", {
        ...validCreateBody,
        audiences: [{ kind: "LODGE", lodgeId: "lodge-1" }],
      }),
    );
    expect(mocks.audienceDeleteMany).toHaveBeenCalled();
    expect(mocks.audienceCreateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [
          expect.objectContaining({ kind: "LODGE", lodgeId: "lodge-1", memberId: null }),
        ],
      }),
    );
    const auditEvent = mocks.buildStructuredAuditLogCreateArgs.mock.calls[0][0];
    expect(auditEvent.action).toBe("NOTICE_CREATED");
  });

  it("emails on publish only when requested and the single-send guard is unclaimed", async () => {
    // sendEmail true + claim succeeds -> send fires.
    await createNotice(
      request("http://x/api/admin/notices", {
        ...validCreateBody,
        status: "PUBLISHED",
        sendEmail: true,
      }),
    );
    expect(mocks.noticeUpdateMany).toHaveBeenCalledWith({
      where: { id: "notice-1", emailedAt: null },
      data: { emailedAt: expect.any(Date) },
    });
    expect(mocks.sendNoticePublishedEmails).toHaveBeenCalledWith("notice-1");
  });

  it("does not email when the guard is already claimed (count 0)", async () => {
    mocks.noticeUpdateMany.mockResolvedValue({ count: 0 });
    await createNotice(
      request("http://x/api/admin/notices", {
        ...validCreateBody,
        status: "PUBLISHED",
        sendEmail: true,
      }),
    );
    expect(mocks.sendNoticePublishedEmails).not.toHaveBeenCalled();
  });

  it("does not email a draft even when sendEmail is true", async () => {
    await createNotice(
      request("http://x/api/admin/notices", {
        ...validCreateBody,
        status: "DRAFT",
        sendEmail: true,
      }),
    );
    expect(mocks.noticeUpdateMany).not.toHaveBeenCalled();
    expect(mocks.sendNoticePublishedEmails).not.toHaveBeenCalled();
  });
});

describe("PATCH publish transitions", () => {
  it("sets publishedAt once on the first publish", async () => {
    mocks.noticeFindUnique.mockResolvedValue(
      noticeRow({ status: "DRAFT", publishedAt: null }),
    );
    await patchNotice(
      request("http://x/api/admin/notices/notice-1", { status: "PUBLISHED" }, "PATCH"),
      params("notice-1"),
    );
    expect(mocks.noticeUpdate.mock.calls[0][0].data.publishedAt).toBeInstanceOf(Date);
    const auditEvent = mocks.buildStructuredAuditLogCreateArgs.mock.calls[0][0];
    expect(auditEvent.action).toBe("NOTICE_PUBLISHED");
  });

  it("does not rewrite publishedAt when re-publishing a previously published notice", async () => {
    mocks.noticeFindUnique.mockResolvedValue(
      noticeRow({ status: "ARCHIVED", publishedAt: new Date("2026-01-01T00:00:00Z") }),
    );
    await patchNotice(
      request("http://x/api/admin/notices/notice-1", { status: "PUBLISHED" }, "PATCH"),
      params("notice-1"),
    );
    expect(mocks.noticeUpdate.mock.calls[0][0].data).not.toHaveProperty("publishedAt");
  });

  it("audits a non-publish edit as NOTICE_UPDATED", async () => {
    mocks.noticeFindUnique.mockResolvedValue(noticeRow({ status: "PUBLISHED" }));
    await patchNotice(
      request("http://x/api/admin/notices/notice-1", { pinned: true }, "PATCH"),
      params("notice-1"),
    );
    const auditEvent = mocks.buildStructuredAuditLogCreateArgs.mock.calls[0][0];
    expect(auditEvent.action).toBe("NOTICE_UPDATED");
  });

  it("returns 404 for a missing notice", async () => {
    mocks.noticeFindUnique.mockResolvedValue(null);
    const res = await patchNotice(
      request("http://x/api/admin/notices/ghost", { pinned: true }, "PATCH"),
      params("ghost"),
    );
    expect(res.status).toBe(404);
  });
});

describe("DELETE", () => {
  it("hard-deletes and audits NOTICE_DELETED", async () => {
    const res = await deleteNotice(
      new NextRequest("http://x/api/admin/notices/notice-1", { method: "DELETE" }),
      params("notice-1"),
    );
    expect(res.status).toBe(200);
    expect(mocks.noticeDelete).toHaveBeenCalledWith({ where: { id: "notice-1" } });
    const auditEvent = mocks.buildStructuredAuditLogCreateArgs.mock.calls[0][0];
    expect(auditEvent.action).toBe("NOTICE_DELETED");
  });
});
