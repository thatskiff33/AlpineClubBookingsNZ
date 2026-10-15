import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Mocks ──────────────────────────────────────────────────────────────────

vi.mock("@/lib/servernz-config", () => ({
  getOperationalServerNzApiKey: vi.fn(async () => "test-api-key"),
}));

vi.mock("@/lib/servernz-settings", () => ({
  loadServerNzSettings: vi.fn(async () => ({ baseUrl: "https://central.test" })),
  validateCentralServerBaseUrl: (value: string) => ({ ok: true, value }),
}));

import { OTHER_LODGE_DATA_FIELDS, OTHER_LODGE_RATE_FIELDS } from "@/lib/other-lodges";
import { SERVER_RATE_WIRE_NAMES } from "@/lib/servernz-rate";
import {
  pullOtherLodges,
  uploadOtherLodges,
  type OtherLodgeUploadItem,
} from "@/lib/servernz-api";

const fetchMock = vi.fn();

function respondWith(body: unknown) {
  fetchMock.mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => body,
  });
}

/** A valid row as the central server sends it at API version 2.1. */
function remoteRow(over: Record<string, unknown> = {}) {
  return {
    id: "srv_1",
    name: "Aorangi Ski Club",
    location: "Whakapapa",
    bookingOfficerName: "Ann Officer",
    bookingOfficerEmail: "bookings@club.test",
    bookingOfficerPhone: "+64 27 422 4115",
    bedCapacity: 24,
    siteUrl: "https://club.test",
    doubleBeds: 4,
    singleBeds: 16,
    minutesWalkToLodge: 20,
    roomType: "DORMITORY",
    skiWorkshopArea: true,
    gamesRoom: false,
    requiresLodgeCustodian: true,
    freeWifi: false,
    quietRoom: true,
    dryingRoom: true,
    sharedKitchen: true,
    wheelchairAccessible: false,
    breakfastIncluded: false,
    lunchIncluded: false,
    dinnerIncluded: true,
    cancellationPeriod: "14 days",
    winterSeasonStart: "2026-06-01",
    winterSeasonEnd: null,
    summerSeasonStart: "2026-11-15",
    summerSeasonEnd: null,
    amenities: [
      { name: "Drying room", description: "Heated, ground floor" },
      { name: "Sauna", description: null },
    ],
    updatedAt: "2026-08-14T00:00:00.000Z",
    ...over,
  };
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── Pull: the remote is held to the local admin's bounds ───────────────────
//
// `distributedLodgeSchema` is the SAME shape the admin routes validate with.
// A row that breaks it is dropped on its own and counted; the pull never aborts.

describe("pullOtherLodges — lodge details and amenities (#50)", () => {
  it("keeps a fully-detailed row intact, dates as the calendar-day string it was sent", async () => {
    respondWith({ lodges: [remoteRow()], cursor: "c-1", count: 1 });

    const result = await pullOtherLodges(null);

    expect(result.dropped).toBe(0);
    expect(result.lodges).toHaveLength(1);
    expect(result.lodges[0]).toMatchObject({
      siteUrl: "https://club.test",
      dinnerIncluded: true,
      winterSeasonStart: "2026-06-01",
      winterSeasonEnd: null,
      summerSeasonStart: "2026-11-15",
      summerSeasonEnd: null,
      amenities: [
        { name: "Drying room", description: "Heated, ground floor" },
        { name: "Sauna", description: null },
      ],
    });
  });

  it("keeps a row from a server that does not send the detail fields, leaving them absent rather than defaulted", async () => {
    // A `1.0`-shaped row: the five original columns only. Absent must survive
    // validation AS absent, so the merge can leave the local values alone; a
    // schema that defaulted the flags to false here would wipe the club's own
    // record on every pull from such a server.
    const oldShape = {
      id: "srv_1",
      name: "Aorangi Ski Club",
      location: "Whakapapa",
      bookingOfficerName: "Ann Officer",
      bookingOfficerEmail: "bookings@club.test",
      bookingOfficerPhone: "+64 27 422 4115",
      bedCapacity: 24,
      updatedAt: "2026-08-14T00:00:00.000Z",
    };
    respondWith({ lodges: [oldShape], cursor: "c-1", count: 1 });

    const result = await pullOtherLodges(null);

    expect(result.dropped).toBe(0);
    const [row] = result.lodges;
    for (const key of [
      "siteUrl",
      "freeWifi",
      "requiresLodgeCustodian",
      "cancellationPeriod",
      "winterSeasonStart",
      "amenities",
    ]) {
      expect(row).not.toHaveProperty(key);
    }
  });

  it.each([
    ["a site URL that is not http(s)", { siteUrl: "ftp://club.test" }],
    ["a site URL that is a bare word", { siteUrl: "club.test" }],
    ["a site URL over 500 characters", { siteUrl: `https://club.test/${"a".repeat(500)}` }],
    ["a negative double-bed count", { doubleBeds: -1 }],
    ["a single-bed count over 100000", { singleBeds: 100_001 }],
    ["a walking time that is not a whole number", { minutesWalkToLodge: 7.5 }],
    ["a walking time sent as a string", { minutesWalkToLodge: "20" }],
    ["a room type the contract does not name", { roomType: "CHALET" }],
    ["a room type in the wrong case", { roomType: "room" }],
    ["a games room that is not a boolean", { gamesRoom: "yes" }],
    ["a cancellation period over 200 characters", { cancellationPeriod: "c".repeat(201) }],
    ["a facility that is not a boolean", { freeWifi: "yes" }],
    ["a season start that is not a real calendar date", { winterSeasonStart: "2026-02-30" }],
    ["a season start carrying a time", { summerSeasonStart: "2026-11-15T00:00:00.000Z" }],
    ["an amenity with an empty name", { amenities: [{ name: "" }] }],
    ["an amenity name over 120 characters", { amenities: [{ name: "n".repeat(121) }] }],
    [
      "an amenity description over 1000 characters",
      { amenities: [{ name: "Sauna", description: "d".repeat(1001) }] },
    ],
    [
      "amenity names unique only by case",
      { amenities: [{ name: "Sauna" }, { name: "SAUNA" }] },
    ],
    [
      "more than fifty amenities",
      { amenities: Array.from({ length: 51 }, (_, i) => ({ name: `A${i}` })) },
    ],
    ["an amenity with a key this client does not know", { amenities: [{ name: "Sauna", id: "x" }] }],
    // PostgreSQL text cannot hold U+0000 (22021). Accepted here it would throw
    // mid-merge, leave the cursor unmoved and re-fail on this row every pull.
    ["a NUL character in the name", { name: "Aorangi\u0000Ski Club" }],
    ["a NUL character in a text field", { bookingOfficerName: "Ann\u0000Officer" }],
    ["a NUL character in an amenity description", { amenities: [{ name: "Sauna", description: "a\u0000b" }] }],
  ])("drops only the row with %s, never the batch", async (_label, bad) => {
    respondWith({
      lodges: [remoteRow(bad), remoteRow({ id: "srv_2", name: "Arlberg Ski Club" })],
      cursor: "c-2",
      count: 2,
    });

    const result = await pullOtherLodges(null);

    expect(result.dropped).toBe(1);
    expect(result.lodges.map((l) => l.name)).toEqual(["Arlberg Ski Club"]);
    // The envelope still counts both and the cursor still advances: one bad row
    // costs that row, not the pull.
    expect(result.count).toBe(2);
    expect(result.cursor).toBe("c-2");
  });

  it("keeps a row still carrying the removed `bookingPath`, without the key", async () => {
    // API 2.1 removed it. The row is otherwise valid, so it must not be
    // dropped, and the key must not survive to the merge or a later upload,
    // where the server's strict item schema would refuse the whole batch.
    respondWith({
      lodges: [remoteRow({ bookingPath: "Email the booking officer" })],
      cursor: "c-1",
      count: 1,
    });

    const result = await pullOtherLodges(null);

    expect(result.dropped).toBe(0);
    expect(result.lodges[0]).not.toHaveProperty("bookingPath");
    expect(result.lodges[0]).toMatchObject({ roomType: "DORMITORY", doubleBeds: 4 });
  });

  it("accepts an envelope that also carries keys this client does not read yet", async () => {
    // A later server release adds to the envelope (as the owned-lodge list,
    // #52, once did); a pull must not reject the whole page for a key it has no
    // opinion on.
    respondWith({
      lodges: [remoteRow()],
      cursor: "c-3",
      count: 1,
      aFieldFromALaterRelease: ["Aorangi Ski Club"],
    });

    const result = await pullOtherLodges(null);

    expect(result.lodges).toHaveLength(1);
    expect(result.dropped).toBe(0);
  });
});

// ── Upload: the payload reaches the endpoint as given ───────────────────────

/**
 * The keys the central server's `.strict()` upload item schema accepts, copied
 * from its contract (`otherLodgeUploadItemSchema` in the server's
 * `src/lib/other-lodges.ts`, API version 2.1, which removed `bookingPath`). ONE
 * key outside this set rejects
 * the WHOLE upload with 400, so the client's item type is pinned to exactly it.
 * This is a deliberate second copy: deriving it from this repository's own field
 * list would prove the client agrees with itself, not with the server.
 */
const SERVER_UPLOAD_ITEM_KEYS = [
  "name",
  "location",
  "bookingOfficerName",
  "bookingOfficerEmail",
  "bookingOfficerPhone",
  "bedCapacity",
  "siteUrl",
  "doubleBeds",
  "singleBeds",
  "minutesWalkToLodge",
  "roomType",
  "skiWorkshopArea",
  "gamesRoom",
  "requiresLodgeCustodian",
  "freeWifi",
  "quietRoom",
  "dryingRoom",
  "sharedKitchen",
  "wheelchairAccessible",
  "breakfastIncluded",
  "lunchIncluded",
  "dinnerIncluded",
  "cancellationPeriod",
  "winterSeasonStart",
  "winterSeasonEnd",
  "summerSeasonStart",
  "summerSeasonEnd",
  // Server API 2.2 (#61): the rates, under the SERVER's names, in dollars.
  "winterRateUnder5",
  "winterRate5To11",
  "winterRate12To17",
  "winterRateAdult",
  "summerRateUnder5",
  "summerRate5To11",
  "summerRate12To17",
  "summerRateAdult",
  "amenities",
].sort();

describe("uploadOtherLodges — payload shape (#50)", () => {
  it("sends exactly the key set the server's strict item schema knows", () => {
    // A complete item of the client's type: every key present, none extra. The
    // type is `SerializedOtherLodgeData & { name; amenities }`, so a field added
    // to the shared list appears here (the object below would fail to compile
    // without it) and this assertion then asks whether the SERVER knows it too.
    const item: OtherLodgeUploadItem = {
      name: "Aorangi Ski Club",
      location: null,
      bookingOfficerName: null,
      bookingOfficerEmail: null,
      bookingOfficerPhone: null,
      bedCapacity: null,
      siteUrl: null,
      doubleBeds: null,
      singleBeds: null,
      minutesWalkToLodge: null,
      roomType: null,
      skiWorkshopArea: false,
      gamesRoom: false,
      requiresLodgeCustodian: false,
      freeWifi: false,
      quietRoom: false,
      dryingRoom: false,
      sharedKitchen: false,
      wheelchairAccessible: false,
      breakfastIncluded: false,
      lunchIncluded: false,
      dinnerIncluded: false,
      cancellationPeriod: null,
      winterSeasonStart: null,
      winterSeasonEnd: null,
      summerSeasonStart: null,
      summerSeasonEnd: null,
      winterRateUnder5: null,
      winterRate5To11: null,
      winterRate12To17: null,
      winterRateAdult: 45.5,
      summerRateUnder5: null,
      summerRate5To11: null,
      summerRate12To17: null,
      summerRateAdult: null,
      amenities: [],
    };
    expect(Object.keys(item).sort()).toEqual(SERVER_UPLOAD_ITEM_KEYS);
    // And the sync builds its items from the same list — every data column,
    // with each `…Cents` rate column renamed to the server's key — so it
    // cannot add a key this pin does not know, nor send a `…Cents` key the
    // server's strict schema would refuse.
    const rateFields: ReadonlyArray<string> = OTHER_LODGE_RATE_FIELDS;
    expect(
      [
        ...OTHER_LODGE_DATA_FIELDS.filter((f) => !rateFields.includes(f)),
        ...OTHER_LODGE_RATE_FIELDS.map((f) => SERVER_RATE_WIRE_NAMES[f]),
        "name",
        "amenities",
      ].sort(),
    ).toEqual(SERVER_UPLOAD_ITEM_KEYS);
  });

  it("posts the lodges as given, under `lodges`, to the other-lodges endpoint", async () => {
    respondWith({ created: 1, updated: 0, unchanged: 0, skipped: 0, results: [] });
    const item = {
      name: "Aorangi Ski Club",
      location: "Whakapapa",
      bookingOfficerName: "Ann Officer",
      bookingOfficerEmail: "bookings@club.test",
      bookingOfficerPhone: "+64 27 422 4115",
      bedCapacity: 24,
      siteUrl: "https://club.test",
      doubleBeds: 4,
      singleBeds: 16,
      minutesWalkToLodge: 20,
      roomType: "ROOM" as const,
      skiWorkshopArea: true,
      gamesRoom: true,
      requiresLodgeCustodian: true,
      freeWifi: false,
      quietRoom: true,
      dryingRoom: true,
      sharedKitchen: true,
      wheelchairAccessible: false,
      breakfastIncluded: false,
      lunchIncluded: false,
      dinnerIncluded: true,
      cancellationPeriod: "14 days",
      winterSeasonStart: "2026-06-01",
      winterSeasonEnd: null,
      summerSeasonStart: null,
      summerSeasonEnd: null,
      winterRateUnder5: null,
      winterRate5To11: 20,
      winterRate12To17: null,
      winterRateAdult: 45.5,
      summerRateUnder5: null,
      summerRate5To11: null,
      summerRate12To17: null,
      summerRateAdult: null,
      amenities: [{ name: "Sauna", description: null }],
    };

    await uploadOtherLodges([item]);

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("https://central.test/api/v1/other-lodges");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ lodges: [item] });
  });
});

// ── Pull: the non-member rates (#61) ───────────────────────────────────────

describe("pullOtherLodges — non-member rates (#61, server API 2.2)", () => {
  it("takes the server's dollars and hands the merge cents under this site's column names", async () => {
    respondWith({
      lodges: [remoteRow({ winterRateAdult: 45.5, winterRate5To11: 20, summerRateUnder5: 0, summerRateAdult: null })],
      cursor: "c-1",
      count: 1,
    });

    const result = await pullOtherLodges(null);

    expect(result.dropped).toBe(0);
    const [row] = result.lodges;
    expect(row).toMatchObject({
      winterRateAdultCents: 4550,
      winterRate5To11Cents: 2000,
      summerRateUnder5Cents: 0,
      summerRateAdultCents: null,
    });
    // No dollar value survives the boundary, under either name.
    expect(row).not.toHaveProperty("winterRateAdult");
    expect(row).not.toHaveProperty("summerRateAdult");
  });

  it("leaves a rate the server did not send ABSENT, so the merge keeps the stored one", async () => {
    respondWith({ lodges: [remoteRow({ winterRateAdult: 45.5 })], cursor: "c-1", count: 1 });

    const [row] = (await pullOtherLodges(null)).lodges;

    expect(row).toHaveProperty("winterRateAdultCents", 4550);
    expect(row).not.toHaveProperty("summerRateAdultCents");
    expect(row).not.toHaveProperty("winterRateUnder5Cents");
  });

  it("does not take a cents key from the server: only this site writes those", async () => {
    respondWith({ lodges: [remoteRow({ winterRateAdultCents: 1 })], cursor: "c-1", count: 1 });

    const [row] = (await pullOtherLodges(null)).lodges;

    expect(row).not.toHaveProperty("winterRateAdultCents");
  });

  it.each([
    ["three decimal places", { winterRateAdult: 45.555 }],
    ["a negative rate", { summerRate5To11: -1 }],
    ["a rate over 99999.99", { winterRate12To17: 100000 }],
    ["a rate sent as a string", { summerRateAdult: "45.50" }],
  ])("drops a row with %s and keeps the others, never aborting the pull", async (_label, bad) => {
    respondWith({
      lodges: [remoteRow(bad), remoteRow({ id: "srv_2", name: "Ruapehu Hut", winterRateAdult: 30 })],
      cursor: "c-1",
      count: 2,
    });

    const result = await pullOtherLodges(null);

    expect(result.dropped).toBe(1);
    expect(result.lodges.map((l) => l.name)).toEqual(["Ruapehu Hut"]);
  });
});

// ── Pull: the owned list (#52) ─────────────────────────────────────────────

describe("pullOtherLodges — ownLodges, the owned lodges with their ids (#52, #62, #69)", () => {
  it("carries the owned lodges with their permanent ids", async () => {
    respondWith({
      lodges: [],
      cursor: "c-1",
      count: 0,
      ownLodges: [{ id: "ol_a", name: "Aorangi Ski Club" }],
    });

    const result = await pullOtherLodges(null);

    expect(result.ownLodges).toEqual([{ id: "ol_a", name: "Aorangi Ski Club" }]);
    expect(result.ownLodgesRefused).toBe(false);
  });

  it("carries two owned lodges of the same name: the ids tell them apart (#69)", async () => {
    const ownLodges = [
      { id: "ol_a", name: "Ruapehu Lodge" },
      { id: "ol_b", name: "Ruapehu Lodge" },
    ];
    respondWith({ lodges: [], cursor: "c-1", count: 0, ownLodges });

    expect((await pullOtherLodges(null)).ownLodges).toEqual(ownLodges);
  });

  it("carries an empty list as an empty list: owning nothing is an answer", async () => {
    respondWith({ lodges: [], cursor: "c-1", count: 0, ownLodges: [] });

    expect((await pullOtherLodges(null)).ownLodges).toEqual([]);
  });

  it("leaves ownLodges `undefined` when the server does not send it, never defaulting to []", async () => {
    respondWith({ lodges: [], cursor: "c-1", count: 0 });

    const result = await pullOtherLodges(null);

    expect(result.ownLodges).toBeUndefined();
    expect(result).toHaveProperty("ownLodges");
    expect(result.ownLodgesRefused).toBe(false);
  });

  it("no longer reads the name-only list a 2.4 server sent (#69)", async () => {
    respondWith({ lodges: [], cursor: "c-1", count: 0, ownLodgeNames: ["Aorangi Ski Club"] });

    const result = await pullOtherLodges(null);

    expect(result.ownLodges).toBeUndefined();
    expect(result).not.toHaveProperty("ownLodgeNames");
  });

  it.each([
    ["an empty id", [{ id: "", name: "Aorangi Ski Club" }]],
    ["an id over 64 characters", [{ id: "x".repeat(65), name: "Aorangi Ski Club" }]],
    ["the same id twice", [{ id: "ol_a", name: "A" }, { id: "ol_a", name: "B" }]],
    ["a name over the lodge-name bound", [{ id: "ol_a", name: "x".repeat(121) }]],
    ["a name carrying NUL", [{ id: "ol_a", name: "Aorangi\u0000Ski Club" }]],
    ["more lodges than the bound", Array.from({ length: 101 }, (_, i) => ({ id: `ol_${i}`, name: `Lodge ${i}` }))],
    ["a list that is not a list", "ol_a"],
  ])("refuses %s on its own, and still delivers the rows and the cursor", async (_label, ownLodges) => {
    // The list decides what may be edited and uploaded, so one that breaks its
    // bounds is refused whole — but on its own. Failing the pull for it would
    // stop every club's details merging and leave the cursor behind because of
    // one bad field, so the rows land, the cursor advances, and the sync is
    // told the list was refused and leaves the stored one alone.
    respondWith({ lodges: [remoteRow()], cursor: "c-9", count: 1, ownLodges });

    const result = await pullOtherLodges(null);

    expect(result.ownLodges).toBeUndefined();
    expect(result.ownLodgesRefused).toBe(true);
    expect(result.lodges).toHaveLength(1);
    expect(result.cursor).toBe("c-9");
  });
});

describe("pullOtherLodges — deletedLodges, lodges deleted on the server (#58, API 2.4)", () => {
  it("carries the deleted lodges' central ids, in the order sent", async () => {
    respondWith({
      lodges: [],
      cursor: "c-1",
      count: 0,
      deletedLodges: [
        { id: "gone_a", deletedAt: "2026-10-01T00:00:00.000Z" },
        { id: "gone_b", deletedAt: "2026-10-02T00:00:00.000Z" },
      ],
    });

    expect((await pullOtherLodges(null)).deletedLodgeIds).toEqual(["gone_a", "gone_b"]);
  });

  it("leaves deletedLodgeIds `undefined` when an older server does not send the list", async () => {
    respondWith({ lodges: [], cursor: "c-1", count: 0 });

    expect((await pullOtherLodges(null)).deletedLodgeIds).toBeUndefined();
  });

  it.each([
    ["an empty id", { id: "", deletedAt: "2026-10-01T00:00:00.000Z" }],
    ["a padded id", { id: " gone_a", deletedAt: "2026-10-01T00:00:00.000Z" }],
    ["an over-long id", { id: "x".repeat(65), deletedAt: "2026-10-01T00:00:00.000Z" }],
    ["no id", { deletedAt: "2026-10-01T00:00:00.000Z" }],
  ])("drops one entry with %s and keeps the rest", async (_label, bad) => {
    respondWith({
      lodges: [],
      cursor: "c-1",
      count: 0,
      deletedLodges: [bad, { id: "gone_b", deletedAt: "2026-10-02T00:00:00.000Z" }],
    });

    expect((await pullOtherLodges(null)).deletedLodgeIds).toEqual(["gone_b"]);
  });

  it("fails the whole pull on an over-long list, so the cursor does not move past deletions it never applied", async () => {
    respondWith({
      lodges: [],
      cursor: "c-1",
      count: 0,
      deletedLodges: Array.from({ length: 100_001 }, (_, i) => ({ id: `g${i}`, deletedAt: "2026-10-01T00:00:00.000Z" })),
    });

    await expect(pullOtherLodges(null)).rejects.toThrow();
  });
});
