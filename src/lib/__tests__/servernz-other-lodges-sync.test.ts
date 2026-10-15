import { describe, it, expect, vi, beforeEach } from "vitest";
import { Prisma } from "@prisma/client";

// ── Mocks ──────────────────────────────────────────────────────────────────

const mockFindMany = vi.fn();
const mockFindUnique = vi.fn();
// The merge's lookup by NAME (#69: names may repeat, so it reads every row of
// the name). By default answered from `mockFindUnique`'s one row for the name.
const mockFindByName = vi.fn();
const mockExecuteRaw = vi.fn();
const mockSettingsRow = vi.fn();
const mockCreate = vi.fn();
const mockAuditCreate = vi.fn();
const mockUpdateMany = vi.fn();
const mockDeleteMany = vi.fn();
const mockAmenityDeleteMany = vi.fn();
const mockAmenityUpsert = vi.fn();

vi.mock("@/lib/prisma", () => {
  // The interactive transaction hands the same fake back as `tx`, so a write
  // made inside one is observable through the same mocks as one made outside.
  const prisma = {
    otherLodge: {
      findMany: (args: { where?: { name?: unknown } }) =>
        typeof args?.where?.name === "string" ? mockFindByName(args) : mockFindMany(args),
      findUnique: (...args: unknown[]) => mockFindUnique(...args),
      create: (...args: unknown[]) => mockCreate(...args),
      // A lookup by name (#58) is a findFirst among visible lodges; the same
      // fake answers both, and the registry below honours `hiddenAt`.
      findFirst: (...args: unknown[]) => mockFindUnique(...args),
      updateMany: (...args: unknown[]) => mockUpdateMany(...args),
      deleteMany: (...args: unknown[]) => mockDeleteMany(...args),
    },
    amenity: {
      deleteMany: (...args: unknown[]) => mockAmenityDeleteMany(...args),
      upsert: (...args: unknown[]) => mockAmenityUpsert(...args),
    },
    $transaction: (fn: (tx: unknown) => Promise<unknown>) => fn(prisma),
    $executeRaw: (...args: unknown[]) => mockExecuteRaw(...args),
    // The record step re-reads the address under the settings lock (#64).
    serverNzSettings: { findUnique: (...args: unknown[]) => mockSettingsRow(...args) },
  };
  return { prisma };
});

const mockUploadOtherLodges = vi.fn();
const mockPullOtherLodges = vi.fn();

vi.mock("@/lib/servernz-api", () => ({
  // A 2.5 server answers every item with its lodge's id; a fixture that leaves
  // the id out gets the item's own, so only a test about a WRONG id sets one.
  uploadOtherLodges: async (items: Array<{ id?: string }>) => {
    const answer = await mockUploadOtherLodges(items);
    if (!answer?.results) return answer;
    return {
      ...answer,
      results: answer.results.map((r: { id?: unknown }, i: number) =>
        "id" in r ? r : { ...r, ...(items[i]?.id ? { id: items[i].id } : {}) },
      ),
    };
  },
  pullOtherLodges: (...args: unknown[]) => mockPullOtherLodges(...args),
}));

const mockKeyStamp = vi.fn();
vi.mock("@/lib/servernz-config", () => ({
  readServerNzApiKeyStamp: (...args: unknown[]) => mockKeyStamp(...args),
}));

const mockLoggerWarn = vi.fn();

vi.mock("@/lib/audit", () => ({
  createAuditLog: (...args: unknown[]) => mockAuditCreate(...args),
}));

vi.mock("@/lib/logger", () => ({
  default: {
    warn: (...args: unknown[]) => mockLoggerWarn(...args),
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
}));

const mockLoadSettings = vi.fn();
const mockRecordUpload = vi.fn();
const mockRecordDownload = vi.fn();
// The record step's options (#64: the keyed marker and the transaction client)
// land here, so the cursor-and-owned-list assertions above them stay exact.
const mockRecordOptions = vi.fn();
const mockLockSettings = vi.fn();

vi.mock("@/lib/servernz-settings", () => ({
  SERVERNZ_SETTINGS_ID: "default",
  loadServerNzSettings: (...args: unknown[]) => mockLoadSettings(...args),
  recordOtherLodgesUpload: (...args: unknown[]) => mockRecordUpload(...args),
  recordOtherLodgesDownload: (cursor: unknown, lodges: unknown, options: unknown) => {
    mockRecordOptions(options);
    return mockRecordDownload(cursor, lodges);
  },
  lockServerNzSettings: (...args: unknown[]) => mockLockSettings(...args),
}));

import {
  uploadOtherClubsToServer,
  downloadOtherClubsFromServer,
} from "@/lib/servernz-other-lodges-sync";

// ── Fixtures ───────────────────────────────────────────────────────────────

const SETTINGS = {
  baseUrl: "https://central.test",
  otherLodgesEnabled: true,
  otherLodgesLastUploadAt: null as string | null,
  otherLodgesLastDownloadAt: null as string | null,
  otherLodgesCursor: null as string | null,
  // Unknown until a download records it (#52); by central id (#62, #69).
  otherLodgesOwnedLodges: null as Array<{ id: string; name: string }> | null,
  otherLodgesOwnedLodgesUnreadable: false,
  // Keyed already (#64), so downloads are incremental unless a test says not.
  otherLodgesKeyedAt: "2026-08-01T00:00:00.000Z" as string | null,
};

/** The owned list as the pull carries it (#69: by id): each name under `id:<name>`. */
const owns = (...names: string[]) => names.map((name) => ({ id: `id:${name}`, name }));

/**
 * Upload fixtures (#69): only rows keyed by an OWNED central id go up. Keys
 * each row (`c:<row id>` unless it has one) and adds the ids to the owned list,
 * on top of whatever settings the test set before.
 */
function ownAll<T extends { id: string; name: string; centralId?: string | null }>(rows: T[]) {
  const keyed = rows.map((r) => ({ ...r, centralId: r.centralId ?? `c:${r.id}` }));
  const before = mockLoadSettings.getMockImplementation();
  mockLoadSettings.mockImplementation(async () => ({
    ...(before ? await before() : SETTINGS),
    otherLodgesOwnedLodges: keyed.map((r) => ({ id: r.centralId, name: r.name })),
  }));
  return keyed;
}

/** A row as the central server sends it. */
const REMOTE_UPDATED_AT = "2026-08-14T00:00:00.000Z";

/** The #50 and API 2.1 detail fields as they travel: dates as `YYYY-MM-DD`, no amenities. */
const WIRE_DETAILS = {
  siteUrl: "https://club.test",
  doubleBeds: 4,
  singleBeds: 16,
  minutesWalkToLodge: 20,
  roomType: "DORMITORY" as const,
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
  summerSeasonStart: "2026-11-15",
};

/**
 * The rates (#61) as this site holds them — integer cents under the `…Cents`
 * columns — which is also what the pull hands the merge, because the wire
 * schema converts at the boundary. `RATES_DOLLARS` is the same set as the
 * upload sends it: the server's keys, in dollars.
 */
const RATES_CENTS = {
  winterRateUnder5Cents: null,
  winterRate5To11Cents: 2000,
  winterRate12To17Cents: 3010,
  winterRateAdultCents: 4550,
  summerRateUnder5Cents: null,
  summerRate5To11Cents: null,
  summerRate12To17Cents: null,
  summerRateAdultCents: 0,
};
const RATES_DOLLARS = {
  winterRateUnder5: null,
  winterRate5To11: 20,
  winterRate12To17: 30.1,
  winterRateAdult: 45.5,
  summerRateUnder5: null,
  summerRate5To11: null,
  summerRate12To17: null,
  summerRateAdult: 0,
};

/** The same details as Prisma reads them: `@db.Date` columns as UTC midnight. */
const LOCAL_DETAILS = {
  ...WIRE_DETAILS,
  ...RATES_CENTS,
  winterSeasonStart: new Date("2026-06-01T00:00:00.000Z"),
  summerSeasonStart: new Date("2026-11-15T00:00:00.000Z"),
};

const AMENITIES = [
  { name: "Drying room", description: "Heated, ground floor" },
  { name: "Sauna", description: null },
];

/** A local row identical to `remoteLodge()`, as Prisma reads it back. */
function localCopyOf(id: string, updatedAt: string) {
  return {
    id,
    updatedAt: new Date(updatedAt),
    location: "Whakapapa",
    bookingOfficerName: "Ann Officer",
    bookingOfficerEmail: "bookings@club.test",
    bookingOfficerPhone: "+64 27 422 4115",
    bedCapacity: 24,
    ...LOCAL_DETAILS,
    amenities: AMENITIES,
  };
}

function remoteLodge(name: string, over: Record<string, unknown> = {}) {
  return {
    name,
    updatedAt: REMOTE_UPDATED_AT,
    location: "Whakapapa",
    bookingOfficerName: "Ann Officer",
    bookingOfficerEmail: "bookings@club.test",
    bookingOfficerPhone: "+64 27 422 4115",
    bedCapacity: 24,
    ...WIRE_DETAILS,
    ...RATES_CENTS,
    amenities: AMENITIES,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockFindByName.mockImplementation(async (args: unknown) => {
    const row = await mockFindUnique(args);
    return row ? [row] : [];
  });
  mockLoadSettings.mockResolvedValue({ ...SETTINGS });
  mockCreate.mockResolvedValue({ id: "ol_new" });
  mockAuditCreate.mockResolvedValue(undefined);
  mockLockSettings.mockResolvedValue(undefined);
  // Under the lock, the row reads back as this download loaded it, unless a
  // test says another writer got there first.
  mockSettingsRow.mockImplementation(async () => {
    const loaded = await mockLoadSettings();
    return {
      baseUrl: loaded.baseUrl,
      otherLodgesCursor: loaded.otherLodgesCursor,
      otherLodgesKeyedAt: loaded.otherLodgesKeyedAt ? new Date(loaded.otherLodgesKeyedAt) : null,
    };
  });
  mockKeyStamp.mockResolvedValue("2026-10-01T00:00:00.000Z");
  mockExecuteRaw.mockResolvedValue(0);
  mockUpdateMany.mockResolvedValue({ count: 1 });
  mockAmenityDeleteMany.mockResolvedValue({ count: 0 });
  mockAmenityUpsert.mockResolvedValue({});
  mockRecordUpload.mockResolvedValue(undefined);
  mockRecordDownload.mockResolvedValue(undefined);
});

// ── Upload ─────────────────────────────────────────────────────────────────

describe("uploadOtherClubsToServer", () => {
  it("sends nothing and leaves the watermark alone when no row changed", async () => {
    mockFindMany.mockResolvedValue([]);

    const result = await uploadOtherClubsToServer();

    expect(mockUploadOtherLodges).not.toHaveBeenCalled();
    // A quiet day must not advance the watermark — doing so would skip a row
    // edited between this read and the next run.
    expect(mockRecordUpload).not.toHaveBeenCalled();
    expect(result.sent).toBe(0);
  });

  it("sends only rows changed since the watermark and advances it to the newest updatedAt", async () => {
    const older = new Date("2026-08-01T00:00:00.000Z");
    const newer = new Date("2026-08-14T00:00:00.000Z");
    mockLoadSettings.mockResolvedValue({
      ...SETTINGS,
      otherLodgesLastUploadAt: "2026-07-01T00:00:00.000Z",
    });
    mockFindMany.mockResolvedValue(
      ownAll([
        { ...localCopyOf("ol_1", older.toISOString()), name: "Aorangi Ski Club" },
        { ...localCopyOf("ol_2", newer.toISOString()), name: "Arlberg Ski Club" },
      ]),
    );
    mockUploadOtherLodges.mockResolvedValue({
      created: 0,
      updated: 2,
      unchanged: 0,
      skipped: 0,
      // One answer per item, in the order sent (#69).
      results: [
        { name: "Aorangi Ski Club", status: "updated" },
        { name: "Arlberg Ski Club", status: "updated" },
      ],
    });

    const result = await uploadOtherClubsToServer();

    // Incremental: the query is bounded by the stored watermark, not the whole table.
    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { hiddenAt: null, updatedAt: { gt: new Date("2026-07-01T00:00:00.000Z") } },
      }),
    );
    expect(result.sent).toBe(2);
    // The watermark advances to the newest row actually sent, on the database's
    // own clock — never to wall-clock now(), which could outrun an uncommitted edit.
    expect(mockRecordUpload).toHaveBeenCalledWith(newer);
  });
});

// ── Download ───────────────────────────────────────────────────────────────

describe("downloadOtherClubsFromServer", () => {
  it("passes the stored cursor up and records the one the server returns", async () => {
    mockLoadSettings.mockResolvedValue({ ...SETTINGS, otherLodgesCursor: "c-100" });
    mockPullOtherLodges.mockResolvedValue({ lodges: [], count: 0, cursor: "c-200", dropped: 0 });

    const result = await downloadOtherClubsFromServer();

    expect(mockPullOtherLodges).toHaveBeenCalledWith("c-100");
    expect(mockRecordDownload).toHaveBeenCalledWith("c-200", undefined);
    expect(result).toEqual({
      fetched: 0,
      created: 0,
      updated: 0,
      unchanged: 0,
      keptLocal: 0,
      renamed: 0,
      nameConflicts: [],
      hiddenLodges: [],
      dropped: 0,
    });
  });

  it("creates a row it has not seen, with its amenities in the same transaction", async () => {
    // The read-then-write is not atomic; a concurrent writer that creates the
    // same visible name in the gap makes this create fail its unique index, and
    // the lodge is retried after the rest of the pull (tested below).
    mockPullOtherLodges.mockResolvedValue({
      lodges: [remoteLodge("Ngauruhoe Ski Club")],
      count: 1,
      cursor: "c-201",
      dropped: 0,
    });
    mockFindUnique.mockResolvedValue(null);

    const result = await downloadOtherClubsFromServer();

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ name: "Ngauruhoe Ski Club", bedCapacity: 24 }),
      }),
    );
    // The amenity set rides in the same transaction, keyed on the new id.
    expect(mockAmenityUpsert).toHaveBeenCalledTimes(AMENITIES.length);
    expect(mockAmenityUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { otherLodgeId_name: { otherLodgeId: "ol_new", name: "Sauna" } },
      }),
    );
    expect(result.created).toBe(1);
  });

  it("writes a row whose data differs", async () => {
    mockPullOtherLodges.mockResolvedValue({
      lodges: [remoteLodge("Aorangi Ski Club", { bedCapacity: 30 })],
      count: 1,
      cursor: "c-202",
      dropped: 0,
    });
    mockFindUnique.mockResolvedValue(localCopyOf("ol_1", "2026-08-01T00:00:00.000Z"));

    const result = await downloadOtherClubsFromServer();

    expect(mockUpdateMany).toHaveBeenCalledWith({
      where: { id: "ol_1", updatedAt: new Date("2026-08-01T00:00:00.000Z"), hiddenAt: null },
      data: expect.objectContaining({ bedCapacity: 30 }),
    });
    expect(result).toMatchObject({ created: 0, updated: 1, unchanged: 0 });
  });

  it("leaves an identical row untouched so updatedAt is not bumped and it is not re-uploaded", async () => {
    mockPullOtherLodges.mockResolvedValue({
      lodges: [remoteLodge("Arlberg Ski Club")],
      count: 1,
      cursor: "c-203",
      dropped: 0,
    });
    mockFindUnique.mockResolvedValue(localCopyOf("ol_2", "2026-08-01T00:00:00.000Z"));

    const result = await downloadOtherClubsFromServer();

    expect(mockUpdateMany).not.toHaveBeenCalled();
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockAmenityDeleteMany).not.toHaveBeenCalled();
    expect(mockAmenityUpsert).not.toHaveBeenCalled();
    expect(result).toMatchObject({ created: 0, updated: 0, unchanged: 1 });
  });
});

// ── Lodge details and amenities (#50) ──────────────────────────────────────

describe("lodge details and amenities round trip", () => {
  it("uploads every data column, dates as YYYY-MM-DD, and the whole amenity list — and nothing else", async () => {
    // The server's upload item schema is `.strict()`: one key it does not know
    // rejects the whole payload, so the projection is pinned exactly.
    mockFindMany.mockResolvedValue(
      ownAll([{ ...localCopyOf("ol_1", "2026-08-14T00:00:00.000Z"), name: "Aorangi Ski Club" }]),
    );
    mockUploadOtherLodges.mockResolvedValue({
      created: 0,
      updated: 1,
      unchanged: 0,
      skipped: 0,
      results: [{ name: "Aorangi Ski Club", status: "updated" }],
    });

    await uploadOtherClubsToServer();

    expect(mockUploadOtherLodges).toHaveBeenCalledWith([
      {
        id: "c:ol_1",
        name: "Aorangi Ski Club",
        location: "Whakapapa",
        bookingOfficerName: "Ann Officer",
        bookingOfficerEmail: "bookings@club.test",
        bookingOfficerPhone: "+64 27 422 4115",
        bedCapacity: 24,
        ...WIRE_DETAILS,
        // The rates leave as the server's dollar keys; no `…Cents` key goes up.
        ...RATES_DOLLARS,
        amenities: AMENITIES,
      },
    ]);
    // The read asked for the amenities alongside the columns — the one list.
    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({
          siteUrl: true,
          winterSeasonStart: true,
          amenities: expect.objectContaining({ select: { name: true, description: true } }),
        }),
      }),
    );
  });

  it("applies a downloaded row's details and amenities, storing dates as the calendar day without a shift", async () => {
    mockPullOtherLodges.mockResolvedValue({
      lodges: [remoteLodge("Aorangi Ski Club")],
      count: 1,
      cursor: "c-400",
      dropped: 0,
    });
    // A legacy row: defaults everywhere and no amenities yet.
    mockFindUnique.mockResolvedValue({
      ...localCopyOf("ol_1", "2026-08-01T00:00:00.000Z"),
      siteUrl: null,
      doubleBeds: null,
      singleBeds: null,
      minutesWalkToLodge: null,
      roomType: null,
      skiWorkshopArea: false,
      requiresLodgeCustodian: false,
      quietRoom: false,
      dryingRoom: false,
      sharedKitchen: false,
      dinnerIncluded: false,
      cancellationPeriod: null,
      winterSeasonStart: null,
      summerSeasonStart: null,
      amenities: [],
    });

    const result = await downloadOtherClubsFromServer();

    expect(mockUpdateMany).toHaveBeenCalledWith({
      where: { id: "ol_1", updatedAt: new Date("2026-08-01T00:00:00.000Z"), hiddenAt: null },
      data: expect.objectContaining({
        ...LOCAL_DETAILS,
        updatedAt: new Date(REMOTE_UPDATED_AT),
      }),
    });
    // Nothing left to delete, two to create, keyed on the unique (lodge, name).
    expect(mockAmenityDeleteMany).toHaveBeenCalledWith({
      where: { otherLodgeId: "ol_1", name: { notIn: ["Drying room", "Sauna"] } },
    });
    expect(mockAmenityUpsert).toHaveBeenCalledWith({
      where: { otherLodgeId_name: { otherLodgeId: "ol_1", name: "Drying room" } },
      create: { otherLodgeId: "ol_1", name: "Drying room", description: "Heated, ground floor" },
      update: { description: "Heated, ground floor" },
    });
    expect(result).toMatchObject({ updated: 1, unchanged: 0 });
  });

  it("treats an amenity-only server change as a change, and stamps the row with the server's updatedAt", async () => {
    // Otherwise the new amenities land, the lodge row keeps its old timestamp,
    // and the next upload re-presents the row as this club's edit (an echo).
    mockPullOtherLodges.mockResolvedValue({
      lodges: [
        remoteLodge("Aorangi Ski Club", {
          amenities: [...AMENITIES, { name: "Boot room", description: null }],
        }),
      ],
      count: 1,
      cursor: "c-401",
      dropped: 0,
    });
    mockFindUnique.mockResolvedValue(localCopyOf("ol_1", "2026-08-01T00:00:00.000Z"));

    const result = await downloadOtherClubsFromServer();

    expect(mockAmenityUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { otherLodgeId_name: { otherLodgeId: "ol_1", name: "Boot room" } },
      }),
    );
    expect(mockUpdateMany).toHaveBeenCalledWith({
      where: { id: "ol_1", updatedAt: new Date("2026-08-01T00:00:00.000Z"), hiddenAt: null },
      data: expect.objectContaining({ updatedAt: new Date(REMOTE_UPDATED_AT) }),
    });
    expect(result).toMatchObject({ updated: 1, unchanged: 0, keptLocal: 0 });
  });

  it("removes amenities the server no longer lists, by name", async () => {
    mockPullOtherLodges.mockResolvedValue({
      lodges: [remoteLodge("Aorangi Ski Club", { amenities: [AMENITIES[0]] })],
      count: 1,
      cursor: "c-402",
      dropped: 0,
    });
    mockFindUnique.mockResolvedValue(localCopyOf("ol_1", "2026-08-01T00:00:00.000Z"));

    await downloadOtherClubsFromServer();

    expect(mockAmenityDeleteMany).toHaveBeenCalledWith({
      where: { otherLodgeId: "ol_1", name: { notIn: ["Drying room"] } },
    });
    expect(mockAmenityUpsert).toHaveBeenCalledTimes(1);
  });

  it("keeps a local edit that lands between the read and the write, and writes no amenities", async () => {
    // Rule 2 was decided on `existing.updatedAt`, read OUTSIDE the transaction.
    // An admin saving the same lodge in that gap moves the row's timestamp, so
    // the guarded updateMany matches nothing. An unguarded update would have
    // overwritten the admin's edit AND stamped the row with the server's older
    // timestamp — below the upload watermark, so the edit would never be sent.
    mockPullOtherLodges.mockResolvedValue({
      lodges: [
        remoteLodge("Aorangi Ski Club", {
          bedCapacity: 30,
          amenities: [{ name: "Boot room", description: null }],
        }),
      ],
      count: 1,
      cursor: "c-406",
      dropped: 0,
    });
    mockFindUnique.mockResolvedValue(localCopyOf("ol_1", "2026-08-01T00:00:00.000Z"));
    mockUpdateMany.mockResolvedValue({ count: 0 });

    const result = await downloadOtherClubsFromServer();

    // The write was attempted, guarded on the timestamp we read...
    expect(mockUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "ol_1", updatedAt: new Date("2026-08-01T00:00:00.000Z"), hiddenAt: null },
      }),
    );
    // ...and the miss is the local edit winning: nothing else is written.
    expect(mockAmenityDeleteMany).not.toHaveBeenCalled();
    expect(mockAmenityUpsert).not.toHaveBeenCalled();
    expect(result).toMatchObject({ updated: 0, keptLocal: 1 });
    // The cursor still advances: the row was handled, not failed.
    expect(mockRecordDownload).toHaveBeenCalledWith("c-406", undefined);
  });

  it("writes the lodge row before its amenities, so the row lock orders concurrent replacements", async () => {
    mockPullOtherLodges.mockResolvedValue({
      lodges: [remoteLodge("Aorangi Ski Club", { amenities: [AMENITIES[0]] })],
      count: 1,
      cursor: "c-407",
      dropped: 0,
    });
    mockFindUnique.mockResolvedValue(localCopyOf("ol_1", "2026-08-01T00:00:00.000Z"));

    await downloadOtherClubsFromServer();

    const rowWrite = mockUpdateMany.mock.invocationCallOrder[0];
    expect(rowWrite).toBeLessThan(mockAmenityDeleteMany.mock.invocationCallOrder[0]);
    expect(rowWrite).toBeLessThan(mockAmenityUpsert.mock.invocationCallOrder[0]);
  });

  it("keeps a newer local copy even when only the amenities differ", async () => {
    mockPullOtherLodges.mockResolvedValue({
      lodges: [remoteLodge("Aorangi Ski Club", { amenities: [] })],
      count: 1,
      cursor: "c-403",
      dropped: 0,
    });
    mockFindUnique.mockResolvedValue(localCopyOf("ol_1", "2026-08-20T00:00:00.000Z"));

    const result = await downloadOtherClubsFromServer();

    expect(mockUpdateMany).not.toHaveBeenCalled();
    expect(mockAmenityDeleteMany).not.toHaveBeenCalled();
    expect(result).toMatchObject({ updated: 0, keptLocal: 1 });
  });

  it("leaves the local details and amenities alone when the server does not send them", async () => {
    // A server that has not yet gained these fields omits them. Absent must
    // mean "no opinion" — never "set every flag to no and clear the text" —
    // or every pull from such a server would wipe what the club recorded.
    const sentOnlyTheOldFields = {
      name: "Aorangi Ski Club",
      updatedAt: REMOTE_UPDATED_AT,
      location: "Whakapapa",
      bookingOfficerName: "Ann Officer",
      bookingOfficerEmail: "bookings@club.test",
      bookingOfficerPhone: "+64 27 422 4115",
      bedCapacity: 30,
    };
    mockPullOtherLodges.mockResolvedValue({
      lodges: [sentOnlyTheOldFields],
      count: 1,
      cursor: "c-404",
      dropped: 0,
    });
    mockFindUnique.mockResolvedValue(localCopyOf("ol_1", "2026-08-01T00:00:00.000Z"));

    const result = await downloadOtherClubsFromServer();

    const [{ data }] = mockUpdateMany.mock.calls[0];
    expect(data).toMatchObject({ bedCapacity: 30 });
    for (const key of Object.keys(WIRE_DETAILS)) expect(data).not.toHaveProperty(key);
    expect(mockAmenityDeleteMany).not.toHaveBeenCalled();
    expect(mockAmenityUpsert).not.toHaveBeenCalled();
    expect(result).toMatchObject({ updated: 1 });
  });

  it("does not count an identical date as a change because it arrived as a string", async () => {
    // A `@db.Date` reads back as a UTC-midnight Date; the wire carries the same
    // day as text. The comparison must be between calendar days, or every
    // pull would rewrite every dated row and bump nothing but churn.
    mockPullOtherLodges.mockResolvedValue({
      lodges: [remoteLodge("Aorangi Ski Club")],
      count: 1,
      cursor: "c-405",
      dropped: 0,
    });
    mockFindUnique.mockResolvedValue(localCopyOf("ol_1", "2026-08-01T00:00:00.000Z"));

    const result = await downloadOtherClubsFromServer();

    expect(mockUpdateMany).not.toHaveBeenCalled();
    expect(result).toMatchObject({ unchanged: 1 });
  });

  it("writes a changed rate in cents (#61)", async () => {
    mockPullOtherLodges.mockResolvedValue({
      lodges: [remoteLodge("Aorangi Ski Club", { winterRateAdultCents: 4800, summerRateAdultCents: null })],
      count: 1,
      cursor: "c-406",
      dropped: 0,
    });
    mockFindUnique.mockResolvedValue(localCopyOf("ol_1", "2026-08-01T00:00:00.000Z"));

    const result = await downloadOtherClubsFromServer();

    expect(mockUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ winterRateAdultCents: 4800, summerRateAdultCents: null }),
      }),
    );
    expect(result).toMatchObject({ updated: 1 });
  });

  it("leaves the stored rates alone when the server sent none (#61)", async () => {
    // A 2.1-shaped row as the wire schema hands it on: no rate keys at all.
    const noRates: Record<string, unknown> = remoteLodge("Aorangi Ski Club", { bedCapacity: 30 });
    for (const key of Object.keys(RATES_CENTS)) delete noRates[key];
    mockPullOtherLodges.mockResolvedValue({ lodges: [noRates], count: 1, cursor: "c-407", dropped: 0 });
    mockFindUnique.mockResolvedValue(localCopyOf("ol_1", "2026-08-01T00:00:00.000Z"));

    await downloadOtherClubsFromServer();

    const [{ data }] = mockUpdateMany.mock.calls[0];
    for (const key of Object.keys(RATES_CENTS)) expect(data).not.toHaveProperty(key);
    expect(data).toMatchObject({ bedCapacity: 30 });
  });
});

// ── Keeping `updatedAt` honest ─────────────────────────────────────────────
//
// The upload watermark is derived from `updatedAt`, so anything that writes a
// misleading value there corrupts the next upload's idea of "changed locally".

describe("sync loop hygiene", () => {
  it("stamps a downloaded row with the SERVER's updatedAt, not now()", async () => {
    // Otherwise Prisma's @updatedAt marks a row we merely RECEIVED as edited
    // right now, and the next upload sends it straight back as this club's work.
    mockPullOtherLodges.mockResolvedValue({
      lodges: [remoteLodge("Aorangi Ski Club", { bedCapacity: 30 })],
      count: 1,
      cursor: "c-300",
      dropped: 0,
    });
    mockFindUnique.mockResolvedValue(localCopyOf("ol_1", "2026-08-01T00:00:00.000Z"));

    await downloadOtherClubsFromServer();

    expect(mockUpdateMany).toHaveBeenCalledWith({
      where: { id: "ol_1", updatedAt: new Date("2026-08-01T00:00:00.000Z"), hiddenAt: null },
      data: expect.objectContaining({
        bedCapacity: 30,
        updatedAt: new Date(REMOTE_UPDATED_AT),
      }),
    });
  });

  it("does not overwrite a local edit that is newer than the server's copy", async () => {
    // Upload runs before download in one pass, so an admin editing a row in
    // between would otherwise have it clobbered by the copy the server already
    // held — and the stale value would then be uploaded as authoritative.
    mockPullOtherLodges.mockResolvedValue({
      lodges: [remoteLodge("Aorangi Ski Club", { bedCapacity: 30 })],
      count: 1,
      cursor: "c-301",
      dropped: 0,
    });
    // Edited locally AFTER the timestamp the server is reporting.
    mockFindUnique.mockResolvedValue(localCopyOf("ol_1", "2026-08-20T00:00:00.000Z"));

    const result = await downloadOtherClubsFromServer();

    expect(mockUpdateMany).not.toHaveBeenCalled();
    expect(result).toMatchObject({ updated: 0, keptLocal: 1 });
  });

  it("holds the upload watermark below a row the server rejected", async () => {
    // Advancing past a skipped row is how a rejection becomes permanent: it is
    // never re-sent, so it silently never reaches the registry (INV-INT-004).
    const rejected = new Date("2026-08-10T00:00:00.000Z");
    const accepted = new Date("2026-08-14T00:00:00.000Z");
    mockFindMany.mockResolvedValue(
      ownAll([
        { ...localCopyOf("ol_1", rejected.toISOString()), name: "Rejected Club" },
        { ...localCopyOf("ol_2", accepted.toISOString()), name: "Accepted Club" },
      ]),
    );
    mockUploadOtherLodges.mockResolvedValue({
      created: 1,
      updated: 0,
      unchanged: 0,
      skipped: 1,
      results: [
        { name: "Rejected Club", status: "skipped", reason: "duplicate" },
        { name: "Accepted Club", status: "created" },
      ],
    });

    await uploadOtherClubsToServer();

    // Strictly BELOW the rejected row, even though a newer row was accepted, so
    // the next run re-sends it rather than stepping over it forever.
    const [watermark] = mockRecordUpload.mock.calls[0];
    expect(watermark.getTime()).toBeLessThan(rejected.getTime());
  });

  it("does not advance the watermark when every row was rejected", async () => {
    const only = new Date("2026-08-10T00:00:00.000Z");
    mockFindMany.mockResolvedValue(
      ownAll([{ ...localCopyOf("ol_1", only.toISOString()), name: "Rejected Club" }]),
    );
    mockUploadOtherLodges.mockResolvedValue({
      created: 0,
      updated: 0,
      unchanged: 0,
      skipped: 1,
      results: [{ name: "Rejected Club", status: "skipped", reason: "duplicate" }],
    });

    await uploadOtherClubsToServer();

    expect(mockRecordUpload).not.toHaveBeenCalled();
  });
});

// ── Cursor overlap (#2995) ─────────────────────────────────────────────────
//
// Transactions do not become visible in `updatedAt` order. A slow transaction
// can take an earlier timestamp and commit after a faster one; if the cursor
// advanced past it in that window, a strictly-newer-than request skips it
// FOREVER while sync keeps reporting success. Every pull after the first
// therefore re-asks one bounded overlap before the stored cursor. The repeats
// must stay harmless, and the DURABLE cursor must still be the server's answer.

describe("download cursor overlap", () => {
  it("requests exactly one overlap before the stored cursor, across minute and day boundaries", async () => {
    // Literal expectations, not the constant recomputed: a test that derives the
    // answer from the same constant the code uses passes just as happily when
    // the overlap is zero, which is the mutation this test exists to catch.
    const cases: [stored: string, requested: string][] = [
      // Mid-minute: a plain 60-second step back.
      ["2026-06-20T10:05:30.000Z", "2026-06-20T10:04:30.000Z"],
      // Minute boundary: borrows from the minute above.
      ["2026-06-20T10:00:00.000Z", "2026-06-20T09:59:00.000Z"],
      // Day boundary: borrows from the previous day, not clamped at midnight.
      ["2026-06-20T00:00:30.000Z", "2026-06-19T23:59:30.000Z"],
      // Year boundary, and a non-UTC offset, RE-EMITTED in that same offset
      // rather than normalised to Z. Normalising gives 2026-12-31T23:59:00Z,
      // which is the right instant but sorts EARLIER or LATER than the stored
      // value depending on the sign — see the west-of-UTC case below.
      ["2027-01-01T13:00:00+13:00", "2027-01-01T12:59:00.000+13:00"],
      // West of UTC is where normalising to Z actively breaks a server that
      // compares the cursor as TEXT: "2026-06-20T10:05:30-05:00" normalises to
      // "2026-06-20T15:04:30.000Z", which sorts AFTER the stored value — the
      // overlap inverted into a five-hour jump FORWARD, skipping rows.
      ["2026-06-20T10:05:30-05:00", "2026-06-20T10:04:30.000-05:00"],
      // Four legal ISO-8601 spellings a central server is free to send, and
      // which a hand-rolled `T..Z`-shaped regex passed through untouched — so
      // the overlap was inert against a server written in Python (isoformat()),
      // .NET, or reading a Postgres timestamptz straight out.
      ["2026-06-20T10:05Z", "2026-06-20T10:04:00.000Z"],
      ["2026-06-20T10:05:30+1300", "2026-06-20T10:04:30.000+1300"],
      ["2026-06-20t10:05:30Z", "2026-06-20t10:04:30.000Z"],
      ["2026-06-20 10:05:30Z", "2026-06-20 10:04:30.000Z"],
    ];

    for (const [stored, requested] of cases) {
      vi.clearAllMocks();
      mockLoadSettings.mockResolvedValue({ ...SETTINGS, otherLodgesCursor: stored });
      mockRecordDownload.mockResolvedValue(undefined);
      mockPullOtherLodges.mockResolvedValue({
        lodges: [],
        count: 0,
        cursor: "2026-06-21T00:00:00.000Z",
        dropped: 0,
      });

      await downloadOtherClubsFromServer();

      expect(mockPullOtherLodges).toHaveBeenCalledWith(requested);
      // Strictly earlier as TEXT as well as as an instant, because a server is
      // free to treat an opaque-by-contract cursor as a string key. Preserving
      // the separator and the offset is what makes both readings agree.
      expect(requested < stored).toBe(true);
      expect(new Date(requested).getTime()).toBeLessThan(new Date(stored).getTime());
      // A cursor the overlap CAN step is never reported as inert.
      expect(mockLoggerWarn).not.toHaveBeenCalled();
    }
  });

  it("persists the server's returned watermark, never the overlapped request value", async () => {
    const stored = "2026-06-20T10:05:30.000Z";
    mockLoadSettings.mockResolvedValue({ ...SETTINGS, otherLodgesCursor: stored });
    mockPullOtherLodges.mockResolvedValue({
      lodges: [],
      count: 0,
      cursor: "2026-06-21T09:00:00.000Z",
      dropped: 0,
    });

    await downloadOtherClubsFromServer();

    // The overlap widens the QUESTION; it must never move the stored ANSWER
    // backwards, which is what would turn a bounded re-ask into a slow rewind.
    expect(mockRecordDownload).toHaveBeenCalledWith("2026-06-21T09:00:00.000Z", undefined);
    expect(mockRecordDownload).not.toHaveBeenCalledWith("2026-06-20T10:04:30.000Z");
    expect(mockRecordDownload).not.toHaveBeenCalledWith(stored);
  });

  it("counts a row the overlap re-delivers unchanged as unchanged, not as a change", async () => {
    // INSIDE the overlap window — the sixty seconds before the cursor — so this
    // row is in the pull ONLY because of the overlap. Stamped after the cursor
    // instead it would be an ordinary new-change row, and "an identical row is
    // written nowhere" would be a property of every pull rather than of the
    // repeat this test is named for.
    const insideWindow = "2026-06-20T10:05:00.000Z";
    mockLoadSettings.mockResolvedValue({
      ...SETTINGS,
      otherLodgesCursor: "2026-06-20T10:05:30.000Z",
    });
    mockPullOtherLodges.mockResolvedValue({
      // The first row is the repeat the overlap deliberately re-fetched; the
      // second is the genuine change the pull was for.
      lodges: [
        remoteLodge("Aorangi Ski Club", { updatedAt: insideWindow }),
        remoteLodge("Arlberg Ski Club", {
          bedCapacity: 30,
          updatedAt: "2026-06-20T11:00:00.000Z",
        }),
      ],
      count: 2,
      cursor: "2026-06-21T00:00:00.000Z",
      dropped: 0,
    });
    mockFindUnique
      // Already applied on an earlier pass, carrying the server's own timestamp
      // (rule 1) — exactly the state the overlap re-delivers into.
      .mockResolvedValueOnce(localCopyOf("ol_1", insideWindow))
      .mockResolvedValueOnce(localCopyOf("ol_2", "2026-06-19T00:00:00.000Z"));

    const result = await downloadOtherClubsFromServer();

    // One write, for the one row that actually differed. An inflated `updated`
    // here would make every overlapped pull look like a burst of remote edits.
    expect(mockUpdateMany).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ fetched: 2, created: 0, updated: 1, unchanged: 1, keptLocal: 0 });
  });

  it("still refuses an overlapped remote row that is older than the local copy", async () => {
    mockLoadSettings.mockResolvedValue({
      ...SETTINGS,
      otherLodgesCursor: "2026-06-20T10:05:30.000Z",
    });
    mockPullOtherLodges.mockResolvedValue({
      // Stamped INSIDE the overlap window, so it is genuinely a row the overlap
      // re-offered rather than an ordinary new remote change.
      lodges: [
        remoteLodge("Aorangi Ski Club", {
          bedCapacity: 30,
          updatedAt: "2026-06-20T10:05:00.000Z",
        }),
      ],
      count: 1,
      cursor: "2026-06-21T00:00:00.000Z",
      dropped: 0,
    });
    // Corrected locally after the server's copy — the overlap re-offering that
    // older copy must not become a way to undo the club's own edit.
    mockFindUnique.mockResolvedValue(localCopyOf("ol_1", "2026-06-20T12:00:00.000Z"));

    const result = await downloadOtherClubsFromServer();

    expect(mockPullOtherLodges).toHaveBeenCalledWith("2026-06-20T10:04:30.000Z");
    expect(mockUpdateMany).not.toHaveBeenCalled();
    expect(result).toMatchObject({ updated: 0, keptLocal: 1 });
  });

  it("leaves an initial sync with no stored cursor exactly as it was", async () => {
    mockLoadSettings.mockResolvedValue({ ...SETTINGS, otherLodgesCursor: null });
    mockPullOtherLodges.mockResolvedValue({
      lodges: [],
      count: 0,
      cursor: "2026-06-21T00:00:00.000Z",
      dropped: 0,
    });

    await downloadOtherClubsFromServer();

    // No cursor means no watermark to overlap: the full/initial pull is asked
    // for unchanged, rather than for a window before an instant that has no
    // meaning yet.
    expect(mockPullOtherLodges).toHaveBeenCalledWith(null);
    expect(mockRecordDownload).toHaveBeenCalledWith("2026-06-21T00:00:00.000Z", undefined);
  });

  it("does not advance the durable cursor when the pull or the merge fails", async () => {
    mockLoadSettings.mockResolvedValue({
      ...SETTINGS,
      otherLodgesCursor: "2026-06-20T10:05:30.000Z",
    });

    // The pull itself fails: nothing was merged, so the old cursor stands and
    // the next run asks the same question again.
    mockPullOtherLodges.mockRejectedValue(new Error("central server unreachable"));
    await expect(downloadOtherClubsFromServer()).rejects.toThrow("central server unreachable");
    expect(mockRecordDownload).not.toHaveBeenCalled();

    // A partial merge: rows were written and then a write failed. The cursor is
    // recorded only after the whole loop, so the next run re-fetches from the
    // old cursor and the idempotent merge re-applies what already landed.
    mockPullOtherLodges.mockResolvedValue({
      lodges: [remoteLodge("Aorangi Ski Club", { bedCapacity: 30 })],
      count: 1,
      cursor: "2026-06-21T00:00:00.000Z",
      dropped: 0,
    });
    mockFindUnique.mockResolvedValue(localCopyOf("ol_1", "2026-06-19T00:00:00.000Z"));
    mockUpdateMany.mockRejectedValue(new Error("write failed"));

    await expect(downloadOtherClubsFromServer()).rejects.toThrow("write failed");
    expect(mockRecordDownload).not.toHaveBeenCalled();
  });

  it("never lets the durable cursor rewind, even when the server echoes the overlapped request", async () => {
    // THE REWIND THE OVERLAP MADE POSSIBLE. A cursor endpoint ordinarily answers
    // with the newest row it returned, and echoes `since` when the page is
    // empty. A quiet night is then: stored C, request C - 60s, no rows, echo
    // C - 60s — and storing that answer moves the watermark BACKWARDS a minute.
    // The next quiet run rewinds another, an admin pressing Download
    // accelerates it, and the re-fetch grows without bound. Quiet nights are
    // this registry's normal state, so this is the common case, not the corner.
    const stored = "2026-06-20T10:05:30.000Z";
    mockLoadSettings.mockResolvedValue({ ...SETTINGS, otherLodgesCursor: stored });
    mockPullOtherLodges.mockResolvedValue({
      lodges: [],
      count: 0,
      cursor: "2026-06-20T10:04:30.000Z",
      dropped: 0,
    });

    await downloadOtherClubsFromServer();

    expect(mockPullOtherLodges).toHaveBeenCalledWith("2026-06-20T10:04:30.000Z");
    expect(mockRecordDownload).toHaveBeenCalledWith(stored, undefined);
  });

  it("still advances to a server watermark that is genuinely later", async () => {
    // The other half of monotonic: refusing to rewind must not turn into
    // refusing to move, which would freeze the sync at its first cursor.
    mockLoadSettings.mockResolvedValue({
      ...SETTINGS,
      otherLodgesCursor: "2026-06-20T10:05:30.000Z",
    });
    mockPullOtherLodges.mockResolvedValue({
      lodges: [],
      count: 0,
      cursor: "2026-06-20T10:05:30.001Z",
      dropped: 0,
    });

    await downloadOtherClubsFromServer();

    expect(mockRecordDownload).toHaveBeenCalledWith("2026-06-20T10:05:30.001Z", undefined);
  });

  it("passes a cursor it cannot read as an instant through untouched, and says so", async () => {
    // The cursor is contractually opaque, so the overlap cannot always apply —
    // and an overlap that is not applying looks EXACTLY like one that is, in
    // every summary an operator sees. The log line is the only signal that this
    // protection has been doing nothing since the day it shipped.
    const cases = [
      // An opaque token or sequence number: no time in it to step back from.
      "c-100",
      // Zone-less, so it names a wall-clock reading rather than a moment.
      // Stepping it would resolve it in the HOST's zone — twelve or thirteen
      // hours out on a New Zealand deployment, silently.
      "2026-06-20T10:05:30",
      // A date that does not exist. `Date.parse` rolls it forward to 2 March,
      // so a step back from it lands nearly two days LATER than the stored
      // cursor and skips every row in between — this defect, amplified.
      "2026-02-30T00:00:00Z",
    ];

    for (const stored of cases) {
      vi.clearAllMocks();
      mockLoadSettings.mockResolvedValue({ ...SETTINGS, otherLodgesCursor: stored });
      mockRecordDownload.mockResolvedValue(undefined);
      mockPullOtherLodges.mockResolvedValue({
        lodges: [],
        count: 0,
        cursor: "c-200",
        dropped: 0,
      });

      await downloadOtherClubsFromServer();

      expect(mockPullOtherLodges).toHaveBeenCalledWith(stored);
      // Unreadable on both sides, so the server's answer still stands: the
      // monotonic guard narrows nothing it cannot order.
      expect(mockRecordDownload).toHaveBeenCalledWith("c-200", undefined);
      expect(mockLoggerWarn).toHaveBeenCalledTimes(1);
      expect(mockLoggerWarn).toHaveBeenCalledWith(
        { cursor: stored },
        expect.stringContaining("NOT being applied"),
      );
    }
  });
});

// ── Own lodges only (#52) ──────────────────────────────────────────────────
//
// The central server says which lodges this club owns (`ownLodges` on every
// pull). The download records that list, and the upload sends ONLY those lodges
// once it is known — through the one `ownsOtherLodge` rule the admin PATCH
// route also applies. Before this, every row a download had just written
// (server-stamped, so above the watermark) went straight back up each night for
// the server to refuse (#53).

describe("own lodges only (#52)", () => {
  const ACCEPTED = {
    created: 0,
    updated: 1,
    unchanged: 0,
    skipped: 0,
    results: [{ name: "Aorangi Ski Club", status: "updated" }],
  };

  it("records the owned list the pull carried, with the cursor, after the merge", async () => {
    mockPullOtherLodges.mockResolvedValue({
      lodges: [],
      count: 0,
      cursor: "c-500",
      dropped: 0,
      ownLodges: owns("Aorangi Ski Club"),
    });

    await downloadOtherClubsFromServer();

    expect(mockRecordDownload).toHaveBeenCalledWith("c-500", owns("Aorangi Ski Club"));
  });

  it("records the owned lodges exactly as the pull carried them, ids and all (#62)", async () => {
    mockPullOtherLodges.mockResolvedValue({
      lodges: [],
      count: 0,
      cursor: "c-510",
      dropped: 0,
      ownLodges: [{ id: "ol_a", name: "Aorangi Ski Club" }],
    });

    await downloadOtherClubsFromServer();

    expect(mockRecordDownload).toHaveBeenCalledWith("c-510", [{ id: "ol_a", name: "Aorangi Ski Club" }]);
  });

  it("warns when the server's owned list was refused, and records none (#62)", async () => {
    mockPullOtherLodges.mockResolvedValue({
      lodges: [],
      count: 0,
      cursor: "c-511",
      dropped: 0,
      ownLodges: undefined,
      ownLodgesRefused: true,
    });

    await downloadOtherClubsFromServer();

    expect(mockLoggerWarn).toHaveBeenCalledWith(expect.stringContaining("owned-lodge list"));
    expect(mockRecordDownload).toHaveBeenCalledWith("c-511", undefined);
  });

  it("records an EMPTY owned list as an answer, not as an omission", async () => {
    mockPullOtherLodges.mockResolvedValue({
      lodges: [],
      count: 0,
      cursor: "c-501",
      dropped: 0,
      ownLodges: [],
    });

    await downloadOtherClubsFromServer();

    expect(mockRecordDownload).toHaveBeenCalledWith("c-501", []);
  });

  it("passes `undefined` when the server did not send the list, so a stored list is left alone", async () => {
    // An older server. The recorder treats `undefined` as "do not touch".
    mockPullOtherLodges.mockResolvedValue({
      lodges: [],
      count: 0,
      cursor: "c-502",
      dropped: 0,
      ownLodges: undefined,
    });

    await downloadOtherClubsFromServer();

    expect(mockRecordDownload).toHaveBeenCalledWith("c-502", undefined);
  });

  it("does not record the owned list when the merge throws part-way", async () => {
    mockPullOtherLodges.mockResolvedValue({
      lodges: [remoteLodge("Aorangi Ski Club", { bedCapacity: 30 })],
      count: 1,
      cursor: "c-503",
      dropped: 0,
      ownLodges: owns("Aorangi Ski Club"),
    });
    mockFindUnique.mockRejectedValue(new Error("connection reset"));

    await expect(downloadOtherClubsFromServer()).rejects.toThrow("connection reset");

    expect(mockRecordDownload).not.toHaveBeenCalled();
  });

  it("uploads only the owned lodges when the list is known, and watermarks on those alone", async () => {
    const ours = new Date("2026-08-10T00:00:00.000Z");
    const theirs = new Date("2026-08-14T00:00:00.000Z");
    mockLoadSettings.mockResolvedValue({
      ...SETTINGS,
      otherLodgesOwnedLodges: owns("Aorangi Ski Club"),
    });
    mockFindMany.mockResolvedValue([
      { ...localCopyOf("ol_1", ours.toISOString()), name: "Aorangi Ski Club", centralId: "id:Aorangi Ski Club" },
      // Another club's lodge, freshly downloaded and server-stamped NEWER than
      // ours: before #52 this row went up every night (#53).
      { ...localCopyOf("ol_2", theirs.toISOString()), name: "Arlberg Ski Club", centralId: "c-theirs" },
    ]);
    mockUploadOtherLodges.mockResolvedValue(ACCEPTED);

    const result = await uploadOtherClubsToServer();

    const [sent] = mockUploadOtherLodges.mock.calls[0];
    expect(sent.map((l: { name: string }) => l.name)).toEqual(["Aorangi Ski Club"]);
    expect(result.sent).toBe(1);
    // The watermark is the newest OWNED row that was accepted, not the other
    // club's newer row that was never sent.
    expect(mockRecordUpload).toHaveBeenCalledWith(ours);
  });

  it("sends nothing at all when the list is known and empty, even with changed rows", async () => {
    mockLoadSettings.mockResolvedValue({ ...SETTINGS, otherLodgesOwnedLodges: [] });
    mockFindMany.mockResolvedValue([
      { ...localCopyOf("ol_2", "2026-08-14T00:00:00.000Z"), name: "Arlberg Ski Club" },
    ]);

    const result = await uploadOtherClubsToServer();

    expect(mockUploadOtherLodges).not.toHaveBeenCalled();
    expect(mockRecordUpload).not.toHaveBeenCalled();
    expect(result.sent).toBe(0);
  });

  it("sends NOTHING while the list is UNKNOWN, and never an unkeyed row (#69)", async () => {
    // An unkeyed copy of another club's lodge sent without an id would be
    // CREATED on the server as this club's: names may repeat.
    mockLoadSettings.mockResolvedValue({ ...SETTINGS, otherLodgesOwnedLodges: null });
    mockFindMany.mockResolvedValue([
      { ...localCopyOf("ol_1", "2026-08-10T00:00:00.000Z"), name: "Aorangi Ski Club", centralId: null },
    ]);

    const result = await uploadOtherClubsToServer();

    expect(mockFindMany).not.toHaveBeenCalled();
    expect(mockUploadOtherLodges).not.toHaveBeenCalled();
    expect(mockRecordUpload).not.toHaveBeenCalled();
    expect(result.sent).toBe(0);
    expect(result.ownedUnknown).toBe(true);
  });

  it("matches ownership by central id, never by name (#69)", async () => {
    mockLoadSettings.mockResolvedValue({ ...SETTINGS, otherLodgesOwnedLodges: owns("Aorangi Ski Club") });
    mockFindMany.mockResolvedValue([
      // The owned lodge's name, but not keyed (or keyed to another lodge).
      { ...localCopyOf("ol_1", "2026-08-10T00:00:00.000Z"), name: "Aorangi Ski Club", centralId: null },
      { ...localCopyOf("ol_2", "2026-08-10T00:00:00.000Z"), name: "Aorangi Ski Club", centralId: "c-other" },
    ]);

    await uploadOtherClubsToServer();

    expect(mockUploadOtherLodges).not.toHaveBeenCalled();
  });
});

describe("own lodges only: the review fixes (#52)", () => {
  it("uploads NOTHING when the stored owned list is present but unreadable, and says so", async () => {
    // A column that was written and no longer parses is a defect, not a fresh
    // install: the permissive "send every row" fallback is for never-told only.
    mockLoadSettings.mockResolvedValue({
      ...SETTINGS,
      otherLodgesOwnedLodges: null,
      otherLodgesOwnedLodgesUnreadable: true,
    });
    mockFindMany.mockResolvedValue([
      { ...localCopyOf("ol_1", "2026-08-10T00:00:00.000Z"), name: "Aorangi Ski Club" },
    ]);

    const result = await uploadOtherClubsToServer();

    expect(mockFindMany).not.toHaveBeenCalled();
    expect(mockUploadOtherLodges).not.toHaveBeenCalled();
    expect(mockRecordUpload).not.toHaveBeenCalled();
    expect(result.sent).toBe(0);
    expect(mockLoggerWarn).toHaveBeenCalledWith(expect.stringMatching(/cannot be read/i));
  });

  it("applies the server's copy of ANOTHER club's lodge even when the local row is newer", async () => {
    // Rule 2 protects a local edit awaiting upload. Another club's lodge can
    // have no such edit, so the server is authoritative there.
    mockPullOtherLodges.mockResolvedValue({
      lodges: [remoteLodge("Arlberg Ski Club", { bedCapacity: 30 })],
      count: 1,
      cursor: "c-600",
      dropped: 0,
      ownLodges: owns("Aorangi Ski Club"),
    });
    // Local copy stamped AFTER the server's.
    mockFindUnique.mockResolvedValue(localCopyOf("ol_2", "2026-09-01T00:00:00.000Z"));

    const result = await downloadOtherClubsFromServer();

    expect(mockUpdateMany).toHaveBeenCalledWith({
      where: { id: "ol_2", updatedAt: new Date("2026-09-01T00:00:00.000Z"), hiddenAt: null },
      data: expect.objectContaining({ bedCapacity: 30 }),
    });
    expect(result).toMatchObject({ updated: 1, keptLocal: 0 });
  });

  it("still keeps a newer local copy of OUR OWN lodge", async () => {
    mockPullOtherLodges.mockResolvedValue({
      lodges: [remoteLodge("Aorangi Ski Club", { id: "id:Aorangi Ski Club", bedCapacity: 30 })],
      count: 1,
      cursor: "c-601",
      dropped: 0,
      ownLodges: owns("Aorangi Ski Club"),
    });
    mockFindUnique.mockResolvedValue({
      ...localCopyOf("ol_1", "2026-09-01T00:00:00.000Z"),
      centralId: "id:Aorangi Ski Club",
    });

    const result = await downloadOtherClubsFromServer();

    expect(mockUpdateMany).not.toHaveBeenCalled();
    expect(result).toMatchObject({ updated: 0, keptLocal: 1 });
  });

  it("uses the STORED owned list for the merge when this pull did not carry one", async () => {
    mockLoadSettings.mockResolvedValue({ ...SETTINGS, otherLodgesOwnedLodges: owns("Aorangi Ski Club") });
    mockPullOtherLodges.mockResolvedValue({
      lodges: [remoteLodge("Arlberg Ski Club", { bedCapacity: 30 })],
      count: 1,
      cursor: "c-602",
      dropped: 0,
      ownLodges: undefined,
    });
    mockFindUnique.mockResolvedValue(localCopyOf("ol_2", "2026-09-01T00:00:00.000Z"));

    const result = await downloadOtherClubsFromServer();

    expect(result).toMatchObject({ updated: 1, keptLocal: 0 });
  });

  it("never stores another club's booking officer phone: a sent number lands as null", async () => {
    // An older server still sends the number. It is the one deliberate
    // exception to "a field the server did not send is left alone".
    mockPullOtherLodges.mockResolvedValue({
      lodges: [remoteLodge("Arlberg Ski Club", { bookingOfficerPhone: "+64 21 000 0000" })],
      count: 1,
      cursor: "c-603",
      dropped: 0,
      ownLodges: owns("Aorangi Ski Club"),
    });
    mockFindUnique.mockResolvedValue({
      ...localCopyOf("ol_2", "2026-08-01T00:00:00.000Z"),
      bookingOfficerPhone: null,
    });

    const result = await downloadOtherClubsFromServer();

    // The row is already at null and nothing else differs, so it is not even
    // written: the sent number is dropped before the "differs" comparison.
    expect(mockUpdateMany).not.toHaveBeenCalled();
    expect(result).toMatchObject({ unchanged: 1, updated: 0 });
  });

  it("clears a phone an earlier download stored for another club's lodge, on its next download", async () => {
    mockPullOtherLodges.mockResolvedValue({
      // The current server sends no phone at all.
      lodges: [remoteLodge("Arlberg Ski Club", { bookingOfficerPhone: undefined })],
      count: 1,
      cursor: "c-604",
      dropped: 0,
      ownLodges: owns("Aorangi Ski Club"),
    });
    mockFindUnique.mockResolvedValue(localCopyOf("ol_2", "2026-08-01T00:00:00.000Z"));

    const result = await downloadOtherClubsFromServer();

    expect(mockUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ bookingOfficerPhone: null }) }),
    );
    expect(result.updated).toBe(1);
  });

  it("creates another club's lodge without its phone", async () => {
    mockPullOtherLodges.mockResolvedValue({
      lodges: [remoteLodge("Ngauruhoe Ski Club", { bookingOfficerPhone: "+64 21 000 0000" })],
      count: 1,
      cursor: "c-605",
      dropped: 0,
      ownLodges: owns("Aorangi Ski Club"),
    });
    mockFindUnique.mockResolvedValue(null);

    await downloadOtherClubsFromServer();

    const [[{ data: create }]] = mockCreate.mock.calls;
    expect(create.bookingOfficerPhone).toBeNull();
  });

  it("stores our OWN lodge's phone as sent", async () => {
    mockPullOtherLodges.mockResolvedValue({
      lodges: [remoteLodge("Aorangi Ski Club", { id: "id:Aorangi Ski Club", bookingOfficerPhone: "+64 21 000 0000" })],
      count: 1,
      cursor: "c-606",
      dropped: 0,
      ownLodges: owns("Aorangi Ski Club"),
    });
    mockFindUnique.mockResolvedValue({
      ...localCopyOf("ol_1", "2026-08-01T00:00:00.000Z"),
      centralId: "id:Aorangi Ski Club",
    });

    await downloadOtherClubsFromServer();

    const [[{ data }]] = mockUpdateMany.mock.calls;
    expect(data.bookingOfficerPhone).toBe("+64 21 000 0000");
  });

  it("leaves the phone alone while the owned list is unknown", async () => {
    mockPullOtherLodges.mockResolvedValue({
      lodges: [remoteLodge("Arlberg Ski Club", { bookingOfficerPhone: "+64 21 000 0000" })],
      count: 1,
      cursor: "c-607",
      dropped: 0,
      ownLodges: undefined,
    });
    mockFindUnique.mockResolvedValue(localCopyOf("ol_2", "2026-08-01T00:00:00.000Z"));

    await downloadOtherClubsFromServer();

    const [[{ data }]] = mockUpdateMany.mock.calls;
    expect(data.bookingOfficerPhone).toBe("+64 21 000 0000");
  });

  it("warns when the server's owned list was refused, and leaves the stored list alone", async () => {
    mockPullOtherLodges.mockResolvedValue({
      lodges: [],
      count: 0,
      cursor: "c-608",
      dropped: 0,
      ownLodges: undefined,
      ownLodgesRefused: true,
    });

    await downloadOtherClubsFromServer();

    expect(mockLoggerWarn).toHaveBeenCalledWith(expect.stringMatching(/failed its bounds/i));
    expect(mockRecordDownload).toHaveBeenCalledWith("c-608", undefined);
  });
});

// ── Central id (#64) ───────────────────────────────────────────────────────

describe("download keyed by the central server's lodge id (#64)", () => {
  type Row = Omit<ReturnType<typeof localCopyOf>, "bookingOfficerPhone"> & {
    bookingOfficerPhone: string | null;
    name: string;
    centralId: string | null;
    hiddenAt?: Date | null;
  };

  /**
   * A tiny registry the merge reads and writes through the mocks, so renames
   * and keying behave as the indexes make them behave: the central id is
   * unique, a name is not (#69).
   */
  /** Bookings and booking requests citing a row, by row id (#58). */
  const refs = new Map<string, [number, number]>();
  function registry(initial: Row[]) {
    refs.clear();
    const rows = initial.map((r) => ({ ...r }));
    // The download's raw writes (#58): hiding a deleted lodge, and unlinking a
    // club lodge linked to it. Prisma.sql objects (the whole-download forget)
    // are answered 0.
    mockExecuteRaw.mockImplementation(async (strings: TemplateStringsArray | { sql: string }, ...values: unknown[]) => {
      if ("sql" in strings) return 0;
      const sql = strings.join("?");
      if (sql.startsWith('UPDATE "Lodge"')) return 0;
      const [hiddenAt, rowId, centralId] = values as [Date, string, string];
      const target = rows.find((r) => r.id === rowId && r.centralId === centralId && !r.hiddenAt);
      if (target) target.hiddenAt = hiddenAt;
      return target ? 1 : 0;
    });
    const unique = () =>
      new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
        code: "P2002",
        clientVersion: "test",
      });
    mockFindUnique.mockImplementation(async ({ where }: { where: Record<string, string> }) => {
      const found = rows.find(
        (r) =>
          (where.centralId !== undefined ? r.centralId === where.centralId : r.name === where.name) &&
          (!("hiddenAt" in where) || !r.hiddenAt),
      );
      return found
        ? {
            ...found,
            _count: { bookings: refs.get(found.id)?.[0] ?? 0, bookingRequests: refs.get(found.id)?.[1] ?? 0 },
          }
        : null;
    });
    mockUpdateMany.mockImplementation(
      async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        const target = rows.find(
          (r) =>
            r.id === where.id &&
            (where.updatedAt === undefined ||
              r.updatedAt.getTime() === (where.updatedAt as Date).getTime()) &&
            (where.centralId === undefined || r.centralId === where.centralId),
        );
        if (!target) return { count: 0 };
        if (typeof data.centralId === "string" && rows.some((r) => r !== target && r.centralId === data.centralId)) {
          throw unique();
        }
        Object.assign(target, data);
        return { count: 1 };
      },
    );
    mockFindMany.mockImplementation(async ({ where }: { where?: { centralId?: { in: string[] } } }) =>
      rows.filter((r) => r.centralId !== null && (where?.centralId?.in ?? []).includes(r.centralId)),
    );
    mockFindByName.mockImplementation(async ({ where }: { where: { name: string; hiddenAt?: null } }) =>
      // Copies, as a read is: a later write to the row does not change what was read.
      rows.filter((r) => r.name === where.name && (!("hiddenAt" in where) || !r.hiddenAt)).map((r) => ({ ...r })),
    );
    return rows;
  }

  const row = (id: string, name: string, centralId: string | null): Row => ({
    ...localCopyOf(id, "2026-08-01T00:00:00.000Z"),
    name,
    centralId,
  });

  function pull(lodges: unknown[], over: Record<string, unknown> = {}) {
    mockPullOtherLodges.mockResolvedValue({
      lodges,
      count: lodges.length,
      cursor: "c-640",
      dropped: 0,
      ownLodges: [{ id: "c-ours", name: "Our Lodge" }],
      ...over,
    });
  }

  it("renames another club's lodge IN PLACE when the server renamed it, keeping the row", async () => {
    const rows = registry([row("ol_1", "Old Name", "c-1")]);
    pull([remoteLodge("New Name", { id: "c-1" })]);

    const result = await downloadOtherClubsFromServer();

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: "ol_1", name: "New Name", centralId: "c-1" });
    expect(mockCreate).not.toHaveBeenCalled();
    expect(result).toMatchObject({ updated: 1, renamed: 1, created: 0, nameConflicts: [] });
  });

  it("never renames THIS club's own lodge from a download", async () => {
    const rows = registry([row("ol_9", "Our New Name", "c-ours")]);
    pull([remoteLodge("Our Lodge", { id: "c-ours", bedCapacity: 30 })]);

    await downloadOtherClubsFromServer();

    expect(rows[0]).toMatchObject({ name: "Our New Name", bedCapacity: 30 });
  });

  it("records the owned list by id, whatever our lodge is called here (#69)", async () => {
    registry([row("ol_9", "Our New Name", "c-ours")]);
    pull([]);

    await downloadOtherClubsFromServer();

    expect(mockRecordDownload).toHaveBeenCalledWith("c-640", [{ id: "c-ours", name: "Our Lodge" }]);
  });

  it("keys a row matched by name once (the backfill), without moving its updatedAt", async () => {
    // Another club's lodge, so its phone is never stored: none here either.
    const rows = registry([{ ...row("ol_1", "Aorangi Ski Club", null), bookingOfficerPhone: null }]);
    mockLoadSettings.mockResolvedValue({ ...SETTINGS, otherLodgesKeyedAt: null }); // a whole download keys by name (#69)
    pull([remoteLodge("Aorangi Ski Club", { id: "c-1" })]);

    const result = await downloadOtherClubsFromServer();

    expect(rows[0].centralId).toBe("c-1");
    expect(rows[0].updatedAt).toEqual(new Date("2026-08-01T00:00:00.000Z"));
    // Identical data otherwise: keyed, and still counted unchanged.
    expect(result).toMatchObject({ unchanged: 1, updated: 0 });
  });

  it("keys our own row even when a newer local edit keeps its data", async () => {
    const rows = registry([
      {
        ...row("ol_9", "Our Lodge", null),
        updatedAt: new Date("2026-09-01T00:00:00.000Z"),
        bedCapacity: 2,
      },
    ]);
    mockLoadSettings.mockResolvedValue({ ...SETTINGS, otherLodgesKeyedAt: null }); // a whole download keys by name (#69)
    pull([remoteLodge("Our Lodge", { id: "c-ours" })]);

    const result = await downloadOtherClubsFromServer();

    expect(rows[0]).toMatchObject({ centralId: "c-ours", bedCapacity: 2 });
    expect(result.keptLocal).toBe(1);
  });

  it("renames a chain in one pass (A becomes B while B becomes C): a name is never held (#69)", async () => {
    const rows = registry([row("ol_a", "Alpha", "c-a"), row("ol_b", "Beta", "c-b")]);
    pull([remoteLodge("Beta", { id: "c-a" }), remoteLodge("Gamma", { id: "c-b" })]);

    const result = await downloadOtherClubsFromServer();

    expect(rows.map((r) => [r.id, r.name])).toEqual([
      ["ol_a", "Beta"],
      ["ol_b", "Gamma"],
    ]);
    expect(result).toMatchObject({ renamed: 2, nameConflicts: [] });
    // Nothing was deferred: each lodge was merged once.
    expect(mockUpdateMany).toHaveBeenCalledTimes(2);
  });

  it("renames a lodge onto a name another local row has: names may repeat (#69)", async () => {
    const rows = registry([row("ol_1", "Old Name", "c-1"), row("ol_x", "New Name", null)]);
    pull([remoteLodge("New Name", { id: "c-1", bedCapacity: 40 })]);

    const result = await downloadOtherClubsFromServer();

    expect(rows[0]).toMatchObject({ name: "New Name", bedCapacity: 40 });
    expect(rows[1]).toMatchObject({ name: "New Name", centralId: null });
    expect(result).toMatchObject({ updated: 1, renamed: 1, nameConflicts: [] });
  });

  it("creates a second lodge of a name a row keyed to ANOTHER central lodge has, never welding them (#69)", async () => {
    const rows = registry([row("ol_1", "Shared Name", "c-1")]);
    pull([remoteLodge("Shared Name", { id: "c-2" })]);

    const result = await downloadOtherClubsFromServer();

    expect(rows).toEqual([expect.objectContaining({ id: "ol_1", centralId: "c-1" })]);
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ name: "Shared Name", centralId: "c-2" }) }),
    );
    expect(result).toMatchObject({ created: 1, updated: 0, nameConflicts: [] });
  });

  it("never keys a row by name on an INCREMENTAL download: the lodge is new here (#69)", async () => {
    const rows = registry([row("ol_1", "Kea Lodge", null)]);
    pull([remoteLodge("Kea Lodge", { id: "c-1" })]);

    await downloadOtherClubsFromServer();

    // After keying, an unkeyed row is one the server does not list; a lodge
    // that arrives later with its name may be another club's.
    expect(rows[0].centralId).toBeNull();
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ name: "Kea Lodge", centralId: "c-1" }) }),
    );
  });

  it("on a whole download, never takes over a row keyed to another LISTED lodge of the name (#69)", async () => {
    // ol_1 is c-1's row; c-1 was renamed on the server, and a new lodge c-2 now
    // has ol_1's old name. Each name is the pull's only one, yet c-2 is new here.
    const rows = registry([row("ol_1", "Shared Name", "c-1")]);
    mockLoadSettings.mockResolvedValue({ ...SETTINGS, otherLodgesKeyedAt: null });
    pull([remoteLodge("Shared Name", { id: "c-2" }), remoteLodge("Renamed Lodge", { id: "c-1" })]);

    await downloadOtherClubsFromServer();

    expect(rows.find((r) => r.id === "ol_1")).toMatchObject({ centralId: "c-1", name: "Renamed Lodge" });
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ name: "Shared Name", centralId: "c-2" }) }),
    );
  });

  it("still keys by name on a whole download that dropped a row, never twinning unkeyed rows (#69)", async () => {
    const rows = registry([row("ol_1", "Kea Lodge", null)]);
    mockLoadSettings.mockResolvedValue({ ...SETTINGS, otherLodgesKeyedAt: null });
    pull([remoteLodge("Kea Lodge", { id: "c-1" })], { dropped: 1 });

    await downloadOtherClubsFromServer();

    expect(rows[0].centralId).toBe("c-1");
    expect(mockCreate).not.toHaveBeenCalled();
    // Not marked keyed: the dropped row is retried by the next whole download.
    expect(mockRecordOptions).toHaveBeenCalledWith(expect.objectContaining({ keyed: false }));
  });

  it("on a whole download sharing a name, keys our unkeyed row only to OUR lodge (#69)", async () => {
    const rows = registry([row("ol_9", "Kea Lodge", null)]);
    mockLoadSettings.mockResolvedValue({ ...SETTINGS, otherLodgesKeyedAt: null });
    // Another club's "Kea Lodge" first, ours second.
    pull([remoteLodge("Kea Lodge", { id: "c-theirs" }), remoteLodge("Kea Lodge", { id: "c-ours" })], {
      ownLodges: [{ id: "c-ours", name: "Kea Lodge" }],
    });

    await downloadOtherClubsFromServer();

    expect(rows[0].centralId).toBe("c-ours");
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockCreate.mock.calls[0][0].data).toMatchObject({ name: "Kea Lodge", centralId: "c-theirs" });
  });

  it("keys the ONE unkeyed row of a name, and creates a new lodge when two share it (#69)", async () => {
    const one = registry([row("ol_1", "Kea Lodge", null)]);
    mockLoadSettings.mockResolvedValue({ ...SETTINGS, otherLodgesKeyedAt: null });
    pull([remoteLodge("Kea Lodge", { id: "c-1" })]);
    await downloadOtherClubsFromServer();
    expect(one[0].centralId).toBe("c-1");
    expect(mockCreate).not.toHaveBeenCalled();

    vi.clearAllMocks();
    mockLoadSettings.mockResolvedValue({ ...SETTINGS, otherLodgesKeyedAt: null });
    mockCreate.mockResolvedValue({ id: "ol_new" });
    const two = registry([row("ol_1", "Kea Lodge", null), row("ol_2", "Kea Lodge", null)]);
    pull([remoteLodge("Kea Lodge", { id: "c-1" })]);
    const result = await downloadOtherClubsFromServer();
    // Neither can be told to be the lodge: both stay unkeyed, and it is new here.
    expect(two.map((r) => r.centralId)).toEqual([null, null]);
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ name: "Kea Lodge", centralId: "c-1" }) }),
    );
    expect(result.created).toBe(1);
  });

  it("reports, and never creates, a lodge sent WITHOUT an id whose name two local rows share (#69)", async () => {
    const rows = registry([row("ol_1", "Kea Lodge", "c-1"), row("ol_2", "Kea Lodge", "c-2")]);
    pull([remoteLodge("Kea Lodge", { bedCapacity: 50 })]);

    const result = await downloadOtherClubsFromServer();

    // Creating one would add another copy on every pull.
    expect(mockCreate).not.toHaveBeenCalled();
    expect(rows.map((r) => r.bedCapacity)).toEqual([24, 24]);
    expect(result.nameConflicts).toEqual([{ lodge: null, wanted: "Kea Lodge" }]);
  });

  it("creates a new lodge WITH its central id", async () => {
    registry([]);
    pull([remoteLodge("Brand New Lodge", { id: "c-new" })]);

    await downloadOtherClubsFromServer();

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ name: "Brand New Lodge", centralId: "c-new" }),
      }),
    );
  });

  it.each([
    ["no id", {}],
    ["an empty id", { id: "" }],
    ["a padded id", { id: " c-1 " }],
  ])("matches a lodge with %s by name, as before #64", async (_l, over) => {
    const rows = registry([row("ol_1", "Aorangi Ski Club", null)]);
    pull([remoteLodge("Aorangi Ski Club", { ...over, bedCapacity: 50 })]);

    await downloadOtherClubsFromServer();

    expect(rows[0]).toMatchObject({ centralId: null, bedCapacity: 50 });
    expect(mockFindUnique.mock.calls.every(([a]) => a.where.centralId === undefined)).toBe(true);
  });

  it("asks for the WHOLE registry until a whole download has merged, then marks it keyed", async () => {
    registry([]);
    mockLoadSettings.mockResolvedValue({
      ...SETTINGS,
      otherLodgesCursor: "2026-08-14T00:00:00.000Z",
      otherLodgesKeyedAt: null,
    });
    pull([]);

    await downloadOtherClubsFromServer();

    expect(mockPullOtherLodges).toHaveBeenCalledWith(null);
    expect(mockRecordOptions).toHaveBeenCalledWith(expect.objectContaining({ keyed: true }));
  });

  it("does NOT mark the registry keyed when the whole download fails part-way, so the next one repeats it", async () => {
    registry([row("ol_1", "Aorangi Ski Club", null)]);
    mockLoadSettings.mockResolvedValue({ ...SETTINGS, otherLodgesKeyedAt: null });
    mockUpdateMany.mockRejectedValueOnce(new Error("connection lost"));
    pull([remoteLodge("Aorangi Ski Club", { id: "c-1" })]);

    await expect(downloadOtherClubsFromServer()).rejects.toThrow("connection lost");

    expect(mockRecordDownload).not.toHaveBeenCalled();
    expect(mockRecordOptions).not.toHaveBeenCalled();
  });

  it("pulls incrementally once keyed, and does not re-mark it", async () => {
    registry([]);
    mockLoadSettings.mockResolvedValue({ ...SETTINGS, otherLodgesCursor: "c-opaque" });
    pull([]);

    await downloadOtherClubsFromServer();

    expect(mockPullOtherLodges).toHaveBeenCalledWith("c-opaque");
    expect(mockRecordOptions).toHaveBeenCalledWith(expect.objectContaining({ keyed: false }));
  });

  it("renames a THREE-step chain whatever order the pull sends it in (#69: no name is held)", async () => {
    const rows = registry([
      row("ol_1", "A Lodge", "c-1"),
      row("ol_2", "B Lodge", "c-2"),
      row("ol_3", "C Lodge", "c-3"),
    ]);
    // Sorted by the new name, as the server sends it: each blocks the one before.
    pull([
      remoteLodge("B Lodge", { id: "c-1" }),
      remoteLodge("C Lodge", { id: "c-2" }),
      remoteLodge("D Lodge", { id: "c-3" }),
    ]);

    const result = await downloadOtherClubsFromServer();

    expect(rows.map((r) => r.name)).toEqual(["B Lodge", "C Lodge", "D Lodge"]);
    expect(result).toMatchObject({ renamed: 3, nameConflicts: [] });
  });

  it("does not key a row an admin saved since the read, and keeps their edit", async () => {
    const rows = registry([row("ol_9", "Our Lodge", null)]);
    mockLoadSettings.mockResolvedValue({ ...SETTINGS, otherLodgesKeyedAt: null }); // a whole download keys by name (#69)
    const realFind = mockFindUnique.getMockImplementation()!;
    const realFindByName = mockFindByName.getMockImplementation()!;
    let reads = 0;
    // The admin's save lands right after every read of the row, by id or by name.
    const saveAfter = <T,>(found: T) => {
      const hit = Array.isArray(found) ? found.some((r) => r.id === "ol_9") : (found as { id?: string } | null)?.id === "ol_9";
      if (hit && reads++ < 10) {
        rows[0].updatedAt = new Date(rows[0].updatedAt.getTime() + 60_000);
        rows[0].bedCapacity = 99;
      }
      return found;
    };
    mockFindUnique.mockImplementation(async (args: { where: Record<string, string> }) => saveAfter(await realFind(args)));
    mockFindByName.mockImplementation(async (args: { where: { name: string } }) => saveAfter(await realFindByName(args)));
    pull([remoteLodge("Our Lodge", { id: "c-ours" })]);

    await downloadOtherClubsFromServer();

    expect(rows[0].bedCapacity).toBe(99);
    // Never rewound below the admin's stamp.
    expect(rows[0].updatedAt.getTime()).toBeGreaterThan(new Date("2026-08-01T00:00:00.000Z").getTime());
  });

  it("merges by the STORED owned list, and keeps it, when this pull's list was refused", async () => {
    const rows = registry([row("ol_9", "Our New Name", "c-ours")]);
    mockLoadSettings.mockResolvedValue({
      ...SETTINGS,
      otherLodgesOwnedLodges: [{ id: "c-ours", name: "Our Lodge" }],
    });
    pull([remoteLodge("Our Lodge", { id: "c-ours" })], { ownLodges: undefined, ownLodgesRefused: true });

    await downloadOtherClubsFromServer();

    // Still ours: the server's name is not taken.
    expect(rows[0].name).toBe("Our New Name");
    expect(mockRecordDownload).toHaveBeenCalledWith("c-640", undefined);
  });

  it("records the owned list under the settings lock, inside one transaction", async () => {
    registry([]);
    pull([]);

    await downloadOtherClubsFromServer();

    expect(mockLockSettings).toHaveBeenCalledTimes(1);
    expect(mockLockSettings.mock.invocationCallOrder[0]).toBeLessThan(
      mockRecordDownload.mock.invocationCallOrder[0],
    );
  });

  it("re-keys a row whose id a WHOLE download shows is stale, instead of refusing the name", async () => {
    // Keyed by another server's id, which this server's whole registry lacks.
    const rows = registry([row("ol_1", "Aorangi Ski Club", "old-server-7")]);
    mockLoadSettings.mockResolvedValue({ ...SETTINGS, otherLodgesKeyedAt: null });
    pull([remoteLodge("Aorangi Ski Club", { id: "c-1" })]);

    const result = await downloadOtherClubsFromServer();

    expect(rows).toHaveLength(1);
    expect(rows[0].centralId).toBe("c-1");
    expect(result.nameConflicts).toEqual([]);
    expect(mockRecordOptions).toHaveBeenCalledWith(expect.objectContaining({ keyed: true }));
  });

  it("never re-keys a row whose id the whole download DOES list: a new lodge of its name is created (#69)", async () => {
    // A brand-new lodge c-2 has the name of ol_1, which the server lists as c-1.
    const rows = registry([row("ol_1", "Shared Name", "c-1")]);
    mockLoadSettings.mockResolvedValue({ ...SETTINGS, otherLodgesKeyedAt: null });
    pull([remoteLodge("Shared Name", { id: "c-2" }), remoteLodge("Shared Name", { id: "c-1" })]);

    const result = await downloadOtherClubsFromServer();

    expect(rows).toEqual([expect.objectContaining({ id: "ol_1", centralId: "c-1" })]);
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ name: "Shared Name", centralId: "c-2" }) }),
    );
    expect(result.nameConflicts).toEqual([]);
  });

  it("does not mark the registry keyed when the whole download dropped a row", async () => {
    registry([]);
    mockLoadSettings.mockResolvedValue({ ...SETTINGS, otherLodgesKeyedAt: null });
    pull([], { dropped: 1 });

    await downloadOtherClubsFromServer();

    expect(mockRecordOptions).toHaveBeenCalledWith(expect.objectContaining({ keyed: false }));
  });

  it("marks the registry keyed when a new lodge shares a keyed row's name (#69)", async () => {
    registry([row("ol_1", "Shared Name", "c-1")]);
    mockLoadSettings.mockResolvedValue({ ...SETTINGS, otherLodgesKeyedAt: null });
    pull([remoteLodge("Shared Name", { id: "c-2" }), remoteLodge("Shared Name", { id: "c-1" })]);

    await downloadOtherClubsFromServer();

    expect(mockRecordOptions).toHaveBeenCalledWith(expect.objectContaining({ keyed: true }));
  });

  it("does not mark the registry keyed when a pulled lodge carried no usable id", async () => {
    registry([row("ol_1", "Aorangi Ski Club", null)]);
    mockLoadSettings.mockResolvedValue({ ...SETTINGS, otherLodgesKeyedAt: null });
    pull([remoteLodge("Aorangi Ski Club", { id: "" })]);

    await downloadOtherClubsFromServer();

    expect(mockRecordOptions).toHaveBeenCalledWith(expect.objectContaining({ keyed: false }));
  });

  it("never treats an id as stale when the whole download DROPPED a row (it may be that row's)", async () => {
    // ol_X is keyed c-9; c-9's row failed the bounds and was dropped, and a
    // different lodge c-10 now has its old name. Not welded: c-10 is new here.
    const rows = registry([row("ol_X", "Ruapehu Lodge", "c-9")]);
    mockLoadSettings.mockResolvedValue({ ...SETTINGS, otherLodgesKeyedAt: null });
    pull([remoteLodge("Ruapehu Lodge", { id: "c-10" })], { dropped: 1 });

    const result = await downloadOtherClubsFromServer();

    expect(rows[0].centralId).toBe("c-9");
    expect(result).toMatchObject({ created: 1, nameConflicts: [] });
    expect(mockExecuteRaw).not.toHaveBeenCalled();
  });

  it("forgets, on a clean whole download, every central id the server no longer lists", async () => {
    registry([row("ol_1", "Aorangi Ski Club", "c-1")]);
    mockLoadSettings.mockResolvedValue({ ...SETTINGS, otherLodgesKeyedAt: null });
    pull([remoteLodge("Aorangi Ski Club", { id: "c-1" })]);

    await downloadOtherClubsFromServer();

    expect(mockExecuteRaw).toHaveBeenCalledTimes(1);
    const [query] = mockExecuteRaw.mock.calls[0] as [Prisma.Sql];
    expect(query.sql).toBe(
      'UPDATE "OtherLodge" SET "centralId" = NULL WHERE "centralId" IS NOT NULL AND "hiddenAt" IS NULL AND "centralId" NOT IN (?)',
    );
    expect(query.values).toEqual(["c-1"]);
  });

  it("forgets every id when a clean whole download lists no lodge at all", async () => {
    registry([]);
    mockLoadSettings.mockResolvedValue({ ...SETTINGS, otherLodgesKeyedAt: null });
    pull([]);

    await downloadOtherClubsFromServer();

    const [query] = mockExecuteRaw.mock.calls[0] as [Prisma.Sql];
    expect(query.sql).toBe('UPDATE "OtherLodge" SET "centralId" = NULL WHERE "centralId" IS NOT NULL AND "hiddenAt" IS NULL');
    expect(query.values).toEqual([]);
  });

  it("records NOTHING when another download recorded first (its answer is newer)", async () => {
    registry([]);
    mockLoadSettings.mockResolvedValue({ ...SETTINGS, otherLodgesKeyedAt: null, otherLodgesCursor: "c-1" });
    mockSettingsRow.mockResolvedValue({
      baseUrl: SETTINGS.baseUrl,
      otherLodgesCursor: "c-2",
      otherLodgesKeyedAt: new Date("2026-10-14T00:00:00.000Z"),
    });
    pull([]);

    await downloadOtherClubsFromServer();

    expect(mockRecordDownload).not.toHaveBeenCalled();
    expect(mockExecuteRaw).not.toHaveBeenCalled();
  });

  it("forgets nothing on an incremental download", async () => {
    registry([]);
    pull([]);

    await downloadOtherClubsFromServer();

    expect(mockExecuteRaw).not.toHaveBeenCalled();
  });

  it("records NOTHING when the API key was replaced while the download ran", async () => {
    registry([]);
    mockKeyStamp
      .mockResolvedValueOnce("2026-10-01T00:00:00.000Z")
      .mockResolvedValueOnce("2026-10-14T09:00:00.000Z");
    pull([]);

    await downloadOtherClubsFromServer();

    expect(mockRecordDownload).not.toHaveBeenCalled();
    expect(mockLoggerWarn).toHaveBeenCalledWith(expect.stringMatching(/connection changed/i));
  });

  it("retries a create that lost a race for its central id, merging into the row the other writer made", async () => {
    const rows = registry([]);
    mockLoadSettings.mockResolvedValue({ ...SETTINGS, otherLodgesKeyedAt: null }); // a whole download keys by name (#69)
    mockCreate.mockImplementationOnce(async () => {
      rows.push(row("ol_race", "Brand New Lodge", null)); // the other writer's row
      throw new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
        code: "P2002",
        clientVersion: "test",
      });
    });
    pull([remoteLodge("Brand New Lodge", { id: "c-new" })]);

    const result = await downloadOtherClubsFromServer();

    expect(rows).toEqual([expect.objectContaining({ id: "ol_race", centralId: "c-new" })]);
    expect(result.nameConflicts).toEqual([]);
  });

  it("records NOTHING when the server address changed while the download ran", async () => {
    registry([]);
    mockSettingsRow.mockResolvedValue({ baseUrl: "https://other-central.test" });
    pull([]);

    await downloadOtherClubsFromServer();

    expect(mockRecordDownload).not.toHaveBeenCalled();
    expect(mockLoggerWarn).toHaveBeenCalledWith(expect.stringMatching(/connection changed/i));
  });

  it("HIDES a lodge the server deleted, keeping the row, its data and its central id (#58)", async () => {
    const rows = registry([row("ol_1", "Gone Lodge", "c-gone"), row("ol_2", "Kept Lodge", "c-2")]);
    pull([], { deletedLodgeIds: ["c-gone"] });

    const result = await downloadOtherClubsFromServer();

    expect(rows.map((r) => [r.id, r.centralId, Boolean(r.hiddenAt)])).toEqual([
      ["ol_1", "c-gone", true],
      ["ol_2", "c-2", false],
    ]);
    expect(mockDeleteMany).not.toHaveBeenCalled();
    expect(result.hiddenLodges).toEqual(["Gone Lodge"]);
  });

  it("unlinks a club lodge linked to the deleted central lodge (#62)", async () => {
    registry([row("ol_1", "Gone Lodge", "c-gone")]);
    pull([], { deletedLodgeIds: ["c-gone"] });

    await downloadOtherClubsFromServer();

    const unlink = mockExecuteRaw.mock.calls.find(
      ([strings]) => Array.isArray(strings) && (strings as string[]).join("?").startsWith('UPDATE "Lodge"'),
    );
    expect((unlink![0] as string[]).join("?")).toBe(
      'UPDATE "Lodge" SET "centralLodgeId" = NULL WHERE "centralLodgeId" = ?',
    );
    expect(unlink![1]).toBe("c-gone");
  });

  it("does nothing for a deleted lodge this site never had, or already hid", async () => {
    const rows = registry([{ ...row("ol_1", "Old Lodge", "c-1"), hiddenAt: new Date("2026-01-01T00:00:00.000Z") }]);
    pull([], { deletedLodgeIds: ["c-never", "c-1"] });

    const result = await downloadOtherClubsFromServer();

    expect(result.hiddenLodges).toEqual([]);
    expect(rows[0].hiddenAt).toEqual(new Date("2026-01-01T00:00:00.000Z"));
  });

  it("hides NOTHING when the server sends no deletion list (an older server)", async () => {
    const rows = registry([row("ol_1", "Other Lodge", "c-1")]);
    pull([], { deletedLodgeIds: undefined });

    await downloadOtherClubsFromServer();

    expect(rows[0].hiddenAt ?? null).toBeNull();
  });

  it("hides a lodge both changed and deleted in one pull, without merging the change", async () => {
    const rows = registry([row("ol_1", "Busy Lodge", "c-1")]);
    pull([remoteLodge("Busy Lodge", { id: "c-1", bedCapacity: 99 })], { deletedLodgeIds: ["c-1"] });

    await downloadOtherClubsFromServer();

    expect(rows[0]).toMatchObject({ hiddenAt: expect.any(Date), bedCapacity: 24 });
  });

  it("lets a live lodge share a HIDDEN lodge's name, never matching the hidden row (#58)", async () => {
    // Two lodges may share a name; the id tells them apart. The hidden row keeps
    // its name for the bookings that name it, and the new lodge is created.
    const rows = registry([{ ...row("ol_old", "Ruapehu Lodge", null), hiddenAt: new Date("2026-01-01T00:00:00.000Z") }]);
    pull([remoteLodge("Ruapehu Lodge", { id: "c-new" })]);

    const result = await downloadOtherClubsFromServer();

    expect(rows).toEqual([expect.objectContaining({ id: "ol_old", centralId: null })]);
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ name: "Ruapehu Lodge", centralId: "c-new" }) }),
    );
    expect(result).toMatchObject({ created: 1, nameConflicts: [] });
  });

  it("writes one audit record of what the download hid and unlinked", async () => {
    registry([row("ol_1", "Gone Lodge", "c-gone")]);
    pull([], { deletedLodgeIds: ["c-gone"] });

    await downloadOtherClubsFromServer();

    expect(mockAuditCreate).toHaveBeenCalledTimes(1);
    expect(mockAuditCreate.mock.calls[0][0]).toMatchObject({
      action: "alpine_server.other_lodges.hidden",
      category: "lodge",
      details: expect.stringContaining("Gone Lodge"),
    });
  });

  it("unlinks club lodges from the deleted ids again inside the record step (an admin's link in the gap)", async () => {
    registry([row("ol_1", "Gone Lodge", "c-gone")]);
    pull([], { deletedLodgeIds: ["c-gone"] });

    await downloadOtherClubsFromServer();

    const relink = mockExecuteRaw.mock.calls
      .map(([q]) => q as { sql?: string; values?: unknown[] })
      .find((q) => q.sql?.startsWith('UPDATE "Lodge"'));
    expect(relink?.sql).toBe('UPDATE "Lodge" SET "centralLodgeId" = NULL WHERE "centralLodgeId" IN (?)');
    expect(relink?.values).toEqual(["c-gone"]);
    expect(mockExecuteRaw.mock.invocationCallOrder.at(-1)).toBeLessThan(
      mockRecordDownload.mock.invocationCallOrder[0],
    );
  });

  it("writes no audit record when nothing was hidden", async () => {
    registry([row("ol_1", "Other Lodge", "c-1")]);
    pull([], { deletedLodgeIds: ["c-never"] });

    await downloadOtherClubsFromServer();

    expect(mockAuditCreate).not.toHaveBeenCalled();
  });

  it("leaves a hidden row's central id alone when a clean whole download forgets unlisted ids", async () => {
    registry([]);
    mockLoadSettings.mockResolvedValue({ ...SETTINGS, otherLodgesKeyedAt: null });
    pull([]);

    await downloadOtherClubsFromServer();

    const [query] = mockExecuteRaw.mock.calls.at(-1) as [Prisma.Sql];
    expect(query.sql).toContain('"hiddenAt" IS NULL');
  });

});

describe("upload carries the central id (#64, API 2.3)", () => {
  it("sends every row under its `id`, and never an unkeyed one (#69)", async () => {
    mockLoadSettings.mockResolvedValue({ ...SETTINGS, otherLodgesOwnedLodges: [{ id: "c-1", name: "Keyed" }] });
    mockFindMany.mockResolvedValue([
      { ...localCopyOf("ol_1", "2026-08-01T00:00:00.000Z"), name: "Keyed", centralId: "c-1" },
      { ...localCopyOf("ol_2", "2026-08-01T00:00:00.000Z"), name: "Keyed", centralId: null },
    ]);
    mockUploadOtherLodges.mockResolvedValue({
      created: 0,
      updated: 1,
      unchanged: 0,
      skipped: 0,
      results: [{ name: "Keyed", status: "updated" }],
    });

    await uploadOtherClubsToServer();

    const [[items]] = mockUploadOtherLodges.mock.calls;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: "c-1", name: "Keyed" });
    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ select: expect.objectContaining({ centralId: true }) }),
    );
  });
});

describe("upload answers are matched by position and id, never by name (#69, API 2.5)", () => {
  const at = (iso: string) => new Date(iso);
  const twins = () =>
    ownAll([
      { ...localCopyOf("ol_1", "2026-08-10T00:00:00.000Z"), name: "Kea Lodge", centralId: "c-1" },
      { ...localCopyOf("ol_2", "2026-08-14T00:00:00.000Z"), name: "Kea Lodge", centralId: "c-2" },
    ]);
  const answer = (results: unknown[]) => ({ created: 0, updated: 2, unchanged: 0, skipped: 0, results });

  it("holds the watermark below the one of two same-named lodges the server skipped", async () => {
    mockFindMany.mockResolvedValue(twins());
    mockUploadOtherLodges.mockResolvedValue(
      answer([
        { id: "c-1", name: "Kea Lodge", status: "skipped", reason: "deleted" },
        { id: "c-2", name: "Kea Lodge", status: "updated" },
      ]),
    );

    await uploadOtherClubsToServer();

    const [watermark] = mockRecordUpload.mock.calls[0];
    expect(watermark.getTime()).toBeLessThan(at("2026-08-10T00:00:00.000Z").getTime());
  });

  it("orders the read by name and then id, so two lodges of one name go up in a fixed order", async () => {
    ownAll([]);
    mockFindMany.mockResolvedValue([]);
    await uploadOtherClubsToServer();
    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: [{ name: "asc" }, { id: "asc" }] }),
    );
  });

  it.each([
    ["fewer answers than items", [{ id: "c-1", name: "Kea Lodge", status: "updated" }]],
    [
      "more answers than items",
      [
        { id: "c-1", name: "Kea Lodge", status: "updated" },
        { id: "c-2", name: "Kea Lodge", status: "updated" },
        { id: "c-3", name: "Kea Lodge", status: "skipped", reason: "deleted" },
      ],
    ],
    [
      "an answer under another lodge's id",
      [
        { id: "c-2", name: "Kea Lodge", status: "updated" },
        { id: "c-1", name: "Kea Lodge", status: "updated" },
      ],
    ],
    [
      "an answer under another name",
      [
        { id: "c-1", name: "Kea Lodge", status: "updated" },
        { id: "c-2", name: "Tasman Lodge", status: "updated" },
      ],
    ],
  ])("accepts nothing and says so when the answer does not line up: %s", async (_l, results) => {
    mockFindMany.mockResolvedValue(twins());
    mockUploadOtherLodges.mockResolvedValue(answer(results));

    await uploadOtherClubsToServer();

    expect(mockRecordUpload).not.toHaveBeenCalled();
    expect(mockLoggerWarn).toHaveBeenCalledWith(expect.stringMatching(/did not line up/i));
  });

  it("uploads only the owned one of two lodges sharing a name: by central id", async () => {
    const rows = twins();
    mockLoadSettings.mockResolvedValue({ ...SETTINGS, otherLodgesOwnedLodges: [{ id: "c-2", name: "Kea Lodge" }] });
    mockFindMany.mockResolvedValue(rows);
    mockUploadOtherLodges.mockResolvedValue(answer([{ id: "c-2", name: "Kea Lodge", status: "updated" }]));

    await uploadOtherClubsToServer();

    const [[items]] = mockUploadOtherLodges.mock.calls;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: "c-2", name: "Kea Lodge" });
  });
});
