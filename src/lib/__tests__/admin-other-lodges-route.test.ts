import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  requireActiveSessionUser: vi.fn(),
  findMany: vi.fn(),
  findUnique: vi.fn(),
  findUniqueOrThrow: vi.fn(),
  update: vi.fn(),
  amenityDeleteMany: vi.fn(),
  amenityUpsert: vi.fn(),
  auditLogCreate: vi.fn(),
  loadServerNzSettings: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ auth: mocks.auth }));

vi.mock("@/lib/session-guards", async () => ({
  requireAdmin: (await import("./helpers/require-admin-mock"))
    .evaluateRequireAdminMock,
  requireActiveSessionUser: mocks.requireActiveSessionUser,
}));

vi.mock("@/lib/servernz-settings", () => ({
  loadServerNzSettings: mocks.loadServerNzSettings,
}));

vi.mock("@/lib/prisma", () => {
  // The interactive transaction hands the same fake back as `tx`, so a write
  // made inside one is observable through the same mocks as one made outside.
  // No `create` and no `delete`: the routes no longer have a handler that
  // would call either (#52), and a fake without them proves it.
  const prisma = {
    otherLodge: {
      findMany: mocks.findMany,
      findUnique: mocks.findUnique,
      findUniqueOrThrow: mocks.findUniqueOrThrow,
      update: mocks.update,
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

import * as listRoute from "@/app/api/admin/other-lodges/route";
import * as itemRoute from "@/app/api/admin/other-lodges/[id]/route";
import { OTHER_LODGE_NOT_OWNED_CODE } from "@/lib/other-lodges";

const { GET } = listRoute;
const { PATCH } = itemRoute;

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

/** Another club's lodge, with its officer's phone stored locally. */
function theirs() {
  return record({
    id: "ol-2",
    name: "Tongariro Lodge",
    bookingOfficerName: "Sam Officer",
    bookingOfficerEmail: "sam@example.com",
    bookingOfficerPhone: "021 555 9999",
  });
}

function jsonRequest(method: "PATCH", body?: unknown) {
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

/** The central server has said: this club owns Ruapehu Ski Club. */
function owning(names: string[] | null) {
  mocks.loadServerNzSettings.mockResolvedValue({
    baseUrl: "https://central.test",
    otherLodgesEnabled: true,
    otherLodgesLastUploadAt: null,
    otherLodgesLastDownloadAt: null,
    otherLodgesCursor: null,
    otherLodgesOwnedNames: names,
    otherLodgesOwnedNamesAt: names === null ? null : now.toISOString(),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockResolvedValue(adminSession);
  mocks.requireActiveSessionUser.mockResolvedValue(null);
  mocks.auditLogCreate.mockResolvedValue(undefined);
  owning(["Ruapehu Ski Club"]);
});

describe("the create and delete handlers are gone (#52)", () => {
  it("exports no POST from the list route and no DELETE from the item route", () => {
    // A site changes only the lodge(s) the central server says it owns; it
    // neither adds to nor removes from the shared registry. With no handler
    // exported, Next.js answers 405 — a request to either cannot succeed.
    expect("POST" in listRoute).toBe(false);
    expect("DELETE" in itemRoute).toBe(false);
    expect(Object.keys(listRoute).sort()).toEqual(["GET"]);
    expect(Object.keys(itemRoute).sort()).toEqual(["PATCH"]);
  });
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

  it("sends the owned lodge's officer phone and NOT another club's, and flags which is owned", async () => {
    mocks.findMany.mockResolvedValue([record(), theirs()]);
    const data = await (await GET()).json();
    const [ours, notOurs] = data.otherLodges;
    expect(ours).toMatchObject({
      name: "Ruapehu Ski Club",
      owned: true,
      bookingOfficerPhone: "021 555 0000",
    });
    // Not null — ABSENT. Another club's officer's number does not reach the
    // browser at all, whatever the local row holds.
    expect(notOurs).toMatchObject({ name: "Tongariro Lodge", owned: false });
    expect(notOurs).not.toHaveProperty("bookingOfficerPhone");
    // The name and email still travel: only the phone is private.
    expect(notOurs.bookingOfficerName).toBe("Sam Officer");
    expect(notOurs.bookingOfficerEmail).toBe("sam@example.com");
    expect(data.ownedLodgeNames).toEqual(["Ruapehu Ski Club"]);
  });

  it("sends no phone for any lodge, and `null` as the owned list, while the list is unknown", async () => {
    owning(null);
    mocks.findMany.mockResolvedValue([record(), theirs()]);
    const data = await (await GET()).json();
    for (const lodge of data.otherLodges) {
      expect(lodge.owned).toBe(false);
      expect(lodge).not.toHaveProperty("bookingOfficerPhone");
    }
    // `null`, not `[]`: the panel explains the two states differently.
    expect(data.ownedLodgeNames).toBeNull();
  });

  it("sends an empty owned list as `[]`", async () => {
    owning([]);
    mocks.findMany.mockResolvedValue([record()]);
    const data = await (await GET()).json();
    expect(data.ownedLodgeNames).toEqual([]);
    expect(data.otherLodges[0].owned).toBe(false);
  });
});

describe("PATCH /api/admin/other-lodges/[id]", () => {
  it("returns 404 for an unknown lodge", async () => {
    mocks.findUnique.mockResolvedValue(null);
    const response = await PATCH(
      jsonRequest("PATCH", { bedCapacity: 12 }),
      params("missing"),
    );
    expect(response.status).toBe(404);
  });

  it("updates provided fields on an owned lodge and writes an audit log", async () => {
    mocks.findUnique.mockResolvedValue(record());
    mocks.update.mockResolvedValue(record({ bedCapacity: 12 }));
    const response = await PATCH(
      jsonRequest("PATCH", { bedCapacity: 12 }),
      params("ol-1"),
    );
    expect(response.status).toBe(200);
    expect(mocks.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "ol-1" },
        data: expect.objectContaining({ bedCapacity: 12 }),
      }),
    );
    expect(mocks.auditLogCreate).toHaveBeenCalledTimes(1);
    // The response is the LIST shape, so the panel can show it as saved.
    const data = await response.json();
    expect(data.otherLodge).toMatchObject({ owned: true, bookingOfficerPhone: "021 555 0000" });
  });

  it("accepts the unchanged name alongside the edit (the panel sends the whole form)", async () => {
    mocks.findUnique.mockResolvedValue(record());
    mocks.update.mockResolvedValue(record({ bedCapacity: 12 }));
    const response = await PATCH(
      jsonRequest("PATCH", { name: "Ruapehu Ski Club", bedCapacity: 12 }),
      params("ol-1"),
    );
    expect(response.status).toBe(200);
    // The name is not written, even unchanged: it is not this route's to touch.
    const [{ data }] = mocks.update.mock.calls[0];
    expect(data).toEqual({ bedCapacity: 12 });
  });

  it("refuses a lodge the central server has not said this club owns, with a code the panel reads", async () => {
    mocks.findUnique.mockResolvedValue(theirs());
    const response = await PATCH(
      jsonRequest("PATCH", { bedCapacity: 12 }),
      params("ol-2"),
    );
    expect(response.status).toBe(403);
    const data = await response.json();
    expect(data.code).toBe(OTHER_LODGE_NOT_OWNED_CODE);
    expect(data.error).toMatch(/own lodge/i);
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.amenityDeleteMany).not.toHaveBeenCalled();
    expect(mocks.auditLogCreate).not.toHaveBeenCalled();
  });

  it("refuses every lodge, including a would-be owned one, while the owned list is unknown", async () => {
    // "We have not been told" is not "we own it": hiding buttons alone is not
    // enough, so the route refuses even a lodge the admin could later own.
    owning(null);
    mocks.findUnique.mockResolvedValue(record());
    const response = await PATCH(
      jsonRequest("PATCH", { bedCapacity: 12 }),
      params("ol-1"),
    );
    expect(response.status).toBe(403);
    const data = await response.json();
    expect(data.code).toBe(OTHER_LODGE_NOT_OWNED_CODE);
    expect(data.error).toMatch(/download/i);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("refuses every lodge while the owned list is known and empty", async () => {
    owning([]);
    mocks.findUnique.mockResolvedValue(record());
    const response = await PATCH(
      jsonRequest("PATCH", { bedCapacity: 12 }),
      params("ol-1"),
    );
    expect(response.status).toBe(403);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("refuses a name change on an owned lodge: the central server matches by name", async () => {
    mocks.findUnique.mockResolvedValue(record());
    const response = await PATCH(
      jsonRequest("PATCH", { name: "Ruapehu Ski Club (renamed)", bedCapacity: 12 }),
      params("ol-1"),
    );
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/name cannot be changed/i);
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.auditLogCreate).not.toHaveBeenCalled();
  });

  it("replaces the amenity set in one transaction and moves updatedAt explicitly for an amenity-only edit", async () => {
    // No column on the lodge row changes, so `@updatedAt` would not fire — and
    // the central-server upload watermark is keyed on that column, so the new
    // amenities would never be sent.
    mocks.findUnique.mockResolvedValue(record());
    mocks.update.mockResolvedValue({ id: "ol-1" });
    const saved = record({
      amenities: [
        { name: "Boot room", description: null },
        { name: "Sauna", description: "Wood fired" },
      ],
    });
    mocks.findUniqueOrThrow.mockResolvedValue(saved);
    const response = await PATCH(
      jsonRequest("PATCH", {
        amenities: [{ name: "Sauna", description: "Wood fired" }, { name: "Boot room" }],
      }),
      params("ol-1"),
    );
    expect(response.status).toBe(200);
    // The response carries the set as saved, re-read after the replacement.
    expect((await response.json()).otherLodge.amenities).toHaveLength(2);
    // THE LODGE ROW IS WRITTEN FIRST. Its update holds the row lock for the rest
    // of the transaction, so a concurrent replacement of the same lodge's
    // amenities (the nightly download) queues behind it instead of interleaving
    // its deletes and upserts with ours.
    const rowWrite = mocks.update.mock.invocationCallOrder[0];
    expect(rowWrite).toBeLessThan(mocks.amenityDeleteMany.mock.invocationCallOrder[0]);
    expect(rowWrite).toBeLessThan(mocks.amenityUpsert.mock.invocationCallOrder[0]);
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

  it.each([
    ["the name", { name: "Ruapehu\u0000Ski Club" }],
    ["a text field", { cancellationPeriod: "7\u0000days" }],
    ["an amenity description", { amenities: [{ name: "Sauna", description: "a\u0000b" }] }],
  ])("returns 400 for a NUL character in %s, which PostgreSQL would reject with 22021", async (_label, body) => {
    mocks.findUnique.mockResolvedValue(record());
    expect((await PATCH(jsonRequest("PATCH", body), params("ol-1"))).status).toBe(400);
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.amenityDeleteMany).not.toHaveBeenCalled();
  });

  it.each([
    ["an unknown key", { distribute: true }],
    ["a site URL that is not http(s)", { siteUrl: "javascript:alert(1)" }],
    ["a site URL with no scheme", { siteUrl: "lodge.test" }],
    ["a season start that is not a real date", { winterSeasonStart: "2026-02-30" }],
    ["a season start that is not YYYY-MM-DD", { summerSeasonStart: "01/06/2026" }],
    ["a non-boolean facility", { freeWifi: "yes" }],
    ["an over-long cancellation period", { cancellationPeriod: "x".repeat(201) }],
    ["an amenity with no name", { amenities: [{ name: "" }] }],
    ["amenity names that differ only by case", { amenities: [{ name: "Sauna" }, { name: "sauna" }] }],
    [
      "more than fifty amenities",
      { amenities: Array.from({ length: 51 }, (_, i) => ({ name: `A${i}` })) },
    ],
    ["malformed JSON", "{not json"],
  ])("returns 400 for %s", async (_label, body) => {
    // The schema is `.strict()`, so this is also the proof that every key is
    // NAMED in the shared shape: one missing from it would be a 400 too.
    mocks.findUnique.mockResolvedValue(record());
    expect((await PATCH(jsonRequest("PATCH", body), params("ol-1"))).status).toBe(400);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("rejects non-admin members", async () => {
    mocks.auth.mockResolvedValue(memberSession);
    const response = await PATCH(jsonRequest("PATCH", { bedCapacity: 1 }), params("ol-1"));
    expect(response.status).toBe(403);
    // The permissions refusal carries no ownership code: the panel shows the
    // generic view-only message for it.
    expect(await response.json()).not.toHaveProperty("code");
  });
});
