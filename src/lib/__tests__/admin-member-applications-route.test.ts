import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

import { withTimeZoneAsync } from "./helpers/timezone";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  requireActiveSessionUser: vi.fn(),
  memberApplicationFindMany: vi.fn(),
  memberApplicationCount: vi.fn(),
  nominationTokenFindMany: vi.fn(),
  memberFindMany: vi.fn(),
  parseApplicationAddress: vi.fn(),
  parseApplicationFamilyMembers: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  auth: mocks.auth,
}));

vi.mock("@/lib/session-guards", async () => ({
  requireAdmin: (await import("./helpers/require-admin-mock"))
    .evaluateRequireAdminMock,
  requireActiveSessionUser: mocks.requireActiveSessionUser,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    memberApplication: {
      findMany: mocks.memberApplicationFindMany,
      count: mocks.memberApplicationCount,
    },
    nominationToken: {
      findMany: mocks.nominationTokenFindMany,
    },
    member: {
      findMany: mocks.memberFindMany,
    },
  },
}));

vi.mock("@/lib/nomination", () => ({
  parseApplicationAddress: mocks.parseApplicationAddress,
  parseApplicationFamilyMembers: mocks.parseApplicationFamilyMembers,
}));

import { GET } from "@/app/api/admin/member-applications/route";

describe("GET /api/admin/member-applications", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.mockResolvedValue({
      user: { id: "admin-1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }] },
    });
    mocks.requireActiveSessionUser.mockResolvedValue(null);
    mocks.memberApplicationFindMany.mockResolvedValue([]);
    mocks.memberApplicationCount.mockResolvedValue(0);
    mocks.nominationTokenFindMany.mockResolvedValue([]);
    mocks.memberFindMany.mockResolvedValue([]);
    mocks.parseApplicationAddress.mockImplementation((value) => value);
    mocks.parseApplicationFamilyMembers.mockImplementation((value) => value);
  });

  it("blocks deactivated admin sessions", async () => {
    mocks.requireActiveSessionUser.mockResolvedValue(
      NextResponse.json({ error: "Account is deactivated" }, { status: 403 })
    );

    const response = await GET(
      new NextRequest("http://localhost/api/admin/member-applications")
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "Account is deactivated",
    });
    expect(mocks.memberApplicationFindMany).not.toHaveBeenCalled();
  });

  it("returns an empty queue for active admins", async () => {
    const response = await GET(
      new NextRequest("http://localhost/api/admin/member-applications")
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      data: [],
      applications: [],
      pendingCount: 0,
      page: 1,
      pageSize: 25,
      total: 0,
    });
    expect(mocks.requireActiveSessionUser).toHaveBeenCalledWith("admin-1");
    expect(mocks.memberApplicationFindMany).toHaveBeenCalledWith({
      orderBy: { createdAt: "desc" },
      where: undefined,
      take: 25,
      skip: 0,
    });
    expect(mocks.memberApplicationCount).toHaveBeenCalledWith({ where: undefined });
    expect(mocks.memberApplicationCount).toHaveBeenCalledWith({
      where: { status: "PENDING_ADMIN" },
    });
    expect(mocks.memberFindMany).not.toHaveBeenCalled();
  });

  it("decorates waiting applications with pending nomination token status", async () => {
    mocks.memberApplicationFindMany.mockResolvedValue([
      {
        id: "app-1",
        applicantFirstName: "Pat",
        applicantLastName: "Applicant",
        applicantEmail: "pat@example.com",
        applicantDateOfBirth: null,
        applicantPhone: null,
        applicantAddress: null,
        familyMembers: [],
        nominator1Email: "nom1@example.com",
        nominator2Email: "nom2@example.com",
        nominator1Id: "nom-1",
        nominator2Id: "nom-2",
        nominator1ConfirmedAt: null,
        nominator2ConfirmedAt: null,
        status: "PENDING_NOMINATORS",
        adminNotes: null,
        reviewedBy: null,
        reviewedAt: null,
        createdAt: new Date("2026-06-01T00:00:00.000Z"),
        updatedAt: new Date("2026-06-01T00:00:00.000Z"),
      },
    ]);
    mocks.memberApplicationCount.mockResolvedValueOnce(1).mockResolvedValueOnce(0);
    mocks.memberFindMany.mockResolvedValue([
      { id: "nom-1", firstName: "Nom", lastName: "One" },
      { id: "nom-2", firstName: "Nom", lastName: "Two" },
    ]);
    mocks.nominationTokenFindMany.mockResolvedValue([
      {
        id: "token-1",
        applicationId: "app-1",
        nominatorMemberId: "nom-1",
        expiresAt: new Date("2026-06-08T00:00:00.000Z"),
        reminderCount: 4,
        lastSentAt: new Date("2026-06-01T00:00:00.000Z"),
        createdAt: new Date("2026-06-01T00:00:00.000Z"),
      },
    ]);

    const response = await GET(
      new NextRequest("http://localhost/api/admin/member-applications?status=PENDING_NOMINATORS")
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.applications[0]).toMatchObject({
      id: "app-1",
      nominator1Name: "Nom One",
      nominator1TokenExpiresAt: "2026-06-08T00:00:00.000Z",
      nominator1TokenLastSentAt: "2026-06-01T00:00:00.000Z",
      nominator1ReminderCount: 4,
      nominatorReminderLimit: 4,
      nominator1ReminderExhausted: true,
      nominator2ReminderExhausted: false,
    });
    expect(mocks.nominationTokenFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          applicationId: { in: ["app-1"] },
          confirmedAt: null,
        },
      })
    );
  });

  it("serialises applicantDateOfBirth as the stored calendar day, from any club zone (#1931 HIGH-2, #2872)", async () => {
    // The approval panel passes this value verbatim into the joining-fee
    // preview endpoint, whose schema is a strict /^\d{4}-\d{2}-\d{2}$/ — a full
    // ISO datetime would 400 and the preview/prefill would silently never fire.
    //
    // #2872 CHANGED WHAT THIS TEST HAS TO PROVE, so read the history before
    // reading the assertions. `MemberApplication.applicantDateOfBirth` used to
    // be a bare `DateTime`, so the route read it through the club-zone formatter
    // to be robust against a value stored at NZ midnight as well as at UTC
    // midnight, and this test carried a fixture of each. CT-3 narrowed the
    // column to `@db.Date`: PostgreSQL now holds a calendar day with no time in
    // it, Prisma hands every such value back at UTC midnight, and the migration
    // refuses to run at all if any stored row carries a time. The NZ-midnight
    // fixture therefore describes a state the database can no longer be in.
    //
    // The claim worth making instead is the one the club-zone formatter got
    // WRONG. A calendar day takes no timezone, and reading a UTC-midnight
    // encoding through a club zone BEHIND UTC returns the previous day — so
    // this asserts the day is the stored day whichever zone the club keeps.
    // Both fixtures are UTC midnight because that is the only shape the column
    // can hold; what separates the two formatters is the ZONE, which is why the
    // second read is taken under `America/Denver` (INV-DATE-010, and
    // INV-CONFIG-001: the product is not a New Zealand product).
    const base = {
      applicantFirstName: "Pat",
      applicantLastName: "Applicant",
      applicantEmail: "pat@example.com",
      applicantPhone: null,
      applicantAddress: null,
      familyMembers: [],
      nominator1Email: "nom1@example.com",
      nominator2Email: "nom2@example.com",
      nominator1Id: null,
      nominator2Id: null,
      nominator1ConfirmedAt: null,
      nominator2ConfirmedAt: null,
      status: "PENDING_ADMIN",
      adminNotes: null,
      reviewedBy: null,
      reviewedAt: null,
      createdAt: new Date("2026-06-01T00:00:00.000Z"),
      updatedAt: new Date("2026-06-01T00:00:00.000Z"),
    };
    const rows = [
      { ...base, id: "app-utc", applicantDateOfBirth: new Date("1990-05-15T00:00:00.000Z") },
      // New Year's Day, the value a westward projection sends into the previous
      // YEAR rather than merely the previous day.
      { ...base, id: "app-newyear", applicantDateOfBirth: new Date("2001-01-01T00:00:00.000Z") },
    ];

    // RE-IMPORTED UNDER THE ZONE, NOT MERELY CALLED UNDER IT, and this is the
    // whole reason the assertion has teeth. `formatDateOnlyForTimeZone` defaults
    // to `APP_TIME_ZONE`, which `src/config/operational.ts` reads from
    // `process.env.TZ` ONCE at module load — so setting the zone at call time
    // changes nothing, and a first version of this test passed against the very
    // formatter it exists to reject. `vi.resetModules()` plus a dynamic import
    // is what makes the route re-evaluate the constant, the same pattern
    // `api/chores/roster/[date]/print` uses for the same reason (#2478).
    async function readDatesOfBirth() {
      vi.resetModules();
      const { GET: RouteGET } = await import(
        "@/app/api/admin/member-applications/route"
      );
      mocks.memberApplicationFindMany.mockResolvedValue(rows);
      mocks.memberApplicationCount.mockResolvedValueOnce(2).mockResolvedValueOnce(2);

      const response = await RouteGET(
        new NextRequest("http://localhost/api/admin/member-applications")
      );
      expect(response.status).toBe(200);
      const body = await response.json();
      return new Map(
        body.applications.map((app: { id: string; applicantDateOfBirth: string }) => [
          app.id,
          app.applicantDateOfBirth,
        ]),
      );
    }

    const hostRead = await withTimeZoneAsync("Pacific/Auckland", () =>
      readDatesOfBirth(),
    );
    expect(hostRead.get("app-utc")).toBe("1990-05-15");
    expect(hostRead.get("app-newyear")).toBe("2001-01-01");

    // The same rows, read by a club that keeps a zone BEHIND UTC. Truncation
    // answers the stored day; the club-zone formatter this route used to call
    // would answer 1990-05-14 and 2000-12-31 here.
    const denverRead = await withTimeZoneAsync("America/Denver", () =>
      readDatesOfBirth(),
    );
    expect(
      denverRead.get("app-utc"),
      "INV-DATE-010: a calendar day takes no timezone. If this moves, the " +
        "route is projecting a stored day through a zone again and every club " +
        "behind UTC reads every date of birth one day early.",
    ).toBe("1990-05-15");
    expect(denverRead.get("app-newyear")).toBe("2001-01-01");
  });
});
