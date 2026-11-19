import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  requireActiveSessionUser: vi.fn(),
  lodgeFindMany: vi.fn(),
  lodgeFindFirst: vi.fn(),
  lodgeFindUnique: vi.fn(),
  lodgeCount: vi.fn(),
  lodgeCreate: vi.fn(),
  lodgeUpdate: vi.fn(),
  bookingCount: vi.fn(),
  hutLeaderAssignmentCount: vi.fn(),
  memberLodgeAccessCount: vi.fn(),
  auditLogCreate: vi.fn(),
  lodgeSettingsCreate: vi.fn(),
  transaction: vi.fn(),
  executeRaw: vi.fn(),
  revalidatePublicPageContent: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  auth: mocks.auth,
}));

/*
  The route's `permission` option reaches the mock, so every per-area gate in
  this file is real. This is where #2921 was found: the mock used to be wrapped
  in an arrow that took no parameter and therefore threw the option away, and a
  test could not tell a `lodge:view`-gated route from an ungated one, because
  the mock's absent-options fallback checks `hasAdminPortalAccess` — a check the
  real guard has never performed. 50 other files had the same hole; #2921 swept
  all of them onto the bare reference below, which has no argument to drop.

  Found while proving a lodge-list access change that has since been reverted to
  #2925, and kept because the vacuity predates that change.

  The cost of correcting the fallback was MEASURED while this lane was open, and
  is recorded here so #2975 does not have to re-derive it: 7 test files and 20
  tests go red on the correction (Xero, health, family groups, reports,
  dependents), because each was passing against a gate the mock was not
  applying. That is a route-by-route sweep, not a side effect of a lodge-list
  change.
*/
vi.mock("@/lib/session-guards", async () => ({
  requireAdmin: (await import("./helpers/require-admin-mock"))
    .evaluateRequireAdminMock,
  requireActiveSessionUser: mocks.requireActiveSessionUser,
}));
vi.mock("@/lib/public-content-revalidation", () => ({
  revalidatePublicPageContent: mocks.revalidatePublicPageContent,
}));
// E3 #1929: lodge writes also refresh DB-first identity — stub those side effects.
vi.mock("server-only", () => ({}));
vi.mock("@/lib/public-layout-cache", () => ({
  invalidatePublicClubIdentity: vi.fn(),
}));
vi.mock("@/lib/club-identity-settings", () => ({
  primeClubIdentitySync: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    lodge: {
      findMany: mocks.lodgeFindMany,
      findFirst: mocks.lodgeFindFirst,
      findUnique: mocks.lodgeFindUnique,
      count: mocks.lodgeCount,
    },
    booking: { count: mocks.bookingCount },
    hutLeaderAssignment: { count: mocks.hutLeaderAssignmentCount },
    memberLodgeAccess: { count: mocks.memberLodgeAccessCount },
    $transaction: mocks.transaction,
  },
}));

import { GET, POST } from "@/app/api/admin/lodges/route";
import { PATCH } from "@/app/api/admin/lodges/[id]/route";

const adminSession = {
  user: {
    id: "admin-1",
    role: "ADMIN",
    accessRoles: ["ADMIN"],
    // Explicit since #2887: the GET now branches on `lodge:view` to decide
    // whether the caller may see the door code, so the fixture has to say.
    adminPermissionMatrix: {
      overview: "edit",
      bookings: "edit",
      membership: "edit",
      finance: "edit",
      lodge: "edit",
      content: "edit",
      support: "edit",
    },
  },
};
const memberSession = {
  user: { id: "member-1", role: "USER", accessRoles: ["USER"] },
};

const now = new Date("2026-07-02T10:00:00.000Z");

function lodgeRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: "lodge-1",
    name: "Alpine Lodge",
    slug: "alpine-lodge",
    active: true,
    doorCode: null,
    travelNote: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function jsonRequest(method: "POST" | "PATCH", body: unknown) {
  return new NextRequest("http://localhost/api/admin/lodges", {
    method,
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function params(id: string) {
  return { params: Promise.resolve({ id }) };
}

function installTransactionMock() {
  mocks.transaction.mockImplementation(async (callback) =>
    callback({
      $executeRaw: mocks.executeRaw,
      lodge: {
        create: mocks.lodgeCreate,
        update: mocks.lodgeUpdate,
        findUnique: mocks.lodgeFindUnique,
        findFirst: mocks.lodgeFindFirst,
        findMany: mocks.lodgeFindMany,
        count: mocks.lodgeCount,
      },
      booking: { count: mocks.bookingCount },
      hutLeaderAssignment: { count: mocks.hutLeaderAssignmentCount },
      memberLodgeAccess: { count: mocks.memberLodgeAccessCount },
      auditLog: {
        create: mocks.auditLogCreate,
      },
      lodgeSettings: { create: mocks.lodgeSettingsCreate },
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockResolvedValue(adminSession);
  mocks.requireActiveSessionUser.mockResolvedValue(null);
  mocks.bookingCount.mockResolvedValue(0);
  mocks.hutLeaderAssignmentCount.mockResolvedValue(0);
  mocks.memberLodgeAccessCount.mockResolvedValue(0);
  mocks.executeRaw.mockResolvedValue(undefined);
  installTransactionMock();
});

describe("GET /api/admin/lodges", () => {
  it("rejects unauthenticated callers", async () => {
    mocks.auth.mockResolvedValue(null);
    const response = await GET();
    expect(response.status).toBe(401);
  });

  it("rejects non-admin members", async () => {
    mocks.auth.mockResolvedValue(memberSession);
    const response = await GET();
    expect(response.status).toBe(403);
  });

  it("returns serialized lodges for admins", async () => {
    mocks.lodgeFindMany.mockResolvedValue([lodgeRecord()]);
    const response = await GET();
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.lodges).toHaveLength(1);
    expect(data.lodges[0]).toMatchObject({
      id: "lodge-1",
      name: "Alpine Lodge",
      slug: "alpine-lodge",
      active: true,
    });
  });
});

describe("POST /api/admin/lodges", () => {
  it("returns 400 for malformed JSON", async () => {
    const response = await POST(jsonRequest("POST", "{not json"));
    expect(response.status).toBe(400);
  });

  it("returns 400 for invalid input", async () => {
    const response = await POST(jsonRequest("POST", { name: "", capacity: 12 }));
    expect(response.status).toBe(400);
  });

  /*
    #3407 (owner decision 14 Sep 2026): capacity is part of creating a lodge. A
    lodge created without one resolved to 0 (`unconfigured_lodge`) with Bed
    Allocation off and refused every booking, so the route refuses to create
    it at all — and creates nothing when it refuses.
  */
  it.each([
    ["missing", {}],
    ["null", { capacity: null }],
    ["zero", { capacity: 0 }],
    ["fractional", { capacity: 2.5 }],
    ["above the save bound", { capacity: 100_001 }],
    ["a string", { capacity: "12" }],
  ])("refuses a create whose capacity is %s, and writes nothing", async (_label, extra) => {
    const response = await POST(
      jsonRequest("POST", { name: "River Lodge", ...extra }),
    );
    expect(response.status).toBe(400);
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.lodgeCreate).not.toHaveBeenCalled();
    expect(mocks.lodgeSettingsCreate).not.toHaveBeenCalled();
  });

  it("writes the lodge's own settings row with its capacity inside the create transaction", async () => {
    mocks.lodgeFindFirst.mockResolvedValue(null);
    mocks.lodgeCreate.mockResolvedValue(
      lodgeRecord({ id: "lodge-2", name: "River Lodge", slug: "river-lodge" }),
    );
    mocks.lodgeFindMany.mockResolvedValue([]);
    // Record the order of the writes, so "in the same transaction" is a fact
    // about the callback and not about two mocks both having been called.
    const order: string[] = [];
    mocks.lodgeCreate.mockImplementationOnce(async () => {
      order.push("lodge");
      return lodgeRecord({ id: "lodge-2", name: "River Lodge", slug: "river-lodge" });
    });
    mocks.lodgeSettingsCreate.mockImplementationOnce(async () => {
      order.push("settings");
      return { id: "lodge-2" };
    });

    const response = await POST(
      jsonRequest("POST", { name: "River Lodge", capacity: 18 }),
    );

    expect(response.status).toBe(201);
    expect(mocks.transaction).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["lodge", "settings"]);
    // The lodge's OWN row, keyed by its id — the row the resolver reads first
    // (`loadLodgeCapacityOverride`) — never the legacy "default" row.
    expect(mocks.lodgeSettingsCreate).toHaveBeenCalledWith({
      data: {
        id: "lodge-2",
        lodgeId: "lodge-2",
        capacity: 18,
        updatedByMemberId: "admin-1",
      },
      select: { id: true },
    });
    expect(mocks.auditLogCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          metadata: expect.objectContaining({ capacity: 18 }),
        }),
      }),
    );
  });

  it("creates no lodge when the settings write fails, because both share one transaction", async () => {
    mocks.lodgeFindFirst.mockResolvedValue(null);
    mocks.lodgeCreate.mockResolvedValue(lodgeRecord({ id: "lodge-2" }));
    mocks.lodgeSettingsCreate.mockRejectedValueOnce(new Error("settings write failed"));

    await expect(
      POST(jsonRequest("POST", { name: "River Lodge", capacity: 18 })),
    ).rejects.toThrow("settings write failed");
    // The throw escapes the transaction callback, which is what rolls the lodge
    // row back; no audit row and no public revalidation follow it.
    expect(mocks.auditLogCreate).not.toHaveBeenCalled();
    expect(mocks.revalidatePublicPageContent).not.toHaveBeenCalled();
  });

  it("creates a lodge with a unique slug and audit log", async () => {
    mocks.lodgeFindFirst.mockResolvedValue(null);
    mocks.lodgeCreate.mockResolvedValue(
      lodgeRecord({
        id: "lodge-2",
        name: "River Lodge",
        slug: "river-lodge",
        doorCode: "1234",
      }),
    );
    mocks.lodgeFindMany.mockResolvedValue([
      { name: "River Lodge", doorCode: null, travelNote: null },
    ]);

    const response = await POST(
      jsonRequest("POST", { name: "River Lodge", doorCode: " 1234 ", capacity: 16 }),
    );
    expect(response.status).toBe(201);
    expect(mocks.lodgeCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          name: "River Lodge",
          slug: "river-lodge",
          doorCode: "1234",
        }),
      }),
    );
    expect(mocks.auditLogCreate).toHaveBeenCalledTimes(1);
    expect(mocks.revalidatePublicPageContent).toHaveBeenCalledOnce();
    // Door codes are physical-access secrets: the audit log must record only
    // that one is set, never the code itself.
    expect(mocks.auditLogCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          metadata: expect.objectContaining({
            newLodge: expect.objectContaining({ doorCode: "[set]" }),
          }),
        }),
      }),
    );
  });

  it("derives a suffixed slug when the base slug is taken", async () => {
    mocks.lodgeFindFirst
      .mockResolvedValueOnce({ id: "lodge-1" })
      .mockResolvedValueOnce(null);
    mocks.lodgeCreate.mockResolvedValue(
      lodgeRecord({ id: "lodge-2", slug: "alpine-lodge-2" }),
    );
    mocks.lodgeFindMany.mockResolvedValue([]);

    const response = await POST(
      jsonRequest("POST", { name: "Alpine Lodge", capacity: 16 }),
    );
    expect(response.status).toBe(201);
    expect(mocks.lodgeCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ slug: "alpine-lodge-2" }),
      }),
    );
  });
});

describe("PATCH /api/admin/lodges/[id]", () => {
  it("returns 404 for an unknown lodge", async () => {
    mocks.lodgeFindUnique.mockResolvedValue(null);
    const response = await PATCH(
      jsonRequest("PATCH", { name: "Renamed" }),
      params("missing"),
    );
    expect(response.status).toBe(404);
    expect(mocks.revalidatePublicPageContent).not.toHaveBeenCalled();
  });

  it("rejects deactivating the last active lodge", async () => {
    mocks.lodgeFindUnique.mockResolvedValue(lodgeRecord());
    mocks.lodgeCount.mockResolvedValue(0);
    const response = await PATCH(
      jsonRequest("PATCH", { active: false }),
      params("lodge-1"),
    );
    expect(response.status).toBe(409);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("allows deactivation while another active lodge exists", async () => {
    mocks.lodgeFindUnique.mockResolvedValue(lodgeRecord());
    mocks.lodgeCount.mockResolvedValue(1);
    mocks.lodgeUpdate.mockResolvedValue(lodgeRecord({ active: false }));
    mocks.lodgeFindMany.mockResolvedValue([
      { name: "Other Lodge", doorCode: null, travelNote: null },
    ]);

    const response = await PATCH(
      jsonRequest("PATCH", { active: false }),
      params("lodge-1"),
    );
    expect(response.status).toBe(200);
    expect(mocks.revalidatePublicPageContent).toHaveBeenCalledOnce();
    expect(mocks.lodgeUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: { active: false } }),
    );
  });

  it("blocks deactivation and reports counts when the lodge has dependencies", async () => {
    mocks.lodgeFindUnique.mockResolvedValue(lodgeRecord());
    mocks.lodgeCount.mockResolvedValue(1);
    mocks.bookingCount.mockResolvedValueOnce(2).mockResolvedValueOnce(0);
    mocks.hutLeaderAssignmentCount.mockResolvedValue(1);
    mocks.memberLodgeAccessCount.mockResolvedValue(0);

    const response = await PATCH(
      jsonRequest("PATCH", { active: false }),
      params("lodge-1"),
    );
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.code).toBe("LODGE_HAS_DEPENDENCIES");
    expect(body.dependencies).toMatchObject({
      futureBookings: 2,
      hutLeaderAssignments: 1,
    });
    // Nothing was mutated — the deactivation did not proceed.
    expect(mocks.lodgeUpdate).not.toHaveBeenCalled();
  });

  it("counts dependencies against the NZ calendar date, not the raw instant (F32, #1888)", async () => {
    // checkOut and hutLeaderAssignment.endDate are @db.Date (NZ calendar date
    // at UTC midnight). At NZ 2026-07-16 08:00 (NZST +12) the UTC day (Jul 15)
    // trails the NZ day, so a raw `new Date()` boundary would mis-date them.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-15T20:00:00.000Z"));
    try {
      mocks.lodgeFindUnique.mockResolvedValue(lodgeRecord());
      mocks.lodgeCount.mockResolvedValue(1);
      mocks.bookingCount.mockResolvedValue(0);
      mocks.hutLeaderAssignmentCount.mockResolvedValue(0);
      mocks.memberLodgeAccessCount.mockResolvedValue(0);
      mocks.lodgeUpdate.mockResolvedValue(lodgeRecord({ active: false }));
      mocks.lodgeFindMany.mockResolvedValue([
        { name: "Other Lodge", doorCode: null, travelNote: null },
      ]);

      await PATCH(jsonRequest("PATCH", { active: false }), params("lodge-1"));

      const bookingWhere = mocks.bookingCount.mock.calls[0][0].where;
      expect(bookingWhere.checkOut.gte.toISOString()).toBe(
        "2026-07-16T00:00:00.000Z",
      );
      // The raw-instant version would have used Date.now(); the fix must not.
      expect(bookingWhere.checkOut.gte.getTime()).not.toBe(Date.now());
      const hutWhere = mocks.hutLeaderAssignmentCount.mock.calls[0][0].where;
      expect(hutWhere.endDate.gte.toISOString()).toBe(
        "2026-07-16T00:00:00.000Z",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("force-deactivates past dependencies when force is set", async () => {
    mocks.lodgeFindUnique.mockResolvedValue(lodgeRecord());
    mocks.lodgeCount.mockResolvedValue(1);
    mocks.bookingCount.mockResolvedValue(5);
    mocks.hutLeaderAssignmentCount.mockResolvedValue(3);
    mocks.memberLodgeAccessCount.mockResolvedValue(1);
    mocks.lodgeUpdate.mockResolvedValue(lodgeRecord({ active: false }));
    mocks.lodgeFindMany.mockResolvedValue([
      { name: "Other Lodge", doorCode: null, travelNote: null },
    ]);

    const response = await PATCH(
      jsonRequest("PATCH", { active: false, force: true }),
      params("lodge-1"),
    );

    expect(response.status).toBe(200);
    expect(mocks.lodgeUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: { active: false } }),
    );
  });

  it("updates identity fields and writes an audit log", async () => {
    mocks.lodgeFindUnique.mockResolvedValue(lodgeRecord());
    mocks.lodgeFindFirst.mockResolvedValue(null);
    mocks.lodgeUpdate.mockResolvedValue(
      lodgeRecord({ name: "Summit Lodge", slug: "summit-lodge" }),
    );
    mocks.lodgeFindMany.mockResolvedValue([
      { name: "Summit Lodge", doorCode: null, travelNote: null },
    ]);

    const response = await PATCH(
      jsonRequest("PATCH", { name: "Summit Lodge", travelNote: "Chains required in winter." }),
      params("lodge-1"),
    );
    expect(response.status).toBe(200);
    expect(mocks.lodgeUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          name: "Summit Lodge",
          slug: "summit-lodge",
          travelNote: "Chains required in winter.",
        }),
      }),
    );
    expect(mocks.auditLogCreate).toHaveBeenCalledTimes(1);
  });
});
