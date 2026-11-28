/**
 * #5540: a Full Admin unarchives a member in one step. Each refusal leaves
 * nothing written; a success clears only the archive, records an APPROVED
 * UNARCHIVE request row and an audit row, and sends no email.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const tx = {
    member: { findUnique: vi.fn(), updateMany: vi.fn(), count: vi.fn() },
    memberLifecycleActionRequest: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
    },
    xeroObjectLink: { findMany: vi.fn() },
    $executeRaw: vi.fn(),
  };
  return {
    tx,
    prisma: { ...tx, $transaction: vi.fn(async (fn: (client: typeof tx) => unknown) => fn(tx)) },
    createAuditLog: vi.fn(),
    emails: {
      sendAdminMemberArchiveRequestedAlert: vi.fn(),
      sendAdminMemberDeleteApprovedEmail: vi.fn(),
      sendAdminMemberDeleteRejectedEmail: vi.fn(),
      sendAdminMemberDeleteRequestedAlert: vi.fn(),
      sendMemberArchiveApprovedEmail: vi.fn(),
      sendMemberArchiveRejectedEmail: vi.fn(),
    },
  };
});

vi.mock("@/lib/prisma", () => ({ prisma: h.prisma }));
vi.mock("@/lib/audit", () => ({ createAuditLog: h.createAuditLog }));
vi.mock("@/lib/email", () => h.emails);
vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/adult-member-hosting-review", () => ({
  enqueueHostingCoverageReevaluationForMember: vi.fn(),
}));
vi.mock("@/lib/adult-member-hosting-coverage-drain", () => ({
  settleHostingCoverageAfterCommit: vi.fn(),
}));

import {
  getMemberArchiveLifecycleRequests,
  MemberLifecycleActionError,
  reviewMemberLifecycleActionRequest,
} from "@/lib/member-lifecycle-actions";
import { unarchiveMember } from "@/lib/member-unarchive";

const ARCHIVED_AT = new Date("2026-03-01T00:00:00.000Z");
const ARCHIVED_MEMBER = {
  id: "m-1",
  email: "pat@example.com",
  deletedAt: null,
  active: false,
  canLogin: false,
  cancelledAt: new Date("2026-02-01T00:00:00.000Z"),
  archivedAt: ARCHIVED_AT,
  archivedReason: "Left the club",
  archivedViaLifecycleActionRequestId: "req-archive-1",
};

function input(overrides: Partial<Parameters<typeof unarchiveMember>[0]> = {}) {
  return { memberId: "m-1", actorMemberId: "admin-1", reason: "  Archived by mistake  ", ipAddress: "127.0.0.1", ...overrides };
}

async function refusal(promise: Promise<unknown>) {
  const error = await promise.then(() => null, (err: unknown) => err);
  expect(error).toBeInstanceOf(MemberLifecycleActionError);
  return error as MemberLifecycleActionError;
}

function expectNothingWritten() {
  expect(h.tx.member.updateMany).not.toHaveBeenCalled();
  expect(h.tx.memberLifecycleActionRequest.create).not.toHaveBeenCalled();
  expect(h.createAuditLog).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
  h.prisma.$transaction.mockImplementation(async (fn) => fn(h.tx));
  h.tx.member.count.mockResolvedValue(1); // the actor is an active Full Admin
  h.tx.member.findUnique.mockResolvedValue(ARCHIVED_MEMBER);
  h.tx.member.updateMany.mockResolvedValue({ count: 1 });
  h.tx.memberLifecycleActionRequest.findFirst.mockResolvedValue(null);
  h.tx.memberLifecycleActionRequest.create.mockImplementation(async ({ data }) => ({
    id: "req-unarchive-1",
    ...data,
    reviewNote: null,
    memberSnapshot: data.memberSnapshot,
    requestedBy: { id: "admin-1", firstName: "Ada", lastName: "Admin", email: "ada@example.com" },
    reviewedBy: { id: "admin-1", firstName: "Ada", lastName: "Admin", email: "ada@example.com" },
  }));
  h.tx.xeroObjectLink.findMany.mockResolvedValue([]);
  h.tx.$executeRaw.mockResolvedValue(1);
});

describe("unarchiveMember (#5540)", () => {
  it("takes the member's lifecycle key, then re-reads the member under it", async () => {
    await unarchiveMember(input());

    expect(h.tx.$executeRaw).toHaveBeenCalledTimes(1);
    expect(h.tx.$executeRaw.mock.calls[0]?.[1]).toBe("member-lifecycle:m-1");
    expect(h.tx.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(
      h.tx.member.findUnique.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("clears only the archive: the member stays cancelled, inactive and unable to sign in", async () => {
    await unarchiveMember(input());

    expect(h.tx.member.updateMany).toHaveBeenCalledWith({
      where: { id: "m-1", archivedAt: { not: null } },
      data: { archivedAt: null, archivedReason: null, archivedViaLifecycleActionRequestId: null },
    });
  });

  it("records an APPROVED UNARCHIVE row with the admin as requester and reviewer, and the archived snapshot", async () => {
    const { request } = await unarchiveMember(input());

    const { data } = h.tx.memberLifecycleActionRequest.create.mock.calls[0]![0];
    expect(data).toMatchObject({
      memberId: "m-1",
      action: "UNARCHIVE",
      status: "APPROVED",
      reason: "Archived by mistake",
      requestedByMemberId: "admin-1",
      reviewedByMemberId: "admin-1",
    });
    expect(data.reviewedAt).toEqual(data.requestedAt);
    expect(data.processedAt).toEqual(data.requestedAt);
    expect(data.memberSnapshot.member.archivedAt).toBe(ARCHIVED_AT.toISOString());
    // The snapshot is taken before the clear.
    expect(h.tx.xeroObjectLink.findMany.mock.invocationCallOrder[0]).toBeLessThan(
      h.tx.member.updateMany.mock.invocationCallOrder[0] ?? 0,
    );
    expect(request).toMatchObject({ id: "req-unarchive-1", action: "UNARCHIVE", status: "APPROVED" });
  });

  it("writes an admin audit row naming the archive it undid, and sends no email", async () => {
    await unarchiveMember(input());

    expect(h.createAuditLog).toHaveBeenCalledTimes(1);
    expect(h.createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "member_lifecycle.unarchived",
        category: "admin",
        severity: "important",
        actorMemberId: "admin-1",
        subjectMemberId: "m-1",
        entityId: "req-unarchive-1",
        details: "Archived by mistake",
        ipAddress: "127.0.0.1",
        metadata: {
          action: "UNARCHIVE",
          archivedAt: ARCHIVED_AT.toISOString(),
          archivedReason: "Left the club",
          archivedViaLifecycleActionRequestId: "req-archive-1",
        },
      }),
      h.tx,
    );
    for (const send of Object.values(h.emails)) expect(send).not.toHaveBeenCalled();
  });

  it("refuses a blank reason before opening a transaction", async () => {
    const error = await refusal(unarchiveMember(input({ reason: "   " })));
    expect(error.statusCode).toBe(422);
    expect(h.prisma.$transaction).not.toHaveBeenCalled();
  });

  it("refuses an actor who is not a Full Admin with 403, before taking the lock", async () => {
    h.tx.member.count.mockResolvedValue(0);
    const error = await refusal(unarchiveMember(input()));
    expect(error.statusCode).toBe(403);
    expect(h.tx.$executeRaw).not.toHaveBeenCalled();
    expectNothingWritten();
  });

  it("refuses a missing member with 404", async () => {
    h.tx.member.findUnique.mockResolvedValue(null);
    const error = await refusal(unarchiveMember(input()));
    expect(error.statusCode).toBe(404);
    expectNothingWritten();
  });

  it.each([
    ["the deletion marker", { deletedAt: new Date("2026-04-01T00:00:00.000Z") }],
    ["the anonymised address", { email: "deleted-m-1@deleted.invalid" }],
  ])("refuses a deleted member (%s) with 409 (INV-LIFE-015)", async (_label, overrides) => {
    h.tx.member.findUnique.mockResolvedValue({ ...ARCHIVED_MEMBER, ...overrides });
    const error = await refusal(unarchiveMember(input()));
    expect(error.statusCode).toBe(409);
    expect(error.message).toMatch(/deleted/i);
    expectNothingWritten();
  });

  it("refuses a member who is not archived with 409", async () => {
    h.tx.member.findUnique.mockResolvedValue({ ...ARCHIVED_MEMBER, archivedAt: null });
    const error = await refusal(unarchiveMember(input()));
    expect(error.statusCode).toBe(409);
    expect(error.message).toBe("This member is not archived.");
    expectNothingWritten();
  });

  it.each(["ARCHIVE", "DELETE"])("refuses while a %s request is pending, with 409", async (action) => {
    h.tx.memberLifecycleActionRequest.findFirst.mockResolvedValue({ action });
    const error = await refusal(unarchiveMember(input()));
    expect(error.statusCode).toBe(409);
    expect(error.message).toContain(`pending ${action.toLowerCase()} request`);
    expect(h.tx.memberLifecycleActionRequest.findFirst).toHaveBeenCalledWith({
      where: { memberId: "m-1", status: "REQUESTED" },
      select: { action: true },
    });
    expectNothingWritten();
  });

  it("a lost claim answers 409 and writes no request row or audit row", async () => {
    h.tx.member.updateMany.mockResolvedValue({ count: 0 });
    const error = await refusal(unarchiveMember(input()));
    expect(error.statusCode).toBe(409);
    expect(h.tx.memberLifecycleActionRequest.create).not.toHaveBeenCalled();
    expect(h.createAuditLog).not.toHaveBeenCalled();
  });
});

describe("the archive history and the review dispatcher see UNARCHIVE rows (#5540)", () => {
  it("the member page's archive history reads archives and unarchives together", async () => {
    h.prisma.memberLifecycleActionRequest.findMany.mockResolvedValue([]);
    await getMemberArchiveLifecycleRequests("m-1");
    expect(h.prisma.memberLifecycleActionRequest.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { memberId: "m-1", action: { in: ["ARCHIVE", "UNARCHIVE"] } },
      }),
    );
  });

  it("an unarchive row is not a request to review", async () => {
    h.prisma.memberLifecycleActionRequest.findUnique.mockResolvedValue({ action: "UNARCHIVE" });
    const error = await refusal(
      reviewMemberLifecycleActionRequest({ requestId: "req-unarchive-1", reviewedByMemberId: "admin-2", action: "approve" }),
    );
    expect(error.statusCode).toBe(400);
  });
});
