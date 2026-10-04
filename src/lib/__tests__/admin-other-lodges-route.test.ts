import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { Prisma } from "@prisma/client";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  requireActiveSessionUser: vi.fn(),
  findMany: vi.fn(),
  findUnique: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  del: vi.fn(),
  amenityDeleteMany: vi.fn(),
  amenityUpsert: vi.fn(),
  auditLogCreate: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ auth: mocks.auth }));

vi.mock("@/lib/session-guards", async () => ({
  requireAdmin: (await import("./helpers/require-admin-mock"))
    .evaluateRequireAdminMock,
  requireActiveSessionUser: mocks.requireActiveSessionUser,
}));

vi.mock("@/lib/prisma", () => {
  // The interactive transaction hands the same fake back as `tx`, so a write
  // made inside one is observable through the same mocks as one made outside.
  const prisma = {
    otherLodge: {
      findMany: mocks.findMany,
      findUnique: mocks.findUnique,
      create: mocks.create,
      update: mocks.update,
      delete: mocks.del,
    },
    amenity: {
      deleteMany: mocks.amenityDeleteMany,
      upsert: mocks.amenityUpsert,
    },
    auditLog: { create: mocks.auditLogCreate },
    $transaction: (fn: (tx: unknown) => Promise<unknown>) => fn(prisma),
  };
  return { prisma };
});

import { GET, POST } from "@/app/api/admin/other-lodges/route";
import { PATCH, DELETE } from "@/app/api/admin/other-lodges/[id]/route";

const adminSession = {
  user: { id: "admin-1", role: "ADMIN", accessRoles: ["ADMIN"] },
};
const memberSession = {
  user: { id: "member-1", role: "USER", accessRoles: ["USER"] },
};

const now = new Date("2026-08-10T10:00:00.000Z");

function record(overrides: Record<string, unknown> = {}) {
  return {
    id: "ol-1",
    name: "Ruapehu Ski Club",
    location: "Whakapapa",
    bookingOfficerName: "Jo Officer",
    bookingOfficerEmail: "jo@example.com",
    bookingOfficerPhone: "021 555 0000",
    bedCapacity: 40,
    siteUrl: "https://ruapehu.test",
    bookingPath: null,
    requiresLodgeCustodian: false,
    freeWifi: true,
    quietRoom: false,
    dryingRoom: true,
    sharedKitchen: true,
    wheelchairAccessible: false,
    breakfastIncluded: false,
    lunchIncluded: false,
    dinnerIncluded: false,
    cancellationPeriod: "7 days",
    // `@db.Date` columns read back as UTC midnight.
    winterSeasonStart: new Date("2026-06-01T00:00:00.000Z"),
    summerSeasonStart: null,
    amenities: [{ name: "Sauna", description: null }],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function jsonRequest(method: "POST" | "PATCH" | "DELETE", body?: unknown) {
  return new NextRequest("http://localhost/api/admin/other-lodges", {
    method,
    headers: { "content-type": "application/json" },
    body:
      body === undefined
        ? undefined
        : typeof body === "string"
          ? body
          : JSON.stringify(body),
  });
}

function params(id: string) {
  return { params: Promise.resolve({ id }) };
}

function uniqueViolation() {
  return new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
    code: "P2002",
    clientVersion: "test",
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockResolvedValue(adminSession);
  mocks.requireActiveSessionUser.mockResolvedValue(null);
  mocks.auditLogCreate.mockResolvedValue(undefined);
});

describe("GET /api/admin/other-lodges", () => {
  it("rejects unauthenticated callers", async () => {
    mocks.auth.mockResolvedValue(null);
    expect((await GET()).status).toBe(401);
  });

  it("rejects non-admin members", async () => {
    mocks.auth.mockResolvedValue(memberSession);
    expect((await GET()).status).toBe(403);
  });

  it("returns serialized other lodges", async () => {
    mocks.findMany.mockResolvedValue([record()]);
    const response = await GET();
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.otherLodges).toHaveLength(1);
    expect(data.otherLodges[0]).toMatchObject({
      id: "ol-1",
      name: "Ruapehu Ski Club",
      bedCapacity: 40,
    });
    // Dates are serialized to ISO strings, not Date objects.
    expect(data.otherLodges[0].createdAt).toBe(now.toISOString());
  });

  it("serializes the lodge details, with season starts as calendar days and the amenity list", async () => {
    mocks.findMany.mockResolvedValue([record()]);
    const data = await (await GET()).json();
    expect(data.otherLodges[0]).toMatchObject({
      siteUrl: "https://ruapehu.test",
      freeWifi: true,
      quietRoom: false,
      cancellationPeriod: "7 days",
      // The day the column holds, not an instant — no time, no zone.
      winterSeasonStart: "2026-06-01",
      summerSeasonStart: null,
      amenities: [{ name: "Sauna", description: null }],
    });
  });
});

describe("POST /api/admin/other-lodges", () => {
  it("returns 400 for malformed JSON", async () => {
    expect((await POST(jsonRequest("POST", "{not json"))).status).toBe(400);
  });

  it("returns 400 for a missing name", async () => {
    expect((await POST(jsonRequest("POST", { name: "" }))).status).toBe(400);
  });

  it("returns 400 for a malformed booking officer email", async () => {
    const response = await POST(
      jsonRequest("POST", { name: "X", bookingOfficerEmail: "not-an-email" }),
    );
    expect(response.status).toBe(400);
  });

  it("creates a lodge, folding blanks to null, and writes an audit log", async () => {
    mocks.create.mockResolvedValue(
      record({ id: "ol-2", name: "Tongariro Lodge", location: null }),
    );
    const response = await POST(
      jsonRequest("POST", {
        name: "  Tongariro Lodge  ",
        location: "   ",
        bookingOfficerEmail: "",
        bedCapacity: 24,
      }),
    );
    expect(response.status).toBe(201);
    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          name: "Tongariro Lodge",
          location: null,
          bookingOfficerEmail: null,
          bedCapacity: 24,
        }),
      }),
    );
    expect(mocks.auditLogCreate).toHaveBeenCalledTimes(1);
  });

  it("returns 409 when the name already exists", async () => {
    mocks.create.mockRejectedValue(uniqueViolation());
    const response = await POST(jsonRequest("POST", { name: "Dup Lodge" }));
    expect(response.status).toBe(409);
    expect(mocks.auditLogCreate).not.toHaveBeenCalled();
  });

  it("accepts every detail field and the amenity list, storing dates as the calendar day", async () => {
    // The schema is `.strict()`, so this is also the proof that every new key
    // is NAMED there: one missing from the shared shape would be a 400.
    mocks.create.mockResolvedValue(record({ id: "ol-3" }));
    const response = await POST(
      jsonRequest("POST", {
        name: "Detailed Lodge",
        siteUrl: "https://lodge.test/",
        bookingPath: "  Email the booking officer  ",
        requiresLodgeCustodian: true,
        freeWifi: true,
        quietRoom: false,
        dryingRoom: true,
        sharedKitchen: false,
        wheelchairAccessible: true,
        breakfastIncluded: false,
        lunchIncluded: true,
        dinnerIncluded: false,
        cancellationPeriod: "",
        winterSeasonStart: "2026-06-01",
        summerSeasonStart: "",
        amenities: [{ name: " Sauna ", description: "" }, { name: "Boot room" }],
      }),
    );
    expect(response.status).toBe(201);
    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          siteUrl: "https://lodge.test/",
          bookingPath: "Email the booking officer",
          requiresLodgeCustodian: true,
          lunchIncluded: true,
          dinnerIncluded: false,
          // Blank text and a blank date both clear to null, never "".
          cancellationPeriod: null,
          summerSeasonStart: null,
          // The UTC-midnight encoding a `@db.Date` column stores.
          winterSeasonStart: new Date("2026-06-01T00:00:00.000Z"),
          amenities: {
            create: [
              { name: "Sauna", description: null },
              { name: "Boot room", description: null },
            ],
          },
        }),
      }),
    );
  });

  it.each([
    ["an unknown key", { name: "X", distribute: true }],
    ["a site URL that is not http(s)", { name: "X", siteUrl: "javascript:alert(1)" }],
    ["a site URL with no scheme", { name: "X", siteUrl: "lodge.test" }],
    ["a season start that is not a real date", { name: "X", winterSeasonStart: "2026-02-30" }],
    ["a season start that is not YYYY-MM-DD", { name: "X", summerSeasonStart: "01/06/2026" }],
    ["a non-boolean facility", { name: "X", freeWifi: "yes" }],
    ["an over-long cancellation period", { name: "X", cancellationPeriod: "x".repeat(201) }],
    ["an amenity with no name", { name: "X", amenities: [{ name: "" }] }],
    [
      "amenity names that differ only by case",
      { name: "X", amenities: [{ name: "Sauna" }, { name: "sauna" }] },
    ],
    [
      "more than fifty amenities",
      { name: "X", amenities: Array.from({ length: 51 }, (_, i) => ({ name: `A${i}` })) },
    ],
  ])("returns 400 for %s", async (_label, body) => {
    expect((await POST(jsonRequest("POST", body))).status).toBe(400);
    expect(mocks.create).not.toHaveBeenCalled();
  });
});

describe("PATCH /api/admin/other-lodges/[id]", () => {
  it("returns 404 for an unknown lodge", async () => {
    mocks.findUnique.mockResolvedValue(null);
    const response = await PATCH(
      jsonRequest("PATCH", { name: "Renamed" }),
      params("missing"),
    );
    expect(response.status).toBe(404);
  });

  it("updates provided fields and writes an audit log", async () => {
    mocks.findUnique.mockResolvedValue(record());
    mocks.update.mockResolvedValue(record({ name: "Renamed", bedCapacity: 12 }));
    const response = await PATCH(
      jsonRequest("PATCH", { name: "Renamed", bedCapacity: 12 }),
      params("ol-1"),
    );
    expect(response.status).toBe(200);
    expect(mocks.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "ol-1" },
        data: expect.objectContaining({ name: "Renamed", bedCapacity: 12 }),
      }),
    );
    expect(mocks.auditLogCreate).toHaveBeenCalledTimes(1);
  });

  it("returns 409 when renaming onto an existing name", async () => {
    mocks.findUnique.mockResolvedValue(record());
    mocks.update.mockRejectedValue(uniqueViolation());
    const response = await PATCH(
      jsonRequest("PATCH", { name: "Taken" }),
      params("ol-1"),
    );
    expect(response.status).toBe(409);
  });

  it("replaces the amenity set in one transaction and moves updatedAt explicitly for an amenity-only edit", async () => {
    // No column on the lodge row changes, so `@updatedAt` would not fire — and
    // the central-server upload watermark is keyed on that column, so the new
    // amenities would never be sent.
    mocks.findUnique.mockResolvedValue(record());
    mocks.update.mockResolvedValue(record());
    const response = await PATCH(
      jsonRequest("PATCH", {
        amenities: [{ name: "Sauna", description: "Wood fired" }, { name: "Boot room" }],
      }),
      params("ol-1"),
    );
    expect(response.status).toBe(200);
    expect(mocks.amenityDeleteMany).toHaveBeenCalledWith({
      where: { otherLodgeId: "ol-1", name: { notIn: ["Sauna", "Boot room"] } },
    });
    expect(mocks.amenityUpsert).toHaveBeenCalledWith({
      where: { otherLodgeId_name: { otherLodgeId: "ol-1", name: "Sauna" } },
      create: { otherLodgeId: "ol-1", name: "Sauna", description: "Wood fired" },
      update: { description: "Wood fired" },
    });
    expect(mocks.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "ol-1" },
        data: { updatedAt: expect.any(Date) },
      }),
    );
    expect(mocks.auditLogCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          metadata: expect.objectContaining({ changedFields: ["amenities"] }),
        }),
      }),
    );
  });

  it("writes nothing when the amenity list sent is the one already stored", async () => {
    mocks.findUnique.mockResolvedValue(record());
    const response = await PATCH(
      jsonRequest("PATCH", { amenities: [{ name: "Sauna", description: "" }] }),
      params("ol-1"),
    );
    expect(response.status).toBe(200);
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.amenityDeleteMany).not.toHaveBeenCalled();
    expect(mocks.auditLogCreate).not.toHaveBeenCalled();
  });

  it("clears a season start and a facility without touching fields it was not sent", async () => {
    mocks.findUnique.mockResolvedValue(record());
    mocks.update.mockResolvedValue(record({ winterSeasonStart: null, freeWifi: false }));
    const response = await PATCH(
      jsonRequest("PATCH", { winterSeasonStart: "", freeWifi: false }),
      params("ol-1"),
    );
    expect(response.status).toBe(200);
    const [{ data }] = mocks.update.mock.calls[0];
    expect(data).toEqual({ winterSeasonStart: null, freeWifi: false });
    // Not sent, so not in the write: a partial update never clears a column it
    // did not mention, and no transaction is opened when the amenities are absent.
    expect(mocks.amenityDeleteMany).not.toHaveBeenCalled();
  });

  it("rejects an unknown key and an invalid site URL exactly as create does", async () => {
    mocks.findUnique.mockResolvedValue(record());
    expect(
      (await PATCH(jsonRequest("PATCH", { distribute: true }), params("ol-1"))).status,
    ).toBe(400);
    expect(
      (await PATCH(jsonRequest("PATCH", { siteUrl: "ftp://lodge.test" }), params("ol-1")))
        .status,
    ).toBe(400);
    expect(mocks.update).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/admin/other-lodges/[id]", () => {
  it("returns 404 for an unknown lodge", async () => {
    mocks.findUnique.mockResolvedValue(null);
    const response = await DELETE(jsonRequest("DELETE"), params("missing"));
    expect(response.status).toBe(404);
    expect(mocks.del).not.toHaveBeenCalled();
  });

  it("deletes the lodge and writes an audit log", async () => {
    mocks.findUnique.mockResolvedValue(record());
    mocks.del.mockResolvedValue(record());
    const response = await DELETE(jsonRequest("DELETE"), params("ol-1"));
    expect(response.status).toBe(200);
    expect(mocks.del).toHaveBeenCalledWith({ where: { id: "ol-1" } });
    expect(mocks.auditLogCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "OTHER_LODGE_DELETED",
        }),
      }),
    );
  });

  it("returns 409 when the lodge is referenced by a booking request (#2749)", async () => {
    mocks.findUnique.mockResolvedValue(record());
    mocks.del.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("FK violation", {
        code: "P2003",
        clientVersion: "test",
      }),
    );
    const response = await DELETE(jsonRequest("DELETE"), params("ol-1"));
    expect(response.status).toBe(409);
    expect(mocks.auditLogCreate).not.toHaveBeenCalled();
  });

  it("rejects non-admin members", async () => {
    mocks.auth.mockResolvedValue(memberSession);
    const response = await DELETE(jsonRequest("DELETE"), params("ol-1"));
    expect(response.status).toBe(403);
  });
});
