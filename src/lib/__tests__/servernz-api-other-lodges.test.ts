import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Mocks ──────────────────────────────────────────────────────────────────

vi.mock("@/lib/servernz-config", () => ({
  getOperationalServerNzApiKey: vi.fn(async () => "test-api-key"),
}));

vi.mock("@/lib/servernz-settings", () => ({
  loadServerNzSettings: vi.fn(async () => ({ baseUrl: "https://central.test" })),
  validateCentralServerBaseUrl: (value: string) => ({ ok: true, value }),
}));

import { OTHER_LODGE_DATA_FIELDS } from "@/lib/other-lodges";
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

/** A valid row as the central server sends it at API version 1.1 and later. */
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
    bookingPath: "Email the booking officer",
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
    summerSeasonStart: "2026-11-15",
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
      summerSeasonStart: "2026-11-15",
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
    ["a booking path over 300 characters", { bookingPath: "b".repeat(301) }],
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

  it("accepts an envelope that also carries keys this client does not read yet", async () => {
    // A later server release adds to the envelope (the owned-lodge list, #52);
    // a pull must not reject the whole page for a key it has no opinion on.
    respondWith({
      lodges: [remoteRow()],
      cursor: "c-3",
      count: 1,
      ownLodgeNames: ["Aorangi Ski Club"],
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
 * `src/lib/other-lodges.ts`, API version 1.1). ONE key outside this set rejects
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
  "bookingPath",
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
  "summerSeasonStart",
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
      bookingPath: null,
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
      summerSeasonStart: null,
      amenities: [],
    };
    expect(Object.keys(item).sort()).toEqual(SERVER_UPLOAD_ITEM_KEYS);
    // And the sync builds its items from the same list, so it cannot add a key
    // this pin does not know.
    expect([...OTHER_LODGE_DATA_FIELDS, "name", "amenities"].sort()).toEqual(
      SERVER_UPLOAD_ITEM_KEYS,
    );
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
      bookingPath: null,
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
      summerSeasonStart: null,
      amenities: [{ name: "Sauna", description: null }],
    };

    await uploadOtherLodges([item]);

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("https://central.test/api/v1/other-lodges");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ lodges: [item] });
  });
});

// ── Pull: the owned list (#52) ─────────────────────────────────────────────

describe("pullOtherLodges — ownLodgeNames (#52)", () => {
  it("carries the owned list the server sent", async () => {
    respondWith({
      lodges: [remoteRow()],
      cursor: "c-1",
      count: 1,
      ownLodgeNames: ["Aorangi Ski Club", "Aorangi Ski Club (annex)"],
    });

    const result = await pullOtherLodges(null);

    expect(result.ownLodgeNames).toEqual(["Aorangi Ski Club", "Aorangi Ski Club (annex)"]);
  });

  it("carries an empty list as an empty list: owning nothing is an answer", async () => {
    respondWith({ lodges: [], cursor: "c-1", count: 0, ownLodgeNames: [] });

    const result = await pullOtherLodges(null);

    expect(result.ownLodgeNames).toEqual([]);
  });

  it("leaves the list `undefined` when the server does not send it, never defaulting to []", async () => {
    // An older server. The sync must be able to tell "not sent" from "none".
    respondWith({ lodges: [], cursor: "c-1", count: 0 });

    const result = await pullOtherLodges(null);

    expect(result.ownLodgeNames).toBeUndefined();
    expect(result).toHaveProperty("ownLodgeNames");
  });

  it.each([
    ["a name over the lodge-name bound", ["x".repeat(121)]],
    ["a name carrying NUL", ["Aorangi\u0000Ski Club"]],
    ["a non-string entry", [42]],
    ["not a list at all", "Aorangi Ski Club"],
    ["more names than the bound", Array.from({ length: 101 }, (_, i) => `Lodge ${i}`)],
  ])("discards an owned list with %s as not sent, and still delivers the rows and the cursor", async (_label, ownLodgeNames) => {
    // The list decides what may be edited and uploaded, so one that breaks its
    // bounds is refused whole — but on its own. Failing the pull for it would
    // stop every club's details merging and leave the cursor behind because of
    // one bad field, so the rows land, the cursor advances, and the sync is
    // told the list was refused and leaves the stored one alone.
    respondWith({ lodges: [remoteRow()], cursor: "c-9", count: 1, ownLodgeNames });

    const result = await pullOtherLodges(null);

    expect(result.lodges).toHaveLength(1);
    expect(result.cursor).toBe("c-9");
    expect(result.ownLodgeNames).toBeUndefined();
    expect(result.ownLodgeNamesRefused).toBe(true);
  });

  it("reports a well-formed or absent list as not refused", async () => {
    respondWith({ lodges: [], cursor: "c-1", count: 0, ownLodgeNames: ["Aorangi Ski Club"] });
    expect((await pullOtherLodges(null)).ownLodgeNamesRefused).toBe(false);
    respondWith({ lodges: [], cursor: "c-1", count: 0 });
    expect((await pullOtherLodges(null)).ownLodgeNamesRefused).toBe(false);
  });
});
