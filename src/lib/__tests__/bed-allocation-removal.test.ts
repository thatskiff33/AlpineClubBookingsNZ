import { beforeEach, describe, expect, it, vi } from "vitest";

const { auditMock, capacityLockMock, prismaMock } = vi.hoisted(() => ({
  auditMock: vi.fn(),
  capacityLockMock: vi.fn(),
  prismaMock: {
    bedAllocation: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      deleteMany: vi.fn(),
      updateMany: vi.fn(),
    },
    booking: { findUnique: vi.fn() },
    lodge: { findUnique: vi.fn() },
    $executeRaw: vi.fn(),
    $transaction: vi.fn(),
  },
}));

vi.mock("@/lib/audit", () => ({ createAuditLog: auditMock }));
vi.mock("@/lib/capacity", () => ({
  acquireLodgeCapacityLock: capacityLockMock,
}));
vi.mock("@/lib/prisma", () => ({ prisma: prismaMock }));

import {
  applyBedAllocationRemoval,
  BED_ALLOCATION_REMOVAL_QUERY_CHUNK_SIZE,
  BedAllocationRemovalError,
  chunkBedAllocationRemovalIds,
  previewBedAllocationRemoval,
  type BedAllocationRemovalCategory,
  type BedAllocationRemovalRequest,
} from "@/lib/bed-allocation-removal";
import { matchesWhere } from "@/lib/__tests__/support/prisma-where";

type Row = ReturnType<typeof row>;

function row(input: {
  id: string;
  source?: "AUTO" | "MANUAL";
  approved?: boolean;
  bookingId?: string;
  bookingGuestId?: string;
  bedId?: string;
  second?: boolean;
  stayDate?: string;
  lodgeId?: string;
}) {
  const bookingId = input.bookingId ?? "booking-1";
  const bookingGuestId = input.bookingGuestId ?? "guest-1";
  const lodgeId = input.lodgeId ?? "lodge-1";
  return {
    id: input.id,
    bookingId,
    bookingGuestId,
    roomId: `room-${lodgeId}`,
    bedId: input.bedId ?? `bed-${input.id}`,
    stayDate: new Date(`${input.stayDate ?? "2026-08-01"}T00:00:00.000Z`),
    source: input.source ?? "AUTO",
    approvedAt: input.approved ? new Date("2026-07-15T00:00:00.000Z") : null,
    approvedByMemberId: input.approved ? "approver-1" : null,
    isSecondOccupant: input.second ?? false,
    bedType: "DOUBLE",
    createdAt: new Date("2026-07-01T00:00:00.000Z"),
    updatedAt: new Date("2026-07-02T00:00:00.000Z"),
    room: {
      lodgeId,
      name: `Room ${lodgeId}`,
      lodge: { name: `Lodge ${lodgeId}` },
    },
    bed: { name: `Bed ${input.id}` },
    bookingGuest: { firstName: `Guest`, lastName: input.id },
    booking: {
      member: { firstName: "Booking", lastName: bookingId },
    },
  };
}

function installRows(rows: Row[]) {
  prismaMock.bedAllocation.findUnique.mockImplementation(
    async ({ where }: { where: { id: string } }) =>
      rows.find((candidate) => candidate.id === where.id) ?? null,
  );
  prismaMock.bedAllocation.findFirst.mockImplementation(
    async ({ where }: { where: Record<string, unknown> }) =>
      rows
        .filter((candidate) => matchesWhere(candidate, where))
        .sort((a, b) => a.id.localeCompare(b.id))[0] ?? null,
  );
  prismaMock.bedAllocation.findMany.mockImplementation(
    async (args: { where?: Record<string, unknown>; select?: unknown }) => {
      const found = rows.filter((candidate) =>
        args.where ? matchesWhere(candidate, args.where) : true,
      );
      if (args.select) {
        if ((args.select as { room?: unknown }).room) {
          return found.map((candidate) => ({
            room: { lodgeId: candidate.room.lodgeId },
          }));
        }
      }
      return found;
    },
  );
  prismaMock.lodge.findUnique.mockImplementation(
    async ({ where }: { where: { id: string } }) => ({ name: `Lodge ${where.id}` }),
  );
  prismaMock.bedAllocation.deleteMany.mockImplementation(
    async ({ where }: { where: Record<string, unknown> }) => {
      const before = rows.length;
      const kept = rows.filter((candidate) => !matchesWhere(candidate, where));
      rows.splice(0, rows.length, ...kept);
      return { count: before - rows.length };
    },
  );
  prismaMock.bedAllocation.updateMany.mockImplementation(
    async ({ where }: { where: Record<string, unknown> }) => {
      const found = rows.filter((candidate) => matchesWhere(candidate, where));
      for (const candidate of found) candidate.isSecondOccupant = false;
      return { count: found.length };
    },
  );
}

function anchorScope(type: "ALLOCATION" | "BOOKING_GUEST" | "BOOKING") {
  return {
    type,
    allocationId: "auto",
    bookingId: "booking-1",
    bookingGuestId: "guest-1",
    lodgeId: "lodge-1",
    stayDate: "2026-08-01",
  } as const;
}

describe("bed allocation removal preview/apply", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    auditMock.mockResolvedValue(undefined);
    capacityLockMock.mockResolvedValue(undefined);
    prismaMock.$executeRaw.mockResolvedValue(0);
    prismaMock.$transaction.mockImplementation(
      async (callback: (tx: typeof prismaMock) => unknown) => callback(prismaMock),
    );
    prismaMock.booking.findUnique.mockResolvedValue({ lodgeId: "lodge-1" });
  });

  it("chunks more than PostgreSQL's 65,535 bind parameters in sorted order", () => {
    const ids = Array.from(
      { length: 65_536 },
      (_, index) => `allocation-${String(65_535 - index).padStart(5, "0")}`,
    );
    const chunks = chunkBedAllocationRemovalIds([ids[0], ...ids, ids[0]]);

    expect(Math.max(...chunks.map((chunk) => chunk.length))).toBe(
      BED_ALLOCATION_REMOVAL_QUERY_CHUNK_SIZE,
    );
    expect(chunks.flat()).toEqual([...new Set(ids)].sort());
  });

  const categories: Array<[BedAllocationRemovalCategory, string]> = [
    ["AUTO_DRAFT", "auto"],
    ["MANUAL_DRAFT", "manual"],
    ["APPROVED", "approved"],
  ];
  const scopes = ["ALLOCATION", "BOOKING_GUEST", "BOOKING", "WINDOW"] as const;

  for (const scopeType of scopes) {
    for (const [category, expectedId] of categories) {
      it(`previews ${scopeType} with ${category}`, async () => {
        const rows = [
          row({ id: "auto" }),
          row({ id: "manual", source: "MANUAL" }),
          row({ id: "approved", approved: true }),
        ];
        installRows(rows);
        const scope =
          scopeType === "WINDOW"
            ? {
                type: "WINDOW" as const,
                lodgeId: "lodge-1",
                from: "2026-08-01",
                to: "2026-08-02",
              }
            : anchorScope(scopeType);
        const preview = await previewBedAllocationRemoval({
          scope,
          categories: [category],
        });
        expect(preview.matchedRowCount).toBe(scopeType === "ALLOCATION" && expectedId !== "auto" ? 0 : 1);
        if (preview.matchedRowCount) {
          expect(preview.categories[category]).toBe(1);
        }
      });
    }
  }

  it("keeps booking scopes off-window while WINDOW stays lodge/window bounded", async () => {
    const rows = [
      row({ id: "auto" }),
      row({ id: "guest-off-window", stayDate: "2026-10-01" }),
      row({
        id: "other-guest-off-window",
        bookingGuestId: "guest-2",
        stayDate: "2026-10-02",
      }),
      row({ id: "other-booking-in-window", bookingId: "booking-2" }),
      row({
        id: "other-lodge-in-window",
        bookingId: "booking-3",
        lodgeId: "lodge-2",
      }),
    ];
    installRows(rows);

    const bookingGuest = await previewBedAllocationRemoval({
      scope: anchorScope("BOOKING_GUEST"),
      categories: ["AUTO_DRAFT"],
    });
    expect(bookingGuest.matchedRowCount).toBe(2);
    expect(bookingGuest.affectedNights).toEqual([
      "2026-08-01",
      "2026-10-01",
    ]);

    const booking = await previewBedAllocationRemoval({
      scope: anchorScope("BOOKING"),
      categories: ["AUTO_DRAFT"],
    });
    expect(booking.matchedRowCount).toBe(3);
    expect(booking.affectedNights).toEqual([
      "2026-08-01",
      "2026-10-01",
      "2026-10-02",
    ]);

    const window = await previewBedAllocationRemoval({
      scope: {
        type: "WINDOW",
        lodgeId: "lodge-1",
        from: "2026-08-01",
        to: "2026-08-02",
      },
      categories: ["AUTO_DRAFT"],
    });
    expect(window.matchedRowCount).toBe(2);
    expect(window.affectedBookingCount).toBe(2);
    expect(window.affectedNights).toEqual(["2026-08-01"]);
  });

  it("supports a mutually exclusive multi-category preview", async () => {
    const rows = [
      row({ id: "auto" }),
      row({ id: "manual", source: "MANUAL" }),
      row({ id: "approved", approved: true }),
    ];
    installRows(rows);
    const preview = await previewBedAllocationRemoval({
      scope: anchorScope("BOOKING"),
      categories: ["AUTO_DRAFT", "MANUAL_DRAFT", "APPROVED"],
    });
    expect(preview.categories).toEqual({
      AUTO_DRAFT: 1,
      MANUAL_DRAFT: 1,
      APPROVED: 1,
    });
    expect(preview.matchedRowCount).toBe(3);
  });

  it.each([
    {
      name: "scope",
      mutate: (request: BedAllocationRemovalRequest) => ({
        ...request,
        scope: anchorScope("BOOKING"),
      }),
    },
    {
      name: "categories",
      mutate: (request: BedAllocationRemovalRequest) => ({
        ...request,
        categories: ["AUTO_DRAFT", "MANUAL_DRAFT"] as BedAllocationRemovalCategory[],
      }),
    },
  ])("binds the digest to the reviewed $name even when rows are identical", async ({ mutate }) => {
    const rows = [row({ id: "auto" })];
    installRows(rows);
    const request: BedAllocationRemovalRequest = {
      scope: anchorScope("ALLOCATION"),
      categories: ["AUTO_DRAFT"],
    };
    const preview = await previewBedAllocationRemoval(request);
    await expect(
      applyBedAllocationRemoval({
        request: { ...mutate(request), previewDigest: preview.digest },
        actorMemberId: "admin-1",
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(prismaMock.bedAllocation.deleteMany).not.toHaveBeenCalled();
  });

  it("returns a refreshed zero-match preview when an apply anchor disappeared", async () => {
    const rows = [row({ id: "auto" })];
    installRows(rows);
    const request: BedAllocationRemovalRequest = {
      scope: anchorScope("ALLOCATION"),
      categories: ["AUTO_DRAFT"],
    };
    const preview = await previewBedAllocationRemoval(request);
    rows.splice(0, rows.length);

    await expect(
      applyBedAllocationRemoval({
        request: { ...request, previewDigest: preview.digest },
        actorMemberId: "admin-1",
      }),
    ).rejects.toMatchObject({
      status: 409,
      refreshedPreview: { matchedRowCount: 0 },
    });
    expect(prismaMock.bedAllocation.deleteMany).not.toHaveBeenCalled();
    expect(auditMock).not.toHaveBeenCalled();
  });

  it.each(["BOOKING_GUEST", "BOOKING"] as const)(
    "re-anchors a stale %s preview to a deterministic surviving row",
    async (scopeType) => {
      const rows = [
        row({ id: "auto" }),
        // Sorts before the selected-category survivor, proving re-anchoring
        // cannot silently choose a row from a category the admin disabled.
        row({ id: "a-disabled", source: "MANUAL" }),
        row({
          id: "survivor",
          bookingGuestId:
            scopeType === "BOOKING_GUEST" ? "guest-1" : "guest-2",
          stayDate: "2026-08-02",
        }),
      ];
      installRows(rows);
      const request: BedAllocationRemovalRequest = {
        scope: anchorScope(scopeType),
        categories: ["AUTO_DRAFT"],
      };
      const preview = await previewBedAllocationRemoval(request);
      rows.splice(
        rows.findIndex((candidate) => candidate.id === "auto"),
        1,
      );

      const firstError = (await applyBedAllocationRemoval({
        request: { ...request, previewDigest: preview.digest },
        actorMemberId: "admin-1",
      }).catch((error: unknown) => error)) as BedAllocationRemovalError;

      expect(firstError).toMatchObject({
        status: 409,
        refreshedPreview: {
          matchedRowCount: 1,
          scope: {
            type: scopeType,
            allocationId: "survivor",
            stayDate: "2026-08-02",
          },
        },
      });
      expect(prismaMock.bedAllocation.deleteMany).not.toHaveBeenCalled();
      expect(auditMock).not.toHaveBeenCalled();

      const refreshedPreview = firstError.refreshedPreview!;
      await expect(
        applyBedAllocationRemoval({
          request: {
            scope: refreshedPreview.scope,
            categories: request.categories,
            previewDigest: refreshedPreview.digest,
          },
          actorMemberId: "admin-1",
        }),
      ).resolves.toMatchObject({ removedRowCount: 1 });
      expect(rows.map((candidate) => candidate.id)).toEqual(["a-disabled"]);
      expect(auditMock).toHaveBeenCalledTimes(1);
    },
  );

  it("locks canonical plus reviewed lodges and rejects an unlocked third-lodge anomaly", async () => {
    const rows = [
      row({ id: "auto", lodgeId: "lodge-z" }),
      row({ id: "historical", lodgeId: "lodge-m", stayDate: "2026-08-02" }),
    ];
    installRows(rows);
    prismaMock.booking.findUnique.mockResolvedValue({ lodgeId: "lodge-a" });
    const request: BedAllocationRemovalRequest = {
      scope: {
        ...anchorScope("BOOKING"),
        lodgeId: "lodge-z",
      },
      categories: ["AUTO_DRAFT"],
    };
    const preview = await previewBedAllocationRemoval(request);

    await expect(
      applyBedAllocationRemoval({
        request: { ...request, previewDigest: preview.digest },
        actorMemberId: "admin-1",
      }),
    ).rejects.toMatchObject({
      status: 409,
      refreshedPreview: { matchedRowCount: 2 },
    });
    expect(capacityLockMock.mock.calls.map((call) => call[1])).toEqual([
      "lodge-a",
      "lodge-z",
    ]);
    expect(prismaMock.bedAllocation.deleteMany).not.toHaveBeenCalled();
    expect(auditMock).not.toHaveBeenCalled();
  });

  it("keeps a moved anchor's lodge/night tuple as an intent fence", async () => {
    const rows = [row({ id: "auto" })];
    installRows(rows);
    const request: BedAllocationRemovalRequest = {
      scope: anchorScope("ALLOCATION"),
      categories: ["AUTO_DRAFT"],
    };
    const preview = await previewBedAllocationRemoval(request);
    rows[0].stayDate = new Date("2026-08-03T00:00:00.000Z");
    rows[0].room.lodgeId = "lodge-2";
    rows[0].roomId = "room-lodge-2";

    const first = applyBedAllocationRemoval({
      request: { ...request, previewDigest: preview.digest },
      actorMemberId: "admin-1",
    });
    const firstError = (await first.catch(
      (error: unknown) => error,
    )) as BedAllocationRemovalError;
    expect(firstError).toMatchObject({
      status: 409,
      refreshedPreview: {
        scope: { lodgeId: "lodge-2", stayDate: "2026-08-03" },
        context: { lodgeId: "lodge-2", anchorNight: "2026-08-03" },
      },
    });
    const refreshedPreview = firstError.refreshedPreview!;

    // Echoing the refreshed digest with the OLD tuple remains stale forever.
    await expect(
      applyBedAllocationRemoval({
        request: {
          ...request,
          previewDigest: refreshedPreview.digest,
        },
        actorMemberId: "admin-1",
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(prismaMock.bedAllocation.deleteMany).not.toHaveBeenCalled();

    // The caller must explicitly adopt the canonical refreshed scope.
    await expect(
      applyBedAllocationRemoval({
        request: {
          scope: refreshedPreview.scope,
          categories: request.categories,
          previewDigest: refreshedPreview.digest,
        },
        actorMemberId: "admin-1",
      }),
    ).resolves.toMatchObject({ removedRowCount: 1 });
  });

  it("writes exactly one bounded operation audit and one bounded promotion audit", async () => {
    const rows: Row[] = [];
    for (let index = 0; index < 60; index += 1) {
      rows.push(
        row({
          id: `primary-${String(index).padStart(2, "0")}`,
          bookingId: `booking-${String(index).padStart(2, "0")}`,
          bookingGuestId: `primary-guest-${index}`,
          bedId: `bed-${index}`,
        }),
        row({
          id: `second-${String(index).padStart(2, "0")}`,
          source: "MANUAL",
          bookingId: `partner-booking-${String(index).padStart(2, "0")}`,
          bookingGuestId: `partner-guest-${index}`,
          bedId: `bed-${index}`,
          second: true,
        }),
      );
    }
    installRows(rows);
    const request: BedAllocationRemovalRequest = {
      scope: {
        type: "WINDOW",
        lodgeId: "lodge-1",
        from: "2026-08-01",
        to: "2026-08-02",
      },
      categories: ["AUTO_DRAFT"],
    };
    const preview = await previewBedAllocationRemoval(request);
    await applyBedAllocationRemoval({
      request: { ...request, previewDigest: preview.digest },
      actorMemberId: "admin-1",
    });

    expect(auditMock).toHaveBeenCalledTimes(2);
    const operation = auditMock.mock.calls[0][0];
    expect(operation.action).toBe("BED_ALLOCATION_REMOVAL_APPLIED");
    const expectedBookingIds = Array.from(
      { length: 50 },
      (_, index) => `booking-${String(index).padStart(2, "0")}`,
    );
    const expectedAllocationIds = Array.from(
      { length: 50 },
      (_, index) => `primary-${String(index).padStart(2, "0")}`,
    );
    expect(operation.details).toBe(
      `Affected bookings: ${expectedBookingIds.slice(0, 30).join(", ")}. Showing 30 of 60 booking IDs; metadata.affectedBookingIds contains a bounded sample of 50 IDs and omits 10.`,
    );
    expect(operation.metadata).toEqual({
      digestVersion: preview.digestVersion,
      previewDigest: preview.digest,
      scope: request.scope,
      selectedCategories: request.categories,
      removedRowCount: 60,
      categoryCounts: { AUTO_DRAFT: 60, MANUAL_DRAFT: 0, APPROVED: 0 },
      affectedBookingCount: 60,
      affectedBookingIds: expectedBookingIds,
      omittedAffectedBookingIdCount: 10,
      affectedNights: ["2026-08-01"],
      omittedAffectedNightCount: 0,
      promotedRowCount: 60,
      reopenedBookingIds: [],
      omittedReopenedBookingIdCount: 0,
      allocationIds: expectedAllocationIds,
      omittedAllocationIdCount: 10,
      autoAllocationTriggered: false,
    });
    const promotions = auditMock.mock.calls[1][0];
    expect(promotions.action).toBe("BED_ALLOCATION_PARTNERS_PROMOTED");
    const expectedPromotionBookingIds = Array.from(
      { length: 60 },
      (_, index) => `partner-booking-${String(index).padStart(2, "0")}`,
    );
    expect(promotions.details).toBe(
      `Promoted partner bookings: ${expectedPromotionBookingIds.slice(0, 30).join(", ")}. Showing 30 of 60 booking IDs; metadata.promotions contains a bounded sample of 50 of 60 promotion records and omits 10.`,
    );
    expect(promotions.metadata).toEqual({
      removalPreviewDigest: preview.digest,
      promotedCount: 60,
      promotions: Array.from({ length: 50 }, (_, index) => ({
        allocationId: `second-${String(index).padStart(2, "0")}`,
        bookingId: `partner-booking-${String(index).padStart(2, "0")}`,
        bookingGuestId: `partner-guest-${index}`,
        bedId: `bed-${index}`,
        stayDate: "2026-08-01",
      })),
      omittedPromotionCount: 10,
      promotionsTruncated: true,
    });
    expect(prismaMock.bedAllocation.updateMany).toHaveBeenCalledTimes(1);
  });

  it.each(["delete", "promotion", "audit"] as const)(
    "rejects the transaction when the %s stage fails",
    async (stage) => {
      const rows = [
        row({ id: "auto", bedId: "shared" }),
        row({
          id: "partner",
          source: "MANUAL",
          bookingId: "booking-2",
          bookingGuestId: "guest-2",
          bedId: "shared",
          second: true,
        }),
      ];
      installRows(rows);
      const request: BedAllocationRemovalRequest = {
        scope: anchorScope("ALLOCATION"),
        categories: ["AUTO_DRAFT"],
      };
      const preview = await previewBedAllocationRemoval(request);
      const failure = new Error(`${stage} failed`);
      if (stage === "delete") {
        prismaMock.bedAllocation.deleteMany.mockRejectedValueOnce(failure);
      } else if (stage === "promotion") {
        prismaMock.bedAllocation.updateMany.mockRejectedValueOnce(failure);
      } else {
        auditMock.mockRejectedValueOnce(failure);
      }

      await expect(
        applyBedAllocationRemoval({
          request: { ...request, previewDigest: preview.digest },
          actorMemberId: "admin-1",
        }),
      ).rejects.toThrow(`${stage} failed`);
      expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
    },
  );
});
