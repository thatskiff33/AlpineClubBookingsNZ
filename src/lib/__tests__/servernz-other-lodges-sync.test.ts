import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks ──────────────────────────────────────────────────────────────────

const mockFindMany = vi.fn();
const mockFindUnique = vi.fn();
const mockUpsert = vi.fn();
const mockUpdate = vi.fn();

vi.mock("@/lib/prisma", () => ({
  prisma: {
    otherLodge: {
      findMany: (...args: unknown[]) => mockFindMany(...args),
      findUnique: (...args: unknown[]) => mockFindUnique(...args),
      upsert: (...args: unknown[]) => mockUpsert(...args),
      update: (...args: unknown[]) => mockUpdate(...args),
    },
  },
}));

const mockUploadOtherLodges = vi.fn();
const mockPullOtherLodges = vi.fn();

vi.mock("@/lib/servernz-api", () => ({
  uploadOtherLodges: (...args: unknown[]) => mockUploadOtherLodges(...args),
  pullOtherLodges: (...args: unknown[]) => mockPullOtherLodges(...args),
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
};

/** A row as the central server sends it. */
const REMOTE_UPDATED_AT = "2026-08-14T00:00:00.000Z";

function remoteLodge(name: string, over: Record<string, unknown> = {}) {
  return {
    name,
    updatedAt: REMOTE_UPDATED_AT,
    location: "Whakapapa",
    bookingOfficerName: "Ann Officer",
    bookingOfficerEmail: "bookings@club.test",
    bookingOfficerPhone: "+64 27 422 4115",
    bedCapacity: 24,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockLoadSettings.mockResolvedValue({ ...SETTINGS });
  mockUpsert.mockResolvedValue({});
  mockUpdate.mockResolvedValue({});
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
      { ...remoteLodge("Aorangi Ski Club"), updatedAt: older },
      { ...remoteLodge("Arlberg Ski Club"), updatedAt: newer },
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
    expect(mockRecordDownload).toHaveBeenCalledWith("c-200");
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

    expect(mockUpsert).toHaveBeenCalledWith({
      where: { name: "Ngauruhoe Ski Club" },
      create: expect.objectContaining({ name: "Ngauruhoe Ski Club", bedCapacity: 24 }),
      update: expect.objectContaining({ bedCapacity: 24 }),
    });
    expect(result.created).toBe(1);
  });

  it("writes a row whose data differs", async () => {
    mockPullOtherLodges.mockResolvedValue({
      lodges: [remoteLodge("Aorangi Ski Club", { bedCapacity: 30 })],
      count: 1,
      cursor: "c-202",
      dropped: 0,
    });
    mockFindUnique.mockResolvedValue({
      id: "ol_1",
      updatedAt: new Date("2026-08-01T00:00:00.000Z"),
      location: "Whakapapa",
      bookingOfficerName: "Ann Officer",
      bookingOfficerEmail: "bookings@club.test",
      bookingOfficerPhone: "+64 27 422 4115",
      bedCapacity: 24,
    });

    const result = await downloadOtherClubsFromServer();

    expect(mockUpdate).toHaveBeenCalledWith({
      where: { id: "ol_1" },
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
    mockFindUnique.mockResolvedValue({
      id: "ol_2",
      updatedAt: new Date("2026-08-01T00:00:00.000Z"),
      location: "Whakapapa",
      bookingOfficerName: "Ann Officer",
      bookingOfficerEmail: "bookings@club.test",
      bookingOfficerPhone: "+64 27 422 4115",
      bedCapacity: 24,
    });

    const result = await downloadOtherClubsFromServer();

    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockUpsert).not.toHaveBeenCalled();
    expect(result).toMatchObject({ created: 0, updated: 0, unchanged: 1 });
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
    mockFindUnique.mockResolvedValue({
      id: "ol_1",
      updatedAt: new Date("2026-08-01T00:00:00.000Z"),
      location: "Whakapapa",
      bookingOfficerName: "Ann Officer",
      bookingOfficerEmail: "bookings@club.test",
      bookingOfficerPhone: "+64 27 422 4115",
      bedCapacity: 24,
    });

    await downloadOtherClubsFromServer();

    expect(mockUpdate).toHaveBeenCalledWith({
      where: { id: "ol_1" },
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
    mockFindUnique.mockResolvedValue({
      id: "ol_1",
      // Edited locally AFTER the timestamp the server is reporting.
      updatedAt: new Date("2026-08-20T00:00:00.000Z"),
      location: "Whakapapa",
      bookingOfficerName: "Ann Officer",
      bookingOfficerEmail: "bookings@club.test",
      bookingOfficerPhone: "+64 27 422 4115",
      bedCapacity: 24,
    });

    const result = await downloadOtherClubsFromServer();

    expect(mockUpdate).not.toHaveBeenCalled();
    expect(result).toMatchObject({ updated: 0, keptLocal: 1 });
  });

  it("holds the upload watermark below a row the server rejected", async () => {
    // Advancing past a skipped row is how a rejection becomes permanent: it is
    // never re-sent, so it silently never reaches the registry (INV-INT-004).
    const rejected = new Date("2026-08-10T00:00:00.000Z");
    const accepted = new Date("2026-08-14T00:00:00.000Z");
    mockFindMany.mockResolvedValue([
      { ...remoteLodge("Rejected Club"), updatedAt: rejected },
      { ...remoteLodge("Accepted Club"), updatedAt: accepted },
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
    mockFindMany.mockResolvedValue([{ ...remoteLodge("Rejected Club"), updatedAt: only }]);
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

/** A local row identical to `remoteLodge()`, as the overlap re-delivers it. */
function localCopyOf(id: string, updatedAt: string) {
  return {
    id,
    updatedAt: new Date(updatedAt),
    location: "Whakapapa",
    bookingOfficerName: "Ann Officer",
    bookingOfficerEmail: "bookings@club.test",
    bookingOfficerPhone: "+64 27 422 4115",
    bedCapacity: 24,
  };
}

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
      // Year boundary, and a non-UTC offset the server is free to send.
      ["2027-01-01T13:00:00+13:00", "2026-12-31T23:59:00.000Z"],
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
    expect(mockRecordDownload).toHaveBeenCalledWith("2026-06-21T09:00:00.000Z");
    expect(mockRecordDownload).not.toHaveBeenCalledWith("2026-06-20T10:04:30.000Z");
    expect(mockRecordDownload).not.toHaveBeenCalledWith(stored);
  });

  it("counts a row the overlap re-delivers unchanged as unchanged, not as a change", async () => {
    mockLoadSettings.mockResolvedValue({
      ...SETTINGS,
      otherLodgesCursor: "2026-06-20T10:05:30.000Z",
    });
    mockPullOtherLodges.mockResolvedValue({
      // The first row is the repeat the overlap deliberately re-fetched; the
      // second is the genuine change the pull was for.
      lodges: [remoteLodge("Aorangi Ski Club"), remoteLodge("Arlberg Ski Club", { bedCapacity: 30 })],
      count: 2,
      cursor: "2026-06-21T00:00:00.000Z",
      dropped: 0,
    });
    mockFindUnique
      .mockResolvedValueOnce(localCopyOf("ol_1", "2026-06-19T00:00:00.000Z"))
      .mockResolvedValueOnce(localCopyOf("ol_2", "2026-06-19T00:00:00.000Z"));

    const result = await downloadOtherClubsFromServer();

    // One write, for the one row that actually differed. An inflated `updated`
    // here would make every overlapped pull look like a burst of remote edits.
    expect(mockUpdate).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ fetched: 2, created: 0, updated: 1, unchanged: 1, keptLocal: 0 });
  });

  it("still refuses an overlapped remote row that is older than the local copy", async () => {
    mockLoadSettings.mockResolvedValue({
      ...SETTINGS,
      otherLodgesCursor: "2026-06-20T10:05:30.000Z",
    });
    mockPullOtherLodges.mockResolvedValue({
      lodges: [remoteLodge("Aorangi Ski Club", { bedCapacity: 30 })],
      count: 1,
      cursor: "2026-06-21T00:00:00.000Z",
      dropped: 0,
    });
    // Corrected locally after the server's copy — the overlap re-offering that
    // older copy must not become a way to undo the club's own edit.
    mockFindUnique.mockResolvedValue(localCopyOf("ol_1", "2026-08-20T00:00:00.000Z"));

    const result = await downloadOtherClubsFromServer();

    expect(mockPullOtherLodges).toHaveBeenCalledWith("2026-06-20T10:04:30.000Z");
    expect(mockUpdate).not.toHaveBeenCalled();
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
    expect(mockRecordDownload).toHaveBeenCalledWith("2026-06-21T00:00:00.000Z");
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
    mockUpdate.mockRejectedValue(new Error("write failed"));

    await expect(downloadOtherClubsFromServer()).rejects.toThrow("write failed");
    expect(mockRecordDownload).not.toHaveBeenCalled();
  });
});
