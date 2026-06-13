import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  requireActiveSessionUser: vi.fn(),
  checkLodgeAuth: vi.fn(),
  lodgeInstructionFindMany: vi.fn(),
  lodgeInstructionFindUnique: vi.fn(),
  lodgeInstructionUpsert: vi.fn(),
  hutLeaderAssignmentCount: vi.fn(),
  auditLogCreate: vi.fn(),
  buildStructuredAuditLogCreateArgs: vi.fn((event) => ({ data: event })),
  getAuditRequestContext: vi.fn(() => ({
    id: "req-1",
    ipAddress: "127.0.0.1",
    userAgent: "vitest",
  })),
}));

vi.mock("@/lib/auth", () => ({
  auth: mocks.auth,
}));

vi.mock("@/lib/session-guards", () => ({
  requireAdmin: async () =>
    (await import("./helpers/require-admin-mock")).evaluateRequireAdminMock(),
  // Mirrors the real requireActiveSession 401/403 semantics, delegating to
  // the test's mocked auth() and requireActiveSessionUser().
  requireActiveSession: async () => {
    const { NextResponse } = await import("next/server");
    const session = await mocks.auth();
    if (!session?.user?.id) {
      return {
        ok: false as const,
        response: NextResponse.json({ error: "Unauthorised" }, { status: 401 }),
      };
    }
    const inactive = await mocks.requireActiveSessionUser(session.user.id);
    if (inactive) {
      return { ok: false as const, response: inactive };
    }
    return { ok: true as const, session };
  },
  requireActiveSessionUser: mocks.requireActiveSessionUser,
}));

vi.mock("@/lib/audit", () => ({
  buildStructuredAuditLogCreateArgs: mocks.buildStructuredAuditLogCreateArgs,
  getAuditRequestContext: mocks.getAuditRequestContext,
}));

vi.mock("@/lib/lodge-auth", () => ({
  checkLodgeAuth: mocks.checkLodgeAuth,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    lodgeInstruction: {
      findMany: mocks.lodgeInstructionFindMany,
      findUnique: mocks.lodgeInstructionFindUnique,
      upsert: mocks.lodgeInstructionUpsert,
    },
    hutLeaderAssignment: {
      count: mocks.hutLeaderAssignmentCount,
    },
    auditLog: {
      create: mocks.auditLogCreate,
    },
  },
}));

import { GET as readerGET } from "@/app/api/lodge-instructions/route";
import {
  GET as adminGET,
  PUT as adminPUT,
} from "@/app/api/admin/lodge-instructions/route";
import { GET as kioskGET } from "@/app/api/lodge/instructions/route";
import { getSanitizedLodgeInstructions } from "@/lib/lodge-instructions";
import { addDaysDateOnly, getTodayDateOnly } from "@/lib/date-only";
import { hutLeaderAssignmentTemplate } from "@/lib/email-templates";

const memberSession = { user: { id: "member-1", role: "MEMBER" } };
const adminSession = { user: { id: "admin-1", role: "ADMIN" } };

const storedDocuments = [
  {
    key: "OPEN",
    contentHtml: "<p>Open the shutters</p>",
    updatedAt: new Date("2026-06-10T00:00:00Z"),
  },
  {
    key: "CLOSE",
    contentHtml: "<p>Turn off the gas</p>",
    updatedAt: new Date("2026-06-10T00:00:00Z"),
  },
  {
    key: "DAY_TO_DAY",
    contentHtml: "<p>Run the roster</p>",
    updatedAt: new Date("2026-06-10T00:00:00Z"),
  },
];

/**
 * Simulates Prisma's count() filtering over in-memory assignment rows so
 * the tests genuinely exercise the endDate >= today query shape rather
 * than a canned count.
 */
function useAssignments(assignments: { memberId: string; endDate: Date }[]) {
  mocks.hutLeaderAssignmentCount.mockImplementation(
    async (args: { where?: { memberId?: string; endDate?: { gte?: Date } } }) => {
      const where = args?.where ?? {};
      const gte = where.endDate?.gte;
      return assignments.filter(
        (assignment) =>
          assignment.memberId === where.memberId &&
          (!gte || assignment.endDate.getTime() >= gte.getTime()),
      ).length;
    },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireActiveSessionUser.mockResolvedValue(null);
  mocks.lodgeInstructionFindMany.mockResolvedValue(storedDocuments);
  mocks.auditLogCreate.mockResolvedValue({});
});

describe("GET /api/lodge-instructions (reader access control)", () => {
  it("denies an unauthenticated request", async () => {
    mocks.auth.mockResolvedValue(null);
    const response = await readerGET();
    expect(response.status).toBe(401);
  });

  it("denies a regular member with no hut leader assignment", async () => {
    mocks.auth.mockResolvedValue(memberSession);
    useAssignments([]);

    const response = await readerGET();
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error).toContain("not currently assigned");
    expect(mocks.lodgeInstructionFindMany).not.toHaveBeenCalled();
  });

  it("allows a member with a current assignment", async () => {
    mocks.auth.mockResolvedValue(memberSession);
    useAssignments([{ memberId: "member-1", endDate: getTodayDateOnly() }]);

    const response = await readerGET();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.documents.map((doc: { key: string }) => doc.key)).toEqual([
      "OPEN",
      "CLOSE",
      "DAY_TO_DAY",
    ]);
  });

  it("allows a member with an upcoming assignment", async () => {
    mocks.auth.mockResolvedValue(memberSession);
    useAssignments([
      { memberId: "member-1", endDate: addDaysDateOnly(getTodayDateOnly(), 14) },
    ]);

    const response = await readerGET();
    expect(response.status).toBe(200);
  });

  it("denies a member whose only assignment has expired", async () => {
    mocks.auth.mockResolvedValue(memberSession);
    useAssignments([
      { memberId: "member-1", endDate: addDaysDateOnly(getTodayDateOnly(), -1) },
    ]);

    const response = await readerGET();
    expect(response.status).toBe(403);
    expect(mocks.lodgeInstructionFindMany).not.toHaveBeenCalled();
  });

  it("does not grant access from another member's assignment", async () => {
    mocks.auth.mockResolvedValue(memberSession);
    useAssignments([
      { memberId: "member-2", endDate: addDaysDateOnly(getTodayDateOnly(), 14) },
    ]);

    const response = await readerGET();
    expect(response.status).toBe(403);
  });

  it("allows an admin without any assignment", async () => {
    mocks.auth.mockResolvedValue(adminSession);
    useAssignments([]);

    const response = await readerGET();
    expect(response.status).toBe(200);
    expect(mocks.hutLeaderAssignmentCount).not.toHaveBeenCalled();
  });
});

describe("admin lodge-instructions route", () => {
  function putRequest(body: unknown) {
    return new NextRequest("http://localhost/api/admin/lodge-instructions", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  beforeEach(() => {
    mocks.lodgeInstructionFindUnique.mockResolvedValue({
      contentHtml: "<p>Old</p>",
    });
    mocks.lodgeInstructionUpsert.mockImplementation(
      async ({ update, where }: { update: { contentHtml: string }; where: { key: string } }) => ({
        id: `lodge-instruction-${where.key.toLowerCase()}`,
        key: where.key,
        contentHtml: update.contentHtml,
        updatedAt: new Date("2026-06-11T00:00:00Z"),
      }),
    );
  });

  it("lists the three documents for admins", async () => {
    mocks.auth.mockResolvedValue(adminSession);
    const response = await adminGET();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.documents).toHaveLength(3);
  });

  it("rejects non-admin members", async () => {
    mocks.auth.mockResolvedValue(memberSession);
    const response = await adminPUT(
      putRequest({ key: "OPEN", contentHtml: "<p>Hi</p>" }),
    );
    expect(response.status).toBe(403);
    expect(mocks.lodgeInstructionUpsert).not.toHaveBeenCalled();
  });

  it("sanitises content on write and writes an audit entry", async () => {
    mocks.auth.mockResolvedValue(adminSession);
    const response = await adminPUT(
      putRequest({
        key: "OPEN",
        contentHtml: '<p>Open the shutters</p><script>alert("x")</script>',
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.lodgeInstructionUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { key: "OPEN" },
        update: expect.objectContaining({
          contentHtml: "<p>Open the shutters</p>",
        }),
      }),
    );
    expect(mocks.auditLogCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: "LODGE_INSTRUCTION_UPDATED" }),
      }),
    );
  });

  it("strips event-handler attributes on write", async () => {
    mocks.auth.mockResolvedValue(adminSession);
    await adminPUT(
      putRequest({
        key: "CLOSE",
        contentHtml: '<p onclick="alert(1)">Lock up</p>',
      }),
    );

    expect(mocks.lodgeInstructionUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ contentHtml: "<p>Lock up</p>" }),
      }),
    );
  });

  it("rejects unknown document keys", async () => {
    mocks.auth.mockResolvedValue(adminSession);
    const response = await adminPUT(
      putRequest({ key: "SOMETHING_ELSE", contentHtml: "<p>Hi</p>" }),
    );
    expect(response.status).toBe(400);
    expect(mocks.lodgeInstructionUpsert).not.toHaveBeenCalled();
  });
});

describe("sanitiser round-trip", () => {
  it("sanitises stored content again on render", async () => {
    mocks.lodgeInstructionFindMany.mockResolvedValue([
      {
        key: "OPEN",
        contentHtml:
          '<h2>Open</h2><script>alert("x")</script><p onclick="boom()">Shutters</p>',
        updatedAt: new Date("2026-06-10T00:00:00Z"),
      },
    ]);

    const documents = await getSanitizedLodgeInstructions();
    expect(documents).toHaveLength(3);
    expect(documents[0].key).toBe("OPEN");
    expect(documents[0].contentHtml).toBe("<h2>Open</h2><p>Shutters</p>");
    // Missing rows still produce empty documents for the other keys.
    expect(documents[1].contentHtml).toBe("");
    expect(documents[2].contentHtml).toBe("");
  });

  it("round-trips save and render without altering safe content", async () => {
    mocks.auth.mockResolvedValue(adminSession);
    mocks.lodgeInstructionFindUnique.mockResolvedValue(null);
    let stored = "";
    mocks.lodgeInstructionUpsert.mockImplementation(
      async ({ create }: { create: { key: string; contentHtml: string } }) => {
        stored = create.contentHtml;
        return {
          id: "lodge-instruction-open",
          key: create.key,
          contentHtml: create.contentHtml,
          updatedAt: new Date("2026-06-11T00:00:00Z"),
        };
      },
    );

    const safeHtml = "<h2>Opening</h2><ul><li>Unlock the door</li></ul>";
    const response = await adminPUT(
      new NextRequest("http://localhost/api/admin/lodge-instructions", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key: "OPEN", contentHtml: safeHtml }),
      }),
    );
    expect(response.status).toBe(200);
    expect(stored).toBe(safeHtml);

    // Render the stored value back through the reader path.
    mocks.lodgeInstructionFindMany.mockResolvedValue([
      { key: "OPEN", contentHtml: stored, updatedAt: new Date() },
    ]);
    const documents = await getSanitizedLodgeInstructions();
    expect(documents[0].contentHtml).toBe(safeHtml);
  });
});

describe("GET /api/lodge/instructions (kiosk surface)", () => {
  function kioskRequest(date = "2026-06-11") {
    return new NextRequest(
      `http://localhost/api/lodge/instructions?date=${date}`,
    );
  }

  it("returns documents for a hut leader PIN session", async () => {
    mocks.checkLodgeAuth.mockResolvedValue({
      session: { user: { id: "lodge-1", role: "LODGE" } },
      tier: "hut-leader",
      error: null,
      status: null,
      pinSession: { memberId: "member-1" },
    });

    const response = await kioskGET(kioskRequest());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.documents).toHaveLength(3);
  });

  it("returns documents for an assigned hut leader member", async () => {
    mocks.checkLodgeAuth.mockResolvedValue({
      session: memberSession,
      tier: "hut-leader",
      error: null,
      status: null,
    });

    const response = await kioskGET(kioskRequest());
    expect(response.status).toBe(200);
  });

  it("denies the shared lodge account without a PIN session", async () => {
    mocks.checkLodgeAuth.mockResolvedValue({
      session: { user: { id: "lodge-1", role: "LODGE" } },
      tier: "lodge",
      error: null,
      status: null,
    });

    const response = await kioskGET(kioskRequest());
    expect(response.status).toBe(403);
    expect(mocks.lodgeInstructionFindMany).not.toHaveBeenCalled();
  });

  it("denies staying guests", async () => {
    mocks.checkLodgeAuth.mockResolvedValue({
      session: memberSession,
      tier: "staying-guest",
      error: null,
      status: null,
    });

    const response = await kioskGET(kioskRequest());
    expect(response.status).toBe(403);
  });

  it("propagates lodge auth failures", async () => {
    mocks.checkLodgeAuth.mockResolvedValue({
      session: null,
      tier: "none",
      error: "Unauthorised",
      status: 401,
    });

    const response = await kioskGET(kioskRequest());
    expect(response.status).toBe(401);
  });

  it("rejects malformed dates", async () => {
    const response = await kioskGET(kioskRequest("not-a-date"));
    expect(response.status).toBe(400);
    expect(mocks.checkLodgeAuth).not.toHaveBeenCalled();
  });
});

describe("hut leader assignment email", () => {
  it("links to the lodge instructions reader page", () => {
    const html = hutLeaderAssignmentTemplate({
      firstName: "Alice",
      startDate: new Date("2026-07-15"),
      endDate: new Date("2026-07-18"),
      pin: "123456",
    });

    expect(html).toContain("/lodge-instructions");
  });
});
