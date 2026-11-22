/**
 * ALP-720 (`INV-MCP-006`): the club notice, sent-email history and message
 * board actions an officer's AI app connection may run, each held to its
 * contract (`expectActionContract`): the connection gets exactly the action's
 * `returns` fields and the browser's answer is unchanged. An AI app can never
 * email members about a notice.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const h = vi.hoisted(() => ({
  auth: vi.fn(),
  modules: vi.fn(),
  sendNoticePublishedEmails: vi.fn(),
  resolveNoticeAudienceMembers: vi.fn(),
  listClubPostsForAdmin: vi.fn(),
  editClubPostContent: vi.fn(),
  setClubPostHidden: vi.fn(),
  removeClubPost: vi.fn(),
  runClubPostCleanup: vi.fn(),
  prisma: {
    notice: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      delete: vi.fn(),
    },
    noticeAudience: { deleteMany: vi.fn(), createMany: vi.fn() },
    noticeReadReceipt: { groupBy: vi.fn(), count: vi.fn(), findMany: vi.fn() },
    auditLog: { create: vi.fn(), findMany: vi.fn(), count: vi.fn() },
    member: { count: vi.fn() },
    membershipType: { count: vi.fn() },
    lodge: { count: vi.fn() },
    committeeRole: { count: vi.fn() },
    $transaction: vi.fn(),
  },
}));

vi.mock("@/lib/auth", () => ({ auth: h.auth }));
vi.mock("@/lib/session-guards", async () => ({
  requireAdmin: (await import("./helpers/require-admin-mock")).evaluateRequireAdminMock,
  requireActiveSessionUser: vi.fn(async () => null),
}));
vi.mock("@/lib/prisma", () => ({ prisma: h.prisma }));
vi.mock("@/lib/audit", () => ({
  buildStructuredAuditLogCreateArgs: vi.fn((event: unknown) => ({ data: event })),
  getAuditRequestContext: vi.fn(() => ({})),
  logAudit: vi.fn(),
}));
vi.mock("@/lib/notices-email", () => ({ sendNoticePublishedEmails: h.sendNoticePublishedEmails }));
vi.mock("@/lib/notices", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/notices")),
  resolveNoticeAudienceMembers: h.resolveNoticeAudienceMembers,
}));
vi.mock("@/lib/module-settings", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/module-settings")),
  loadEffectiveModuleFlags: h.modules,
}));
vi.mock("@/lib/club-posts-admin", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/club-posts-admin")),
  listClubPostsForAdmin: h.listClubPostsForAdmin,
  editClubPostContent: h.editClubPostContent,
  setClubPostHidden: h.setClubPostHidden,
  removeClubPost: h.removeClubPost,
}));
vi.mock("@/lib/club-post-retention", () => ({ runClubPostCleanup: h.runClubPostCleanup }));

import { GET as listNotices, POST as createNotice } from "@/app/api/admin/notices/route";
import { DELETE as deleteNotice, GET as getNotice, PATCH as updateNotice } from "@/app/api/admin/notices/[id]/route";
import { GET as listNoticeReads } from "@/app/api/admin/notices/[id]/reads/route";
import { GET as listEmailHistory } from "@/app/api/admin/communications/history/route";
import { GET as listClubPosts } from "@/app/api/admin/club-posts/route";
import { DELETE as removeClubPost, PATCH as moderateClubPost } from "@/app/api/admin/club-posts/[id]/route";
import { POST as runCleanup } from "@/app/api/admin/club-posts/cleanup/route";
import { expectActionContract, officerMemberSession } from "@/lib/__tests__/helpers/mcp-action-contract";
import { findMcpAction, splitMcpActionArguments } from "@/lib/mcp/catalogue";
import { MCP_PRINCIPAL_HEADER } from "@/lib/mcp/principal";

const ORIGIN = "https://club.example.test";

/** A notice row as the admin reads select it, with every join filled. */
function noticeRow(id: string, status: "PUBLISHED" | "DRAFT" | "ARCHIVED") {
  return {
    id,
    title: `Notice ${id}`,
    status,
    publishedAt: status === "DRAFT" ? null : new Date("2026-06-20T00:00:00.000Z"),
    expiresAt: new Date("2026-09-01T00:00:00.000Z"),
    pinned: false,
    requiresAcknowledgement: true,
    financialMembersOnly: false,
    emailedAt: null,
    createdAt: new Date("2026-06-10T00:00:00.000Z"),
    updatedAt: new Date("2026-06-11T00:00:00.000Z"),
    createdBy: { firstName: "Ana", lastName: "Hale" },
    audiences: [
      {
        id: `audience-${id}`,
        kind: "MEMBER",
        memberId: "member-2",
        membershipTypeId: null,
        lodgeId: null,
        committeeRoleId: null,
        member: { firstName: "Kai", lastName: "Ngata" },
        membershipType: null,
        lodge: null,
        committeeRole: null,
      },
    ],
  };
}

/** A notice as the list sends a connection: no audience row id. */
function noticeForConnection(id: string, status: "PUBLISHED" | "DRAFT" | "ARCHIVED") {
  return {
    id,
    title: `Notice ${id}`,
    status,
    publishedAt: status === "DRAFT" ? null : "2026-06-20T00:00:00.000Z",
    expiresAt: "2026-09-01T00:00:00.000Z",
    pinned: false,
    requiresAcknowledgement: true,
    financialMembersOnly: false,
    emailedAt: null,
    createdAt: "2026-06-10T00:00:00.000Z",
    updatedAt: "2026-06-11T00:00:00.000Z",
    createdByName: "Ana Hale",
    audiences: [{ kind: "MEMBER", targetId: "member-2", targetName: "Kai Ngata" }],
    audienceCount: 1,
    readCount: 3,
    acknowledgedCount: 2,
  };
}

/** A message board post as the moderation list serialises it. */
const clubPost = {
  id: "post-1",
  authorName: "Kai Ngata",
  authorMemberId: "member-2",
  content: "Snow chains are in the shed.",
  postedAt: "2026-06-28T09:00:00.000Z",
  hiddenAt: "2026-06-29T09:00:00.000Z",
  removedAt: null,
  originClubName: "Ruapehu Alpine Club",
};

/** A request exactly as the dispatcher's loopback call sends it, for an answer the contract helper cannot pin. */
function connectionRequest(actionId: string, args: Record<string, unknown>) {
  const action = findMcpAction(actionId)!;
  const { params, body } = splitMcpActionArguments(action, args);
  const path = action.path.replace(/\[([A-Za-z]+)\]/g, (_m, key: string) => String(params[key]));
  return {
    request: new NextRequest(new URL(path, ORIGIN), {
      method: action.method,
      headers: { accept: "application/json", "content-type": "application/json", [MCP_PRINCIPAL_HEADER]: "test" },
      body: body === null ? undefined : JSON.stringify(body),
    }),
    context: { params: Promise.resolve(params as { id: string }) },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.auth.mockResolvedValue(officerMemberSession());
  h.modules.mockResolvedValue({ commsPortal: true });
  h.prisma.$transaction.mockImplementation(async (run: (tx: typeof h.prisma) => unknown) => run(h.prisma));
  h.prisma.member.count.mockResolvedValue(1);
  h.prisma.notice.updateMany.mockResolvedValue({ count: 1 });
  h.sendNoticePublishedEmails.mockResolvedValue(undefined);
});

describe("list_admin_notices and get_admin_notice", () => {
  it("lists every notice by status, without the editor's audience row ids", async () => {
    h.prisma.notice.findMany.mockResolvedValue([
      noticeRow("n-1", "PUBLISHED"),
      noticeRow("n-2", "DRAFT"),
      noticeRow("n-3", "ARCHIVED"),
    ]);
    h.prisma.noticeReadReceipt.groupBy.mockImplementation(async (args: { where: { acknowledgedAt?: unknown } }) =>
      ["n-1", "n-2", "n-3"].map((noticeId) => ({ noticeId, _count: { _all: args.where.acknowledgedAt ? 2 : 3 } })),
    );

    const { connection, browser } = await expectActionContract({
      actionId: "list_admin_notices",
      handler: listNotices,
    });

    expect(connection).toEqual({
      published: [noticeForConnection("n-1", "PUBLISHED")],
      draft: [noticeForConnection("n-2", "DRAFT")],
      archived: [noticeForConnection("n-3", "ARCHIVED")],
    });
    expect(browser).toMatchObject({ published: [{ audiences: [{ id: "audience-n-1" }] }] });
  });

  it("reads one notice with its stored HTML body", async () => {
    h.prisma.notice.findUnique.mockResolvedValue({ ...noticeRow("n-1", "PUBLISHED"), bodyHtml: "<p>Hut open</p>" });
    h.prisma.noticeReadReceipt.count.mockResolvedValueOnce(3).mockResolvedValueOnce(2);

    const { connection, browser } = await expectActionContract({
      actionId: "get_admin_notice",
      handler: getNotice,
      args: { id: "n-1" },
    });

    expect(connection).toEqual({ notice: { ...noticeForConnection("n-1", "PUBLISHED"), bodyHtml: "<p>Hut open</p>" } });
    expect(browser).toMatchObject({ notice: { audiences: [{ id: "audience-n-1" }] } });
    expect(h.prisma.notice.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "n-1" } }));
  });
});

describe("create_notice and update_notice never email members", () => {
  const createArgs = {
    title: "Hut open",
    bodyHtml: "<p>Hut open</p>",
    status: "PUBLISHED",
    audiences: [{ kind: "MEMBER", memberId: "member-2" }],
  };

  it("pins the email-on-publish switch off whatever the app sends", () => {
    for (const id of ["create_notice", "update_notice"]) {
      const action = findMcpAction(id)!;
      expect(Object.keys(action.body!.shape), id).not.toContain("sendEmail");
      expect(splitMcpActionArguments(action, { id: "n-1", ...createArgs, sendEmail: true }).body).toMatchObject({
        sendEmail: false,
      });
    }
  });

  it("publishes a new notice and sends no email, though the website's same request would", async () => {
    h.prisma.notice.create.mockResolvedValue({ ...noticeRow("n-9", "PUBLISHED"), bodyHtml: "<p>Hut open</p>" });

    const { connection } = await expectActionContract({
      actionId: "create_notice",
      handler: createNotice,
      args: { ...createArgs, sendEmail: true },
    });

    expect(connection).toEqual({ notice: { id: "n-9" } });
    expect(h.prisma.notice.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ title: "Hut open", status: "PUBLISHED" }) }),
    );
    expect(h.prisma.notice.updateMany).not.toHaveBeenCalled();
    expect(h.sendNoticePublishedEmails).not.toHaveBeenCalled();

    // The control: the website asking for the email does get one, so the
    // assertions above would see a leaked switch.
    await createNotice(
      new Request(`${ORIGIN}/api/admin/notices`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...createArgs, sendEmail: true }),
      }),
    );
    expect(h.sendNoticePublishedEmails).toHaveBeenCalledWith("n-9");
  });

  it("publishes a draft by id and sends no email", async () => {
    const draft = { ...noticeRow("n-2", "DRAFT"), bodyHtml: "<p>Draft</p>" };
    h.prisma.notice.findUnique.mockResolvedValue(draft);
    h.prisma.notice.update.mockResolvedValue({ ...draft, status: "PUBLISHED" });

    const { connection } = await expectActionContract({
      actionId: "update_notice",
      handler: updateNotice,
      args: { id: "n-2", status: "PUBLISHED", sendEmail: true },
    });

    expect(connection).toEqual({ notice: { id: "n-2" } });
    expect(h.prisma.notice.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "n-2" }, data: expect.objectContaining({ status: "PUBLISHED" }) }),
    );
    expect(h.prisma.notice.updateMany).not.toHaveBeenCalled();
    expect(h.sendNoticePublishedEmails).not.toHaveBeenCalled();
  });
});

describe("delete_notice", () => {
  it("deletes the notice named in the address", async () => {
    h.prisma.notice.findUnique.mockResolvedValue({ ...noticeRow("n-3", "ARCHIVED"), bodyHtml: "" });

    const { connection } = await expectActionContract({
      actionId: "delete_notice",
      handler: deleteNotice,
      args: { id: "n-3" },
    });

    expect(connection).toEqual({ ok: true });
    expect(h.prisma.notice.delete).toHaveBeenCalledWith({ where: { id: "n-3" } });
  });
});

describe("list_notice_reads", () => {
  beforeEach(() => {
    h.prisma.notice.findUnique.mockResolvedValue({ id: "n-1", requiresAcknowledgement: true });
    h.resolveNoticeAudienceMembers.mockResolvedValue([
      { memberId: "member-2", name: "Kai Ngata", email: "kai@example.org", audienceVia: "Member", viaExplicitMember: true },
      { memberId: "member-3", name: "Ana Hale", email: "ana@example.org", audienceVia: "Member", viaExplicitMember: true },
    ]);
    h.prisma.noticeReadReceipt.findMany.mockResolvedValue([
      {
        memberId: "member-2",
        readAt: new Date("2026-06-21T00:00:00.000Z"),
        acknowledgedAt: new Date("2026-06-22T00:00:00.000Z"),
      },
    ]);
  });

  it("sends who read the notice and when, never their email", async () => {
    const { connection, browser } = await expectActionContract({
      actionId: "list_notice_reads",
      handler: listNoticeReads,
      args: { id: "n-1", page: 1, pageSize: 1 },
    });

    expect(connection).toEqual({
      requiresAcknowledgement: true,
      rows: [
        {
          memberId: "member-2",
          name: "Kai Ngata",
          readAt: "2026-06-21T00:00:00.000Z",
          acknowledgedAt: "2026-06-22T00:00:00.000Z",
        },
      ],
      page: 1,
      pageSize: 1,
      total: 2,
      totalPages: 2,
      audienceCount: 2,
      readCount: 1,
      acknowledgedCount: 1,
    });
    expect(browser).toMatchObject({ rows: [{ email: "kai@example.org" }] });
    expect(h.resolveNoticeAudienceMembers).toHaveBeenCalledWith("n-1");
  });

  it("refuses a page size over the route's cap", async () => {
    const res = await listNoticeReads(new Request(`${ORIGIN}/api/admin/notices/n-1/reads?pageSize=201`), {
      params: Promise.resolve({ id: "n-1" }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "Invalid query parameters" });
  });
});

describe("list_bulk_email_history", () => {
  it("sends the history once, with no recipients", async () => {
    h.prisma.auditLog.findMany.mockResolvedValue([
      {
        id: "audit-1",
        memberId: "officer-1",
        details: JSON.stringify({
          subject: "Working bee",
          recipientFilter: "members-only",
          category: "club_news",
          totalRecipients: 40,
          eligibleRecipients: 35,
          queued: 35,
        }),
        createdAt: new Date("2026-06-15T00:00:00.000Z"),
      },
    ]);
    h.prisma.auditLog.count.mockResolvedValue(1);

    const { connection, browser } = await expectActionContract({
      actionId: "list_bulk_email_history",
      handler: listEmailHistory,
      args: { page: 1, pageSize: 10 },
    });

    expect(connection).toEqual({
      history: [
        {
          id: "audit-1",
          sentBy: "officer-1",
          subject: "Working bee",
          recipientFilter: "members-only",
          totalRecipients: 40,
          eligibleRecipients: 35,
          queued: 35,
          sentAt: "2026-06-15T00:00:00.000Z",
        },
      ],
      page: 1,
      pageSize: 10,
      total: 1,
      totalPages: 1,
    });
    expect(browser).toMatchObject({ data: [{ id: "audit-1" }] });
    expect(h.prisma.auditLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { action: "BULK_COMMUNICATION_SENT" }, take: 10, skip: 0 }),
    );
  });
});

describe("message board moderation", () => {
  it("lists posts for moderation, filtered as asked", async () => {
    h.listClubPostsForAdmin.mockResolvedValue([clubPost]);

    const { connection, browser } = await expectActionContract({
      actionId: "list_message_board_posts",
      handler: listClubPosts,
      args: { tab: "hidden", q: "  chains " },
    });

    const postForConnection: Partial<typeof clubPost> = { ...clubPost };
    delete postForConnection.removedAt;
    expect(connection).toEqual({ posts: [postForConnection] });
    expect(browser).toEqual({ posts: [clubPost] });
    expect(h.listClubPostsForAdmin).toHaveBeenCalledWith({ tab: "hidden", q: "chains" });
  });

  it("answers not found and reads nothing when the message board is off", async () => {
    h.modules.mockResolvedValue({ commsPortal: false });
    const { request } = connectionRequest("list_message_board_posts", {});

    const res = await listClubPosts(request);

    expect(res.status).toBe(404);
    expect(h.listClubPostsForAdmin).not.toHaveBeenCalled();
  });

  it("rewrites the post named in the address", async () => {
    h.editClubPostContent.mockResolvedValue({ before: "Snow chains.", after: "Chains are in the shed." });

    const { connection } = await expectActionContract({
      actionId: "moderate_message_board_post",
      handler: moderateClubPost,
      args: { id: "post-1", content: "Chains are in the shed." },
    });

    expect(connection).toEqual({ status: "edited", length: 23 });
    expect(h.editClubPostContent).toHaveBeenCalledWith("post-1", "Chains are in the shed.");
    expect(h.setClubPostHidden).not.toHaveBeenCalled();
  });

  it("hides the post named in the address", async () => {
    const { request, context } = connectionRequest("moderate_message_board_post", { id: "post-1", hidden: true });

    const res = await moderateClubPost(request, context);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "hidden" });
    expect(h.setClubPostHidden).toHaveBeenCalledWith("post-1", true);
  });

  it("removes the post named in the address", async () => {
    const { connection } = await expectActionContract({
      actionId: "remove_message_board_post",
      handler: removeClubPost,
      args: { id: "post-1" },
    });

    expect(connection).toEqual({ status: "removed" });
    expect(h.removeClubPost).toHaveBeenCalledWith("post-1");
  });

  it("runs the retention pass and says what it did", async () => {
    h.runClubPostCleanup.mockResolvedValue({ skipped: "busy", deleted: 0 });

    const { connection } = await expectActionContract({
      actionId: "run_message_board_cleanup",
      handler: runCleanup,
    });

    expect(connection).toEqual({ skipped: "busy", deleted: 0 });
    expect(h.runClubPostCleanup).toHaveBeenCalledTimes(2);
  });

  it("runs no retention pass when the message board is off", async () => {
    h.modules.mockResolvedValue({ commsPortal: false });
    const { request } = connectionRequest("run_message_board_cleanup", {});

    const res = await runCleanup(request);

    expect(res.status).toBe(404);
    expect(h.runClubPostCleanup).not.toHaveBeenCalled();
  });
});
