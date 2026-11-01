import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  requireActiveSessionUser: vi.fn(),
  findMany: vi.fn(),
  findUnique: vi.fn(),
  findUniqueOrThrow: vi.fn(),
  update: vi.fn(),
  updateMany: vi.fn(),
  amenityDeleteMany: vi.fn(),
  amenityUpsert: vi.fn(),
  auditLogCreate: vi.fn(),
  loadServerNzSettings: vi.fn(),
  readStoredServerVersion: vi.fn(),
  syncOwnOtherLodgesFromFees: vi.fn(),
  otherLodgeFeesProblem: vi.fn(),
}));

// #77: the Fees-page fill has its own tests; here only that the save runs it.
vi.mock("@/lib/other-lodge-fees-sync", () => ({
  syncOwnOtherLodgesFromFees: mocks.syncOwnOtherLodgesFromFees,
  otherLodgeFeesProblem: mocks.otherLodgeFeesProblem,
  FEES_FILL_PROBLEM_TEXT: { "no-local-lodge": "Not filled: not linked." },
}));

// #49: the list read reports the STORED version status; the check itself
// (a network call) is never made from here, so only the reader is mocked.
vi.mock("@/lib/servernz-version-check", () => ({
  readStoredServerVersion: mocks.readStoredServerVersion,
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
      // The PATCH reads a VISIBLE lodge by id (#58), with findFirst.
      findFirst: mocks.findUnique,
      findUniqueOrThrow: mocks.findUniqueOrThrow,
      update: mocks.update,
      updateMany: mocks.updateMany,
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
    // Keyed to the owned lodge (`owning` gives the first name "c-1") unless a
    // test says otherwise: ownership is by central id (#69).
    centralId: "c-1",
    location: "Whakapapa",
    bookingOfficerName: "Jo Officer",
    bookingOfficerEmail: "jo@example.com",
    bookingOfficerPhone: "021 555 0000",
    bedCapacity: 40,
    siteUrl: "https://ruapehu.test",
    doubleBeds: null,
    singleBeds: null,
    minutesWalkToLodge: null,
    roomType: null,
    skiWorkshopArea: false,
    gamesRoom: false,
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
    winterRateUnder5Cents: null,
    winterRate5To11Cents: null,
    winterRate12To17Cents: null,
    winterRateAdultCents: null,
    summerRateUnder5Cents: null,
    summerRate5To11Cents: null,
    summerRate12To17Cents: null,
    summerRateAdultCents: null,
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
    centralId: "c-theirs",
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

/**
 * The central server has said: this club owns these lodges, the first under
 * central id `c-1`, the next `c-2` and so on (#69: owned by id).
 */
function owning(names: string[] | null) {
  mocks.loadServerNzSettings.mockResolvedValue({
    baseUrl: "https://central.test",
    otherLodgesEnabled: true,
    otherLodgesLastUploadAt: null,
    otherLodgesLastDownloadAt: null,
    otherLodgesCursor: null,
    otherLodgesOwnedLodges: names === null ? null : names.map((name, i) => ({ id: `c-${i + 1}`, name })),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockResolvedValue(adminSession);
  mocks.requireActiveSessionUser.mockResolvedValue(null);
  mocks.auditLogCreate.mockResolvedValue(undefined);
  mocks.readStoredServerVersion.mockResolvedValue({
    status: "match",
    serverVersion: "2.0",
    expected: "2.0",
    checkedAt: now.toISOString(),
    couldNotCheck: false,
  });
  owning(["Ruapehu Ski Club"]);
  mocks.otherLodgeFeesProblem.mockResolvedValue(null);
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

describe("GET /api/admin/other-lodges marks lodges the central server no longer has (#64)", () => {
  function keyed() {
    mocks.loadServerNzSettings.mockResolvedValue({
      otherLodgesOwnedLodges: [{ id: "c-1", name: "Ruapehu Ski Club" }],
      otherLodgesKeyedAt: "2026-10-14T00:00:00.000Z",
    });
  }

  it("marks an unkeyed row, with what cites it, once a whole download has keyed the registry", async () => {
    keyed();
    mocks.findMany
      .mockResolvedValueOnce([
        record({ id: "ol-1", centralId: "c-1" }),
        record({ id: "ol-old", name: "Ruapehu Lodge (old)", centralId: null }),
      ])
      .mockResolvedValueOnce([{ id: "ol-old", _count: { bookings: 2, bookingRequests: 1 } }]);
    const data = await (await GET()).json();
    expect(data.otherLodges[0]).not.toHaveProperty("notOnCentralServer");
    expect(data.otherLodges[1].notOnCentralServer).toEqual({ bookings: 2, bookingRequests: 1 });
    expect(mocks.findMany.mock.calls[1][0].where).toEqual({ id: { in: ["ol-old"] } });
  });

  it("never lists a HIDDEN lodge (#58): it is kept only for the bookings that name it", async () => {
    mocks.findMany.mockResolvedValueOnce([record()]);
    await GET();
    expect(mocks.findMany.mock.calls[0][0].where).toEqual({ hiddenAt: null });
  });

  it("marks nothing until a whole download has keyed the registry, even with keyed rows", async () => {
    mocks.findMany.mockResolvedValueOnce([
      record({ id: "ol-1", centralId: "c-1" }),
      record({ id: "ol-2", name: "Not yet matched", centralId: null }),
    ]);
    const data = await (await GET()).json();
    expect(data.otherLodges[1]).not.toHaveProperty("notOnCentralServer");
    expect(mocks.findMany).toHaveBeenCalledTimes(1);
  });

  it("says an owned lodge is renamable only once it is keyed", async () => {
    mocks.findMany.mockResolvedValueOnce([
      record({ id: "ol-1", centralId: "c-1" }),
    ]);
    expect((await (await GET()).json()).otherLodges[0]).toMatchObject({ owned: true, renamable: true });
    // Not keyed yet: never ours, even under the owned lodge's name (#69).
    mocks.findMany.mockResolvedValueOnce([record({ id: "ol-1", centralId: null })]);
    expect((await (await GET()).json()).otherLodges[0]).toMatchObject({ owned: false, renamable: false });
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

  it("reports the STORED server-version status so the panel can say syncing is paused (#49)", async () => {
    mocks.findMany.mockResolvedValue([record()]);
    expect((await (await GET()).json()).serverVersionStatus).toBe("match");

    mocks.readStoredServerVersion.mockResolvedValue({
      status: "mismatch",
      serverVersion: "2.1",
      expected: "2.0",
      checkedAt: now.toISOString(),
      couldNotCheck: false,
    });
    const data = await (await GET()).json();
    expect(data.serverVersionStatus).toBe("mismatch");
    // The list itself is still served: the panel shows the rows AND the note.
    expect(data.otherLodges).toHaveLength(1);
    // Read, not checked: a list read must never contact the server.
    expect(mocks.readStoredServerVersion).toHaveBeenCalledTimes(2);
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
    // The UNKNOWN wording, not the not-owned one: the two refusals share a
    // status and a code, and the message is what tells the administrator which
    // it is (both happen to mention a download, so match the distinct phrase).
    expect(data.error).toMatch(/not yet been told/i);
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

  it("will not edit a HIDDEN lodge (#58): it reads only visible lodges", async () => {
    mocks.findUnique.mockResolvedValue(null);
    const response = await PATCH(jsonRequest("PATCH", { bedCapacity: 12 }), params("ol-1"));
    expect(response.status).toBe(404);
    expect(mocks.findUnique.mock.calls[0][0].where).toEqual({ id: "ol-1", hiddenAt: null });
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("refuses any edit of a row not yet keyed, even one with the owned lodge's name (#69)", async () => {
    // Another row of that name may be ours: the download keys it first.
    mocks.findUnique.mockResolvedValue(record({ centralId: null }));
    const response = await PATCH(
      jsonRequest("PATCH", { name: "Ruapehu Ski Club (renamed)", bedCapacity: 12 }),
      params("ol-1"),
    );
    expect(response.status).toBe(403);
    expect((await response.json()).code).toBe("OTHER_LODGE_NOT_OWNED");
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.auditLogCreate).not.toHaveBeenCalled();
  });

  it("renames a keyed owned lodge in one write; it stays ours by its id (#64, #69)", async () => {
    mocks.findUnique.mockResolvedValue(record({ centralId: "c-1" }));
    mocks.update.mockResolvedValue(record({ centralId: "c-1", name: "Ruapehu Alpine Lodge" }));
    const response = await PATCH(
      jsonRequest("PATCH", { name: "  Ruapehu Alpine Lodge ", bedCapacity: 12 }),
      params("ol-1"),
    );
    expect(response.status).toBe(200);
    const [{ where, data }] = mocks.update.mock.calls[0];
    expect(where).toEqual({ id: "ol-1" });
    expect(data).toEqual({ bedCapacity: 12, name: "Ruapehu Alpine Lodge" });
    expect(mocks.updateMany).not.toHaveBeenCalled();
    // Still ours in the answer, under the new name: the owned list is by id.
    expect((await response.json()).otherLodge).toMatchObject({
      name: "Ruapehu Alpine Lodge",
      owned: true,
      renamable: true,
    });
    const [{ data: audit }] = mocks.auditLogCreate.mock.calls[0];
    expect(audit.metadata.changedFields).toContain("name");
  });

  it("renames onto a name another lodge already has: names may repeat (#69)", async () => {
    mocks.findUnique.mockResolvedValue(record({ centralId: "c-1" }));
    mocks.update.mockResolvedValue(record({ centralId: "c-1", name: "Tongariro Lodge" }));
    const response = await PATCH(jsonRequest("PATCH", { name: "Tongariro Lodge" }), params("ol-1"));
    expect(response.status).toBe(200);
    expect(mocks.update.mock.calls[0][0].data).toEqual({ name: "Tongariro Lodge" });
  });

  it("refuses a lodge that shares the owned lodge's name but is keyed to another central lodge (#69)", async () => {
    mocks.findUnique.mockResolvedValue(record({ centralId: "c-other" }));
    const response = await PATCH(jsonRequest("PATCH", { bedCapacity: 12 }), params("ol-1"));
    expect(response.status).toBe(403);
    expect((await response.json()).code).toBe("OTHER_LODGE_NOT_OWNED");
    expect(mocks.update).not.toHaveBeenCalled();
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

  it("writes the rates it was sent, in cents, and only those (#61)", async () => {
    mocks.findUnique.mockResolvedValue(record());
    mocks.update.mockResolvedValue(record({ winterRateAdultCents: 4550, summerRateUnder5Cents: null }));
    const response = await PATCH(
      jsonRequest("PATCH", { winterRateAdultCents: 4550, summerRateUnder5Cents: null, winterRate5To11Cents: 0 }),
      params("ol-1"),
    );
    expect(response.status).toBe(200);
    const [{ data }] = mocks.update.mock.calls[0];
    expect(data).toEqual({ winterRateAdultCents: 4550, summerRateUnder5Cents: null, winterRate5To11Cents: 0 });
    expect((await response.json()).otherLodge).toMatchObject({ winterRateAdultCents: 4550 });
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
    // #75: seasons that would share a day.
    ["overlapping seasons", { winterSeasonStart: "2026-06-01", winterSeasonEnd: "2026-12-15", summerSeasonStart: "2026-12-01" }],
    ["a season end with no start", { summerSeasonEnd: "2027-03-31" }],
    ["a site URL that is not http(s)", { siteUrl: "javascript:alert(1)" }],
    ["a site URL with no scheme", { siteUrl: "lodge.test" }],
    // #55: the central server's stricter rule.
    ["a site URL with a login before the host", { siteUrl: "https://ruapehu.test@evil.test" }],
    ["a site URL with a backslash", { siteUrl: "http:\\\\evil.test" }],
    ["a site URL with a tab", { siteUrl: "https:/\t/evil.test" }],
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
    // #61: rates arrive as integer cents, 0..9999999.
    ["a rate in dollars rather than cents", { winterRateAdultCents: 45.5 }],
    ["a negative rate", { summerRate5To11Cents: -1 }],
    ["a rate over the server's bound", { winterRate12To17Cents: 10_000_000 }],
    ["a rate sent as text", { summerRateAdultCents: "4550" }],
    ["a rate under the server's dollar key", { winterRateAdult: 45.5 }],
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

describe("PATCH /api/admin/other-lodges/[id]: season end dates (#75)", () => {
  it("checks the seasons as the save would leave them: the sent end over the stored starts", async () => {
    mocks.findUnique.mockResolvedValue(
      record({ winterSeasonStart: new Date("2026-06-01T00:00:00.000Z"), summerSeasonStart: new Date("2026-12-01T00:00:00.000Z") }),
    );
    const refused = await PATCH(jsonRequest("PATCH", { winterSeasonEnd: "2026-12-10" }), params("ol-1"));
    expect(refused.status).toBe(400);
    expect((await refused.json()).error).toMatch(/overlap/);
    expect(mocks.update).not.toHaveBeenCalled();

    mocks.update.mockResolvedValue(record());
    const saved = await PATCH(jsonRequest("PATCH", { winterSeasonEnd: "2026-09-30" }), params("ol-1"));
    expect(saved.status).toBe(200);
    expect(mocks.update.mock.calls[0][0].data.winterSeasonEnd).toEqual(new Date("2026-09-30T00:00:00.000Z"));
  });
});

describe("PATCH /api/admin/other-lodges/[id]: rates and dates from the Fees page (#77)", () => {
  const sentRatesAndDates = { winterRateAdultCents: 9900, summerSeasonStart: "2026-12-01", winterSeasonEnd: "2026-09-30" };

  beforeEach(() => {
    mocks.syncOwnOtherLodgesFromFees.mockResolvedValue([]);
    mocks.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => record({ ratesFromFees: true, ...data }));
    mocks.findUniqueOrThrow.mockResolvedValue(record({ ratesFromFees: true, winterRateAdultCents: 5000 }));
  });

  it("while the switch is on, drops the rates and dates sent, saves the rest, then fills from the Fees page", async () => {
    mocks.findUnique.mockResolvedValue(record({ ratesFromFees: true }));
    const response = await PATCH(jsonRequest("PATCH", { ...sentRatesAndDates, bedCapacity: 12 }), params("ol-1"));
    expect(response.status).toBe(200);
    expect(mocks.update.mock.calls[0][0].data).toEqual({ bedCapacity: 12 });
    expect(mocks.syncOwnOtherLodgesFromFees).toHaveBeenCalledWith("lodge saved", "admin-1");
    // The answer is the row as the fill left it, re-read after it.
    const body = await response.json();
    expect(body.otherLodge.winterRateAdultCents).toBe(5000);
    expect(body.otherLodge.ratesFromFees).toBe(true);
  });

  it("does not refuse overlapping dates it is going to ignore", async () => {
    mocks.findUnique.mockResolvedValue(record({ ratesFromFees: true, summerSeasonStart: new Date("2026-12-01T00:00:00.000Z") }));
    const response = await PATCH(jsonRequest("PATCH", { winterSeasonEnd: "2026-12-10" }), params("ol-1"));
    expect(response.status).toBe(200);
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.syncOwnOtherLodgesFromFees).toHaveBeenCalledWith("lodge saved", "admin-1");
  });

  it("passes the administrator to the fill, and says when it could not fill the lodge", async () => {
    mocks.findUnique.mockResolvedValue(record({ ratesFromFees: true }));
    mocks.syncOwnOtherLodgesFromFees.mockResolvedValue([
      { otherLodgeId: "ol-1", name: "Ruapehu Ski Club", problem: "no-local-lodge", changed: false },
    ]);
    const body = await (await PATCH(jsonRequest("PATCH", { bedCapacity: 12 }), params("ol-1"))).json();
    expect(mocks.syncOwnOtherLodgesFromFees).toHaveBeenCalledWith("lodge saved", "admin-1");
    expect(body.otherLodge.feesProblem).toBe("Not filled: not linked.");
  });

  it("records which way the switch went in the edit's audit row", async () => {
    mocks.findUnique.mockResolvedValue(record({ ratesFromFees: true }));
    mocks.update.mockResolvedValue(record({ ratesFromFees: false }));
    await PATCH(jsonRequest("PATCH", { ratesFromFees: false }), params("ol-1"));
    const metadata = JSON.parse(JSON.stringify(mocks.auditLogCreate.mock.calls[0][0]));
    expect(JSON.stringify(metadata)).toContain('"ratesFromFees":{"previous":true,"next":false}');
  });

  it("turning the switch on stores it, ignores the typed rates, and fills from the Fees page", async () => {
    mocks.findUnique.mockResolvedValue(record({ ratesFromFees: false }));
    const response = await PATCH(jsonRequest("PATCH", { ...sentRatesAndDates, ratesFromFees: true }), params("ol-1"));
    expect(response.status).toBe(200);
    expect(mocks.update.mock.calls[0][0].data).toEqual({ ratesFromFees: true });
    expect(mocks.syncOwnOtherLodgesFromFees).toHaveBeenCalledWith("lodge saved", "admin-1");
  });

  it("turning the switch off stores it and saves the typed rates and dates, with no fill", async () => {
    mocks.findUnique.mockResolvedValue(record({ ratesFromFees: true }));
    const response = await PATCH(jsonRequest("PATCH", { ...sentRatesAndDates, ratesFromFees: false }), params("ol-1"));
    expect(response.status).toBe(200);
    expect(mocks.update.mock.calls[0][0].data).toMatchObject({
      ratesFromFees: false,
      winterRateAdultCents: 9900,
      summerSeasonStart: new Date("2026-12-01T00:00:00.000Z"),
      winterSeasonEnd: new Date("2026-09-30T00:00:00.000Z"),
    });
    expect(mocks.syncOwnOtherLodgesFromFees).not.toHaveBeenCalled();
  });

  it("with the switch off and left off, saves typed rates as before and runs no fill", async () => {
    mocks.findUnique.mockResolvedValue(record({ ratesFromFees: false }));
    const response = await PATCH(jsonRequest("PATCH", { winterRateAdultCents: 9900 }), params("ol-1"));
    expect(response.status).toBe(200);
    expect(mocks.update.mock.calls[0][0].data).toEqual({ winterRateAdultCents: 9900 });
    expect(mocks.syncOwnOtherLodgesFromFees).not.toHaveBeenCalled();
  });

  it("refuses a switch that is not true or false", async () => {
    mocks.findUnique.mockResolvedValue(record({ ratesFromFees: true }));
    expect((await PATCH(jsonRequest("PATCH", { ratesFromFees: "yes" }), params("ol-1"))).status).toBe(400);
    expect(mocks.syncOwnOtherLodgesFromFees).not.toHaveBeenCalled();
  });

  it("sends the switch for this club's own lodge only, never another club's", async () => {
    mocks.findMany.mockResolvedValue([record({ ratesFromFees: true }), { ...theirs(), ratesFromFees: true }]);
    const body = await (await GET()).json();
    const [ours, other] = body.otherLodges;
    expect(ours.ratesFromFees).toBe(true);
    expect(other).not.toHaveProperty("ratesFromFees");
  });

  it("tells the editor why the Fees page cannot fill our lodge, and asks about no other", async () => {
    mocks.findMany.mockResolvedValue([record({ ratesFromFees: true }), { ...theirs(), ratesFromFees: true }]);
    mocks.otherLodgeFeesProblem.mockResolvedValue("Not filled: not linked.");
    const [ours, other] = (await (await GET()).json()).otherLodges;
    expect(ours.feesProblem).toBe("Not filled: not linked.");
    expect(other).not.toHaveProperty("feesProblem");
    expect(mocks.otherLodgeFeesProblem).toHaveBeenCalledTimes(1);
  });
});
