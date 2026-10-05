import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks ──────────────────────────────────────────────────────────────────

const mockFindMany = vi.fn();
const mockFindUnique = vi.fn();
const mockUpsert = vi.fn();
const mockUpdateMany = vi.fn();
const mockAmenityDeleteMany = vi.fn();
const mockAmenityUpsert = vi.fn();

vi.mock("@/lib/prisma", () => {
  // The interactive transaction hands the same fake back as `tx`, so a write
  // made inside one is observable through the same mocks as one made outside.
  const prisma = {
    otherLodge: {
      findMany: (...args: unknown[]) => mockFindMany(...args),
      findUnique: (...args: unknown[]) => mockFindUnique(...args),
      upsert: (...args: unknown[]) => mockUpsert(...args),
      updateMany: (...args: unknown[]) => mockUpdateMany(...args),
    },
    amenity: {
      deleteMany: (...args: unknown[]) => mockAmenityDeleteMany(...args),
      upsert: (...args: unknown[]) => mockAmenityUpsert(...args),
    },
    $transaction: (fn: (tx: unknown) => Promise<unknown>) => fn(prisma),
  };
  return { prisma };
});

const mockUploadOtherLodges = vi.fn();
const mockPullOtherLodges = vi.fn();

vi.mock("@/lib/servernz-api", () => ({
  uploadOtherLodges: (...args: unknown[]) => mockUploadOtherLodges(...args),
  pullOtherLodges: (...args: unknown[]) => mockPullOtherLodges(...args),
}));

const mockLoggerWarn = vi.fn();

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

vi.mock("@/lib/servernz-settings", () => ({
  loadServerNzSettings: (...args: unknown[]) => mockLoadSettings(...args),
  recordOtherLodgesUpload: (...args: unknown[]) => mockRecordUpload(...args),
  recordOtherLodgesDownload: (...args: unknown[]) => mockRecordDownload(...args),
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
  // Unknown until a download from a server that sends the list records it (#52).
  otherLodgesOwnedNames: null as string[] | null,
  otherLodgesOwnedNamesAt: null as string | null,
};

/** A row as the central server sends it. */
const REMOTE_UPDATED_AT = "2026-08-14T00:00:00.000Z";

/** The #50 detail fields as they travel: dates as `YYYY-MM-DD`, no amenities. */
const WIRE_DETAILS = {
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
};

/** The same details as Prisma reads them: `@db.Date` columns as UTC midnight. */
const LOCAL_DETAILS = {
  ...WIRE_DETAILS,
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
    amenities: AMENITIES,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockLoadSettings.mockResolvedValue({ ...SETTINGS });
  mockUpsert.mockResolvedValue({ id: "ol_new" });
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
    mockFindMany.mockResolvedValue([
      { ...localCopyOf("ol_1", older.toISOString()), name: "Aorangi Ski Club" },
      { ...localCopyOf("ol_2", newer.toISOString()), name: "Arlberg Ski Club" },
    ]);
    mockUploadOtherLodges.mockResolvedValue({
      created: 1,
      updated: 1,
      unchanged: 0,
      skipped: 0,
      results: [],
    });

    const result = await uploadOtherClubsToServer();

    // Incremental: the query is bounded by the stored watermark, not the whole table.
    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { updatedAt: { gt: new Date("2026-07-01T00:00:00.000Z") } },
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
      dropped: 0,
    });
  });

  it("upserts a row it has not seen, so a concurrent writer cannot break the merge", async () => {
    // The read-then-write is not atomic: an admin pressing Download while the
    // 03:00 cron runs can insert the same unique `name` in the gap. A plain
    // create would raise P2002 and abandon the merge before the cursor advanced.
    mockPullOtherLodges.mockResolvedValue({
      lodges: [remoteLodge("Ngauruhoe Ski Club")],
      count: 1,
      cursor: "c-201",
      dropped: 0,
    });
    mockFindUnique.mockResolvedValue(null);

    const result = await downloadOtherClubsFromServer();

    expect(mockUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { name: "Ngauruhoe Ski Club" },
        create: expect.objectContaining({ name: "Ngauruhoe Ski Club", bedCapacity: 24 }),
        update: expect.objectContaining({ bedCapacity: 24 }),
      }),
    );
    // The amenity set rides in the same transaction, keyed on the upserted id —
    // so the loser of the name race converges on the same set as the winner.
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
      where: { id: "ol_1", updatedAt: new Date("2026-08-01T00:00:00.000Z") },
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
    expect(mockUpsert).not.toHaveBeenCalled();
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
    mockFindMany.mockResolvedValue([
      {
        ...localCopyOf("ol_1", "2026-08-14T00:00:00.000Z"),
        name: "Aorangi Ski Club",
      },
    ]);
    mockUploadOtherLodges.mockResolvedValue({
      created: 0,
      updated: 1,
      unchanged: 0,
      skipped: 0,
      results: [],
    });

    await uploadOtherClubsToServer();

    expect(mockUploadOtherLodges).toHaveBeenCalledWith([
      {
        name: "Aorangi Ski Club",
        location: "Whakapapa",
        bookingOfficerName: "Ann Officer",
        bookingOfficerEmail: "bookings@club.test",
        bookingOfficerPhone: "+64 27 422 4115",
        bedCapacity: 24,
        ...WIRE_DETAILS,
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
      bookingPath: null,
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
      where: { id: "ol_1", updatedAt: new Date("2026-08-01T00:00:00.000Z") },
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
      where: { id: "ol_1", updatedAt: new Date("2026-08-01T00:00:00.000Z") },
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
        where: { id: "ol_1", updatedAt: new Date("2026-08-01T00:00:00.000Z") },
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
      where: { id: "ol_1", updatedAt: new Date("2026-08-01T00:00:00.000Z") },
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
    mockFindMany.mockResolvedValue([
      { ...localCopyOf("ol_1", rejected.toISOString()), name: "Rejected Club" },
      { ...localCopyOf("ol_2", accepted.toISOString()), name: "Accepted Club" },
    ]);
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
    mockFindMany.mockResolvedValue([
      { ...localCopyOf("ol_1", only.toISOString()), name: "Rejected Club" },
    ]);
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
// The central server says which lodges this club owns (`ownLodgeNames` on every
// pull). The download records that list, and the upload sends ONLY those lodges
// once it is known — through the one `ownsOtherLodge` rule the admin PATCH
// route also applies. Before this, every row a download had just written
// (server-stamped, so above the watermark) went straight back up each night for
// the server to refuse (#53).

describe("own lodges only (#52)", () => {
  const ACCEPTED = { created: 0, updated: 1, unchanged: 0, skipped: 0, results: [] };

  it("records the owned list the pull carried, with the cursor, after the merge", async () => {
    mockPullOtherLodges.mockResolvedValue({
      lodges: [],
      count: 0,
      cursor: "c-500",
      dropped: 0,
      ownLodgeNames: ["Aorangi Ski Club"],
    });

    await downloadOtherClubsFromServer();

    expect(mockRecordDownload).toHaveBeenCalledWith("c-500", ["Aorangi Ski Club"]);
  });

  it("records an EMPTY owned list as an answer, not as an omission", async () => {
    mockPullOtherLodges.mockResolvedValue({
      lodges: [],
      count: 0,
      cursor: "c-501",
      dropped: 0,
      ownLodgeNames: [],
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
      ownLodgeNames: undefined,
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
      ownLodgeNames: ["Aorangi Ski Club"],
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
      otherLodgesOwnedNames: ["Aorangi Ski Club"],
    });
    mockFindMany.mockResolvedValue([
      { ...localCopyOf("ol_1", ours.toISOString()), name: "Aorangi Ski Club" },
      // Another club's lodge, freshly downloaded and server-stamped NEWER than
      // ours: before #52 this row went up every night (#53).
      { ...localCopyOf("ol_2", theirs.toISOString()), name: "Arlberg Ski Club" },
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
    mockLoadSettings.mockResolvedValue({ ...SETTINGS, otherLodgesOwnedNames: [] });
    mockFindMany.mockResolvedValue([
      { ...localCopyOf("ol_2", "2026-08-14T00:00:00.000Z"), name: "Arlberg Ski Club" },
    ]);

    const result = await uploadOtherClubsToServer();

    expect(mockUploadOtherLodges).not.toHaveBeenCalled();
    expect(mockRecordUpload).not.toHaveBeenCalled();
    expect(result.sent).toBe(0);
  });

  it("keeps sending every changed row while the list is UNKNOWN", async () => {
    // Not connected to a server that sends the list yet: pre-#52 behaviour, so
    // a club on an older central server loses nothing.
    mockLoadSettings.mockResolvedValue({ ...SETTINGS, otherLodgesOwnedNames: null });
    mockFindMany.mockResolvedValue([
      { ...localCopyOf("ol_1", "2026-08-10T00:00:00.000Z"), name: "Aorangi Ski Club" },
      { ...localCopyOf("ol_2", "2026-08-14T00:00:00.000Z"), name: "Arlberg Ski Club" },
    ]);
    mockUploadOtherLodges.mockResolvedValue({ ...ACCEPTED, updated: 2 });

    const result = await uploadOtherClubsToServer();

    const [sent] = mockUploadOtherLodges.mock.calls[0];
    expect(sent.map((l: { name: string }) => l.name)).toEqual([
      "Aorangi Ski Club",
      "Arlberg Ski Club",
    ]);
    expect(result.sent).toBe(2);
  });

  it("matches ownership by exact name, as the registry and the server key it", async () => {
    mockLoadSettings.mockResolvedValue({
      ...SETTINGS,
      otherLodgesOwnedNames: ["aorangi ski club"],
    });
    mockFindMany.mockResolvedValue([
      { ...localCopyOf("ol_1", "2026-08-10T00:00:00.000Z"), name: "Aorangi Ski Club" },
    ]);

    await uploadOtherClubsToServer();

    expect(mockUploadOtherLodges).not.toHaveBeenCalled();
  });
});
