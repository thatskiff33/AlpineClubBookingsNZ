import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  requireActiveSessionUser: vi.fn(),
  checkLodgeAuth: vi.fn(),
  resolveKioskLodgeId: vi.fn(),
  lodgeInstructionFindMany: vi.fn(),
  lodgeInstructionFindFirst: vi.fn(),
  lodgeInstructionCreate: vi.fn(),
  lodgeInstructionUpdate: vi.fn(),
  lodgeInstructionDeleteMany: vi.fn(),
  hutLeaderAssignmentCount: vi.fn(),
  hutLeaderAssignmentFindMany: vi.fn(),
  lodgeFindUnique: vi.fn(),
  lodgeFindFirst: vi.fn(),
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

vi.mock("@/lib/session-guards", async () => ({
  requireAdmin: (await import("./helpers/require-admin-mock"))
    .evaluateRequireAdminMock,
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
  resolveKioskLodgeId: mocks.resolveKioskLodgeId,
}));

// Deterministic values for text-token resolution; importOriginal keeps the
// modules' other exports intact for email-templates and club-identity.
vi.mock("@/config/club-identity", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/config/club-identity")>()),
  CLUB_NAME: "Test Alpine Club",
}));
// {{club-name}}/{{hut-leader}} now resolve through the DB-first club-identity
// accessor (E3 #1929), not the CLUB_NAME constant. Feed it the same deterministic
// club name so token resolution stays under test control without a database.
vi.mock("@/lib/club-identity-settings", async () => {
  const { clubIdentity } = await import("@/config/club-identity");
  return {
    CLUB_IDENTITY_SETTINGS_ID: "default",
    getClubIdentity: vi.fn(async () => ({
      ...clubIdentity,
      name: "Test Alpine Club",
    })),
  };
});
vi.mock("@/lib/lodge-capacity", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/lodge-capacity")>()),
  getLodgeCapacity: vi.fn(async () => 32),
  // The bare {{lodge-capacity}} token resolves the default lodge.
  getDefaultLodgeCapacity: vi.fn(async () => 32),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    lodgeInstruction: {
      findMany: mocks.lodgeInstructionFindMany,
      findFirst: mocks.lodgeInstructionFindFirst,
      create: mocks.lodgeInstructionCreate,
      update: mocks.lodgeInstructionUpdate,
      deleteMany: mocks.lodgeInstructionDeleteMany,
    },
    hutLeaderAssignment: {
      count: mocks.hutLeaderAssignmentCount,
      findMany: mocks.hutLeaderAssignmentFindMany,
    },
    lodge: {
      findUnique: mocks.lodgeFindUnique,
      findFirst: mocks.lodgeFindFirst,
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
import { hutLeaderAssignmentTemplate } from "@/lib/email-templates/chores";

/*
 * The zone the assignment fixtures below are built in (#3123). The route derives
 * its own "today" from `clubTodayDateOnlyInstant()`, i.e. the persisted
 * `ClubTimeSettings` row; this suite's prisma mock serves none, so that resolver
 * falls back to `APP_TIME_ZONE`, which is `Pacific/Auckland` under test. The
 * fixtures have to be built in the SAME zone the route reads or an assignment
 * ending "today" lands on the wrong side of the `endDate >= today` bound. This
 * suite is not about zone authority — `club-time-zone-settings` has the suites
 * that are — so it names the agreeing zone rather than a divergent one.
 */
const CLUB_ZONE = "Pacific/Auckland";

const memberSession = { user: { id: "member-1", role: "MEMBER", accessRoles: [{ role: "USER" }] } };
const adminSession = { user: { id: "admin-1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }] } };

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
  mocks.hutLeaderAssignmentFindMany.mockResolvedValue([]);
  mocks.resolveKioskLodgeId.mockResolvedValue("lodge-1");
  mocks.auditLogCreate.mockResolvedValue({});
});

function readerRequest(query = "") {
  return new NextRequest(`http://localhost/api/lodge-instructions${query}`);
}

describe("GET /api/lodge-instructions (reader access control)", () => {
  it("denies an unauthenticated request", async () => {
    mocks.auth.mockResolvedValue(null);
    const response = await readerGET(readerRequest());
    expect(response.status).toBe(401);
  });

  it("denies a regular member with no hut leader assignment", async () => {
    mocks.auth.mockResolvedValue(memberSession);
    useAssignments([]);

    const response = await readerGET(readerRequest());
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error).toContain("not currently assigned");
    expect(mocks.lodgeInstructionFindMany).not.toHaveBeenCalled();
  });

  it("allows a member with a current assignment", async () => {
    mocks.auth.mockResolvedValue(memberSession);
    useAssignments([{ memberId: "member-1", endDate: getTodayDateOnly(CLUB_ZONE) }]);

    const response = await readerGET(readerRequest());
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
      { memberId: "member-1", endDate: addDaysDateOnly(getTodayDateOnly(CLUB_ZONE), 14) },
    ]);

    const response = await readerGET(readerRequest());
    expect(response.status).toBe(200);
  });

  it("denies a member whose only assignment has expired", async () => {
    mocks.auth.mockResolvedValue(memberSession);
    useAssignments([
      { memberId: "member-1", endDate: addDaysDateOnly(getTodayDateOnly(CLUB_ZONE), -1) },
    ]);

    const response = await readerGET(readerRequest());
    expect(response.status).toBe(403);
    expect(mocks.lodgeInstructionFindMany).not.toHaveBeenCalled();
  });

  it("does not grant access from another member's assignment", async () => {
    mocks.auth.mockResolvedValue(memberSession);
    useAssignments([
      { memberId: "member-2", endDate: addDaysDateOnly(getTodayDateOnly(CLUB_ZONE), 14) },
    ]);

    const response = await readerGET(readerRequest());
    expect(response.status).toBe(403);
  });

  it("allows an admin without any assignment", async () => {
    mocks.auth.mockResolvedValue(adminSession);
    useAssignments([]);

    const response = await readerGET(readerRequest());
    expect(response.status).toBe(200);
    expect(mocks.hutLeaderAssignmentCount).not.toHaveBeenCalled();
  });

  it("scopes the documents to the member's sole assignment lodge", async () => {
    mocks.auth.mockResolvedValue(memberSession);
    useAssignments([{ memberId: "member-1", endDate: getTodayDateOnly(CLUB_ZONE) }]);
    mocks.hutLeaderAssignmentFindMany.mockResolvedValue([
      { lodgeId: "lodge-2" },
      { lodgeId: "lodge-2" },
    ]);

    const response = await readerGET(readerRequest());
    expect(response.status).toBe(200);
    expect(mocks.lodgeInstructionFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { OR: [{ lodgeId: null }, { lodgeId: "lodge-2" }] },
      }),
    );
  });

  it("falls back to the club-wide documents when assignments span lodges", async () => {
    mocks.auth.mockResolvedValue(memberSession);
    useAssignments([{ memberId: "member-1", endDate: getTodayDateOnly(CLUB_ZONE) }]);
    mocks.hutLeaderAssignmentFindMany.mockResolvedValue([
      { lodgeId: "lodge-2" },
      { lodgeId: "lodge-3" },
    ]);

    const response = await readerGET(readerRequest());
    expect(response.status).toBe(200);
    expect(mocks.lodgeInstructionFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { lodgeId: null } }),
    );
  });

  it("honours an explicit lodgeId query parameter", async () => {
    mocks.auth.mockResolvedValue(adminSession);

    const response = await readerGET(readerRequest("?lodgeId=lodge-9"));
    expect(response.status).toBe(200);
    expect(mocks.lodgeInstructionFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { OR: [{ lodgeId: null }, { lodgeId: "lodge-9" }] },
      }),
    );
    // No inference query needed when the lodge is named explicitly.
    expect(mocks.hutLeaderAssignmentFindMany).not.toHaveBeenCalled();
  });

  it("M4: denies a hut leader requesting a lodge they are not assigned to", async () => {
    mocks.auth.mockResolvedValue(memberSession);
    // Gate passes (a current assignment exists) but it is for lodge-A only.
    useAssignments([{ memberId: "member-1", endDate: getTodayDateOnly(CLUB_ZONE) }]);
    mocks.hutLeaderAssignmentFindMany.mockResolvedValue([
      { lodgeId: "lodge-A" },
    ]);

    const response = await readerGET(readerRequest("?lodgeId=lodge-B"));
    expect(response.status).toBe(403);
    // Never read the requested (forbidden) lodge's documents.
    expect(mocks.lodgeInstructionFindMany).not.toHaveBeenCalled();
  });

  it("M4: allows a hut leader requesting their own assignment lodge", async () => {
    mocks.auth.mockResolvedValue(memberSession);
    useAssignments([{ memberId: "member-1", endDate: getTodayDateOnly(CLUB_ZONE) }]);
    mocks.hutLeaderAssignmentFindMany.mockResolvedValue([
      { lodgeId: "lodge-A" },
    ]);

    const response = await readerGET(readerRequest("?lodgeId=lodge-A"));
    expect(response.status).toBe(200);
    expect(mocks.lodgeInstructionFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { OR: [{ lodgeId: null }, { lodgeId: "lodge-A" }] },
      }),
    );
  });

  it("M4: allows an admin requesting any lodge", async () => {
    mocks.auth.mockResolvedValue(adminSession);

    const response = await readerGET(readerRequest("?lodgeId=lodge-B"));
    expect(response.status).toBe(200);
    expect(mocks.lodgeInstructionFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { OR: [{ lodgeId: null }, { lodgeId: "lodge-B" }] },
      }),
    );
    // Admins skip the assignment-set lookup entirely.
    expect(mocks.hutLeaderAssignmentFindMany).not.toHaveBeenCalled();
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
    mocks.lodgeInstructionFindFirst.mockResolvedValue({
      id: "lodge-instruction-1",
      contentHtml: "<p>Old</p>",
    });
    mocks.lodgeInstructionUpdate.mockImplementation(
      async ({ where, data }: { where: { id: string }; data: { contentHtml: string } }) => ({
        id: where.id,
        key: "OPEN",
        contentHtml: data.contentHtml,
        updatedAt: new Date("2026-06-11T00:00:00Z"),
        lodgeId: null,
      }),
    );
  });

  it("lists the three documents for admins", async () => {
    mocks.auth.mockResolvedValue(adminSession);
    const response = await adminGET(
      new NextRequest("http://localhost/api/admin/lodge-instructions"),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.documents).toHaveLength(3);
    // The admin editor lists the club-wide partition by default.
    expect(mocks.lodgeInstructionFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { lodgeId: null } }),
    );
  });

  it("rejects non-admin members", async () => {
    mocks.auth.mockResolvedValue(memberSession);
    const response = await adminPUT(
      putRequest({ key: "OPEN", contentHtml: "<p>Hi</p>" }),
    );
    expect(response.status).toBe(403);
    expect(mocks.lodgeInstructionUpdate).not.toHaveBeenCalled();
    expect(mocks.lodgeInstructionCreate).not.toHaveBeenCalled();
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
    expect(mocks.lodgeInstructionFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { key: "OPEN", lodgeId: null } }),
    );
    expect(mocks.lodgeInstructionUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "lodge-instruction-1" },
        data: expect.objectContaining({
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

    expect(mocks.lodgeInstructionUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ contentHtml: "<p>Lock up</p>" }),
      }),
    );
  });

  it("rejects unknown document keys", async () => {
    mocks.auth.mockResolvedValue(adminSession);
    const response = await adminPUT(
      putRequest({ key: "SOMETHING_ELSE", contentHtml: "<p>Hi</p>" }),
    );
    expect(response.status).toBe(400);
    expect(mocks.lodgeInstructionUpdate).not.toHaveBeenCalled();
    expect(mocks.lodgeInstructionCreate).not.toHaveBeenCalled();
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
    mocks.lodgeInstructionFindFirst.mockResolvedValue(null);
    let stored = "";
    mocks.lodgeInstructionCreate.mockImplementation(
      async ({ data }: { data: { key: string; contentHtml: string } }) => {
        stored = data.contentHtml;
        return {
          id: "lodge-instruction-open",
          key: data.key,
          contentHtml: data.contentHtml,
          updatedAt: new Date("2026-06-11T00:00:00Z"),
          lodgeId: null,
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
      session: { user: { id: "lodge-1", role: "LODGE", accessRoles: [{ role: "LODGE" }] } },
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
      session: { user: { id: "lodge-1", role: "LODGE", accessRoles: [{ role: "LODGE" }] } },
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

describe("text token resolution", () => {
  const tokenDocuments = [
    {
      key: "OPEN",
      contentHtml:
        "<p>Welcome to {{club-name}}. Capacity: {{lodge-capacity}}.</p>",
      updatedAt: new Date("2026-06-10T00:00:00Z"),
    },
  ];

  beforeEach(() => {
    mocks.lodgeInstructionFindMany.mockResolvedValue(tokenDocuments);
  });

  it("resolves tokens on the member reader route", async () => {
    mocks.auth.mockResolvedValue(adminSession);

    const response = await readerGET(
      new NextRequest("http://localhost/api/lodge-instructions"),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.documents[0].contentHtml).toBe(
      "<p>Welcome to Test Alpine Club. Capacity: 32.</p>",
    );
  });

  it("resolves tokens on the kiosk route", async () => {
    mocks.checkLodgeAuth.mockResolvedValue({
      session: adminSession,
      tier: "admin",
      error: null,
      status: null,
    });

    const response = await kioskGET(
      new NextRequest("http://localhost/api/lodge/instructions?date=2026-06-11"),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.documents[0].contentHtml).toBe(
      "<p>Welcome to Test Alpine Club. Capacity: 32.</p>",
    );
  });

  it("returns raw tokens on the admin editor route", async () => {
    mocks.auth.mockResolvedValue(adminSession);

    const response = await adminGET(
      new NextRequest("http://localhost/api/admin/lodge-instructions"),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.documents[0].contentHtml).toBe(
      "<p>Welcome to {{club-name}}. Capacity: {{lodge-capacity}}.</p>",
    );
  });

  it("keeps tokens raw by default in getSanitizedLodgeInstructions", async () => {
    const documents = await getSanitizedLodgeInstructions();
    expect(documents[0].contentHtml).toContain("{{club-name}}");

    const resolved = await getSanitizedLodgeInstructions({
      resolveTokens: true,
    });
    expect(resolved[0].contentHtml).toBe(
      "<p>Welcome to Test Alpine Club. Capacity: 32.</p>",
    );
  });
});

describe("hut leader assignment email", () => {
  it("links to the lodge instructions reader page", () => {
    const html = hutLeaderAssignmentTemplate({
      firstName: "Alice",
      startDate: new Date("2026-07-15"),
      endDate: new Date("2026-07-18"),
      pin: "123456",
      assignmentId: "assign-abc123",
    });

    // Links to the remote, PIN-gated instructions view scoped to this
    // assignment (#1642) — reachable by non-login hut leaders, unlike the old
    // login-gated /lodge-instructions page.
    expect(html).toContain("/hut-leader-instructions?a=assign-abc123");
  });
});
