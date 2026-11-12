import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * The Full Admin subject access report (#4915, `INV-PRIV-023`): who may
 * produce it, whom a lookup names, and the audit row every file leaves.
 *
 * The builder is mocked here — the realdb test proves what it reads — so these
 * cases are about the route's own decisions. The one that matters most is the
 * email lookup: member emails are not unique (a dependant can share a
 * parent's address), so an address shared by two member records is refused,
 * never resolved to whichever row the database happens to return first.
 */

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  memberFindUnique: vi.fn(),
  memberFindMany: vi.fn(),
  guestFindUnique: vi.fn(),
  checkRateLimit: vi.fn(),
  grant: vi.fn(),
  build: vi.fn(),
  createAuditLog: vi.fn(),
  requireRecentAuth: vi.fn(),
}));

vi.mock("@/lib/session-guards", () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock("@/lib/require-recent-auth", () => ({ requireRecentAuth: mocks.requireRecentAuth }));
// `@/lib/access-roles` is deliberately NOT mocked: the real `isFullAdmin`
// runs on the role token each session below carries.
vi.mock("@/lib/prisma", () => ({
  prisma: {
    member: { findUnique: mocks.memberFindUnique, findMany: mocks.memberFindMany },
    bookingGuest: { findUnique: mocks.guestFindUnique },
  },
}));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: mocks.checkRateLimit,
  rateLimiters: { subjectAccessReport: { id: "subject-access-report", limit: 20, windowSeconds: 86400 } },
  rateLimitedResponse: () => new Response(JSON.stringify({ error: "Too many requests" }), { status: 429 }),
}));
vi.mock("@/lib/member-dietary", () => ({ grantOfficerSubjectAccessDietaryAccess: mocks.grant }));
vi.mock("@/lib/subject-access-export", () => ({ buildSubjectAccessExport: mocks.build }));
vi.mock("@/lib/subject-access-export-response", () => ({
  subjectAccessExportResponse: async (payload: unknown, kind: string) =>
    new Response(JSON.stringify({ kind, payload }), { status: 200 }),
}));
vi.mock("@/lib/audit", () => ({ createAuditLog: mocks.createAuditLog }));
vi.mock("@/lib/logger", () => ({ default: { error: vi.fn() } }));

import { GET } from "../route";

const GRANT = { grant: "officer" };

function asAdmin(roles: string[]) {
  mocks.requireAdmin.mockResolvedValue({ ok: true, session: { user: { id: "officer-1", accessRoles: roles } } });
}

function get(query: string) {
  return GET(new NextRequest(`https://club.example.com/api/admin/members/subject-access?${query}`));
}

beforeEach(() => {
  vi.clearAllMocks();
  asAdmin(["ADMIN"]);
  mocks.requireRecentAuth.mockResolvedValue({ ok: true });
  mocks.checkRateLimit.mockResolvedValue({ success: true });
  mocks.grant.mockResolvedValue(GRANT);
  mocks.build.mockResolvedValue({ subjectKind: "member" });
  mocks.memberFindMany.mockResolvedValue([]);
});

describe("who may produce a subject access report", () => {
  it("refuses an officer who is not a Full Admin, before reading anything", async () => {
    asAdmin(["ADMIN_MEMBERSHIP"]);
    const res = await get("memberId=m-1");
    expect(res.status).toBe(403);
    expect(mocks.build).not.toHaveBeenCalled();
    expect(mocks.memberFindUnique).not.toHaveBeenCalled();
    expect(mocks.createAuditLog).not.toHaveBeenCalled();
  });

  it("refuses a custom role, however broad", async () => {
    asAdmin(["cmcustomroledefinitionid0001"]);
    expect((await get("memberId=m-1")).status).toBe(403);
  });

  it("passes the admin guard's own refusal through", async () => {
    mocks.requireAdmin.mockResolvedValue({ ok: false, response: new Response(null, { status: 401 }) });
    expect((await get("memberId=m-1")).status).toBe(401);
  });

  it("asks a Full Admin for a fresh sign-in proof before reading anything (INV-AUTH-010)", async () => {
    mocks.requireRecentAuth.mockResolvedValue({ ok: false, response: new Response(null, { status: 401 }) });
    expect((await get("memberId=m-1")).status).toBe(401);
    expect(mocks.memberFindUnique).not.toHaveBeenCalled();
    expect(mocks.checkRateLimit).not.toHaveBeenCalled();
  });

  it("refuses when the database no longer holds the officer as a Full Admin", async () => {
    mocks.memberFindUnique.mockResolvedValue({ id: "m-1" });
    mocks.grant.mockResolvedValue(null);
    expect((await get("memberId=m-1")).status).toBe(403);
    expect(mocks.build).not.toHaveBeenCalled();
  });

  it("is rate-limited per officer on its own limiter", async () => {
    mocks.checkRateLimit.mockResolvedValue({ success: false });
    expect((await get("memberId=m-1")).status).toBe(429);
    expect(mocks.checkRateLimit).toHaveBeenCalledWith(
      expect.objectContaining({ id: "subject-access-report" }),
      "officer-1",
    );
    expect(mocks.build).not.toHaveBeenCalled();
  });

  it("asks for exactly one lookup", async () => {
    expect((await get("")).status).toBe(400);
    expect((await get("memberId=m-1&email=a@example.com")).status).toBe(400);
    expect((await get("email=not-an-address")).status).toBe(400);
  });
});

describe("whom a lookup names", () => {
  it("reports on a member by id (a dependant without a login included) and audits officer and subject", async () => {
    mocks.memberFindUnique.mockResolvedValue({ id: "dependant-1" });
    const res = await get("memberId=dependant-1");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ kind: "subject-access-report" });
    expect(mocks.grant).toHaveBeenCalledWith("officer-1", { memberId: "dependant-1", guestId: undefined });
    expect(mocks.build).toHaveBeenCalledWith({ memberId: "dependant-1" }, GRANT);
    expect(mocks.createAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      action: "member.subject_access_exported",
      category: "privacy",
      memberId: "officer-1",
      actorMemberId: "officer-1",
      subjectMemberId: "dependant-1",
      targetId: "dependant-1",
    }));
  });

  it("404s an unknown member id", async () => {
    mocks.memberFindUnique.mockResolvedValue(null);
    expect((await get("memberId=nobody")).status).toBe(404);
    expect(mocks.createAuditLog).not.toHaveBeenCalled();
  });

  it("resolves an email held by one member record to that member", async () => {
    mocks.memberFindMany.mockResolvedValue([{ id: "m-7" }]);
    await get("email=Someone@Example.com");
    expect(mocks.memberFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { email: { equals: "someone@example.com", mode: "insensitive" } },
    }));
    expect(mocks.build).toHaveBeenCalledWith({ memberId: "m-7" }, GRANT);
  });

  it("refuses an email shared by several member records rather than guessing", async () => {
    mocks.memberFindMany.mockResolvedValue([{ id: "parent" }, { id: "dependant" }]);
    const res = await get("email=family@example.com");
    expect(res.status).toBe(409);
    expect(mocks.build).not.toHaveBeenCalled();
    expect(mocks.createAuditLog).not.toHaveBeenCalled();
  });

  it("reports on a non-member booking requester by the email they gave, naming it in the audit row", async () => {
    mocks.build.mockResolvedValue({ subjectKind: "non-member" });
    const res = await get("email=requester@example.com");
    expect(res.status).toBe(200);
    expect(mocks.grant).toHaveBeenCalledWith("officer-1", { memberId: undefined, guestId: undefined });
    expect(mocks.build).toHaveBeenCalledWith({ email: "requester@example.com" }, GRANT);
    const audit = mocks.createAuditLog.mock.calls[0]![0];
    expect(audit).toMatchObject({ memberId: "officer-1", actorMemberId: "officer-1" });
    expect(audit.details).toContain("requester@example.com");
    expect(audit.subjectMemberId).toBeUndefined();
  });

  it("404s an email that holds no record at all, and audits nothing", async () => {
    mocks.build.mockResolvedValue(null);
    expect((await get("email=stranger@example.com")).status).toBe(404);
    expect(mocks.createAuditLog).not.toHaveBeenCalled();
  });

  it("reports on a non-member guest by their exact guest row", async () => {
    mocks.guestFindUnique.mockResolvedValue({ id: "guest-9", memberId: null });
    mocks.build.mockResolvedValue({ subjectKind: "non-member" });
    expect((await get("guestId=guest-9")).status).toBe(200);
    expect(mocks.grant).toHaveBeenCalledWith("officer-1", { memberId: undefined, guestId: "guest-9" });
    expect(mocks.build).toHaveBeenCalledWith({ guestId: "guest-9" }, GRANT);
    expect(mocks.createAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      entityType: "BookingGuest",
      entityId: "guest-9",
      memberId: "officer-1",
    }));
  });

  it("treats a guest row linked to a member as that member's record", async () => {
    mocks.guestFindUnique.mockResolvedValue({ id: "guest-3", memberId: "m-3" });
    await get("guestId=guest-3");
    expect(mocks.build).toHaveBeenCalledWith({ memberId: "m-3" }, GRANT);
  });

  it("404s an unknown guest id", async () => {
    mocks.guestFindUnique.mockResolvedValue(null);
    expect((await get("guestId=nope")).status).toBe(404);
  });
});
