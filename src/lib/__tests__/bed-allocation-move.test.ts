import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  auditMock,
  capacityLockMock,
  custodianHoldsMock,
  lifecycleLocksMock,
  partnerLocksMock,
  prismaMock,
} = vi.hoisted(() => ({
  auditMock: vi.fn(),
  capacityLockMock: vi.fn(),
  custodianHoldsMock: vi.fn(),
  lifecycleLocksMock: vi.fn(),
  partnerLocksMock: vi.fn(),
  prismaMock: {
    bedAllocation: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      updateMany: vi.fn(),
    },
    booking: { findMany: vi.fn() },
    bookingGuest: {},
    hutLeaderAssignment: { findMany: vi.fn() },
    lodgeBed: { findUnique: vi.fn() },
    lodgeRoom: {},
    member: { findMany: vi.fn() },
    memberPartnerLink: { findMany: vi.fn() },
    $executeRaw: vi.fn(),
    $transaction: vi.fn(),
  },
}));

vi.mock("@/lib/audit", () => ({ createAuditLog: auditMock }));
vi.mock("@/lib/capacity", () => ({
  acquireLodgeCapacityLock: capacityLockMock,
}));
vi.mock("@/lib/member-lifecycle-lock", () => ({
  acquireMemberLifecycleLocks: lifecycleLocksMock,
}));
vi.mock("@/lib/member-partner-lock", () => ({
  acquireMemberPartnerLinkLocks: partnerLocksMock,
}));
vi.mock("@/lib/custodian-occupancy", async (importOriginal) => {
  const actual =
    (await importOriginal()) as typeof import("@/lib/custodian-occupancy");
  return { ...actual, findCustodianBedHolds: custodianHoldsMock };
});
vi.mock("@/lib/prisma", () => ({ prisma: prismaMock }));

import {
  applyBedAllocationMove,
  MAX_BED_ALLOCATION_PERSON_MOVE_NIGHTS,
  previewBedAllocationMove,
} from "@/lib/bed-allocation-move";

type FixtureRow = ReturnType<typeof allocationRow>;

function booking(
  overrides: Partial<{
    id: string;
    status: string;
    lodgeId: string;
    deletedAt: Date | null;
    wholeLodgeHold: boolean;
    originBookingRequest: { id: string } | null;
  }> = {},
) {
  return {
    id: overrides.id ?? "booking-1",
    status: overrides.status ?? "CONFIRMED",
    deletedAt: overrides.deletedAt ?? null,
    lodgeId: overrides.lodgeId ?? "lodge-1",
    wholeLodgeHold: overrides.wholeLodgeHold ?? false,
    checkIn: new Date("2026-01-01T00:00:00.000Z"),
    checkOut: new Date("2028-01-01T00:00:00.000Z"),
    adminCapacityHoldAt: null,
    updatedAt: new Date("2026-07-01T00:00:00.000Z"),
    originBookingRequest: overrides.originBookingRequest ?? null,
  };
}

function allocationRow(
  input: Partial<{
    id: string;
    bookingId: string;
    bookingGuestId: string;
    bookingStatus: string;
    bookingOrigin: boolean;
    bookingLodgeId: string;
    roomId: string;
    roomLodgeId: string;
    roomName: string;
    bedId: string;
    bedName: string;
    bedType: "SINGLE" | "DOUBLE";
    stayDate: string;
    source: "AUTO" | "MANUAL";
    approved: boolean;
    second: boolean;
    guestName: string;
    guestAgeTier: "INFANT" | "CHILD" | "YOUTH" | "ADULT" | "NOT_APPLICABLE";
    memberId: string | null;
    memberActive: boolean;
    memberAgeTier: "INFANT" | "CHILD" | "YOUTH" | "ADULT" | "NOT_APPLICABLE";
    consentStatus: "PENDING" | "CONFIRMED" | "DECLINED" | "EXPIRED" | null;
    explicitNights: string[];
  }> = {},
) {
  const id = input.id ?? "allocation-1";
  const bookingId = input.bookingId ?? "booking-1";
  const bookingGuestId = input.bookingGuestId ?? "guest-1";
  const roomId = input.roomId ?? "room-source";
  const bedId = input.bedId ?? "bed-source";
  const memberId = input.memberId === undefined ? "member-1" : input.memberId;
  const bookingFacts = booking({
    id: bookingId,
    status: input.bookingStatus,
    lodgeId: input.bookingLodgeId,
    originBookingRequest: input.bookingOrigin ? { id: "request-1" } : null,
  });
  const [firstName, ...last] = (input.guestName ?? "Ada Guest").split(" ");
  return {
    id,
    bookingId,
    bookingGuestId,
    roomId,
    bedId,
    stayDate: new Date(`${input.stayDate ?? "2026-08-01"}T00:00:00.000Z`),
    source: input.source ?? "AUTO",
    approvedByMemberId: input.approved ? "approver-1" : null,
    approvedAt: input.approved
      ? new Date("2026-07-15T00:00:00.000Z")
      : null,
    isSecondOccupant: input.second ?? false,
    bedType: input.bedType ?? "SINGLE",
    createdAt: new Date("2026-07-01T00:00:00.000Z"),
    updatedAt: new Date("2026-07-02T00:00:00.000Z"),
    booking: bookingFacts,
    bookingGuest: {
      id: bookingGuestId,
      bookingId,
      firstName,
      lastName: last.join(" "),
      ageTier: input.guestAgeTier ?? "ADULT",
      isMember: Boolean(memberId),
      memberId,
      stayStart: new Date("2026-01-01T00:00:00.000Z"),
      stayEnd: new Date("2028-01-01T00:00:00.000Z"),
      priceCents: 100,
      rateMembershipTypeId: null,
      consentStatus: input.consentStatus ?? null,
      consentRequestedAt: null,
      consentRespondedAt: null,
      consentRespondedByMemberId: null,
      consentExpiresAt: null,
      arrivedAt: null,
      departedAt: null,
      createdAt: new Date("2026-07-01T00:00:00.000Z"),
      booking: bookingFacts,
      member: memberId
        ? {
            id: memberId,
            active: input.memberActive ?? true,
            ageTier: input.memberAgeTier ?? "ADULT",
            updatedAt: new Date("2026-07-01T00:00:00.000Z"),
          }
        : null,
      nights: (input.explicitNights ?? []).map((stayDate, index) => ({
        id: `night-${bookingGuestId}-${index}`,
        stayDate: new Date(`${stayDate}T00:00:00.000Z`),
        priceCents: 100,
      })),
    },
    room: {
      id: roomId,
      name: input.roomName ?? "Source Room",
      active: true,
      lodgeId: input.roomLodgeId ?? "lodge-1",
      updatedAt: new Date("2026-07-01T00:00:00.000Z"),
    },
    bed: {
      id: bedId,
      roomId,
      name: input.bedName ?? "Source Bed",
      active: true,
      bedType: input.bedType ?? "SINGLE",
      updatedAt: new Date("2026-07-01T00:00:00.000Z"),
    },
  };
}

function destination(
  overrides: Partial<{
    id: string;
    roomId: string;
    lodgeId: string;
    active: boolean;
    roomActive: boolean;
    bedType: "SINGLE" | "DOUBLE";
  }> = {},
) {
  const roomId = overrides.roomId ?? "room-destination";
  return {
    id: overrides.id ?? "bed-destination",
    roomId,
    name: "Destination Bed",
    sortOrder: 1,
    active: overrides.active ?? true,
    bedType: overrides.bedType ?? "SINGLE",
    bunkGroup: null,
    createdAt: new Date("2026-07-01T00:00:00.000Z"),
    updatedAt: new Date("2026-07-01T00:00:00.000Z"),
    room: {
      id: roomId,
      name: "Destination Room",
      active: overrides.roomActive ?? true,
      lodgeId: overrides.lodgeId ?? "lodge-1",
      updatedAt: new Date("2026-07-01T00:00:00.000Z"),
    },
  };
}

function sameDate(left: Date, right: Date) {
  return left.toISOString() === right.toISOString();
}

function install(input: {
  rows: FixtureRow[];
  destination?: ReturnType<typeof destination>;
  members?: Array<{
    id: string;
    active: boolean;
    ageTier: string;
    updatedAt: Date;
  }>;
  partnerLinks?: Array<{
    id: string;
    memberAId: string;
    memberBId: string;
    status: string;
    updatedAt: Date;
  }>;
}) {
  const target = input.destination ?? destination();
  prismaMock.lodgeBed.findUnique.mockImplementation(
    async ({ where }: { where: { id: string } }) =>
      where.id === target.id ? target : null,
  );
  prismaMock.bedAllocation.findUnique.mockImplementation(
    async ({ where }: { where: { id: string } }) =>
      input.rows.find((row) => row.id === where.id) ?? null,
  );
  prismaMock.bedAllocation.findMany.mockImplementation(
    async ({ where }: { where: Record<string, unknown> }) => {
      if (typeof where.bookingGuestId === "string") {
        return input.rows.filter(
          (row) => row.bookingGuestId === where.bookingGuestId,
        );
      }
      const parts = (where.OR ?? []) as Array<{
        roomId?: string;
        bedId?: string;
        stayDate?: Date | { in: Date[] };
      }>;
      return input.rows.filter((row) =>
        parts.some((part) => {
          if (part.roomId && row.roomId !== part.roomId) return false;
          if (part.bedId && row.bedId !== part.bedId) return false;
          if (part.stayDate instanceof Date) {
            return sameDate(row.stayDate, part.stayDate);
          }
          if (part.stayDate && "in" in part.stayDate) {
            return part.stayDate.in.some((date) => sameDate(row.stayDate, date));
          }
          return true;
        }),
      );
    },
  );
  prismaMock.booking.findMany.mockResolvedValue([]);
  prismaMock.member.findMany.mockResolvedValue(input.members ?? []);
  prismaMock.memberPartnerLink.findMany.mockResolvedValue(
    input.partnerLinks ?? [],
  );
  prismaMock.bedAllocation.updateMany.mockImplementation(
    async ({ where, data }: { where: { id: string | { in: string[] } }; data: Record<string, unknown> }) => {
      const ids =
        typeof where.id === "string" ? [where.id] : (where.id?.in ?? []);
      const matched = input.rows.filter((row) => ids.includes(row.id));
      for (const row of matched) Object.assign(row, data);
      return { count: matched.length };
    },
  );
  prismaMock.$executeRaw.mockImplementation(
    async (strings: TemplateStringsArray, ...values: unknown[]) => {
      if (!strings.join("").includes('UPDATE "BedAllocation" AS allocation')) {
        return 1;
      }
      const reviewed = values.at(-1) as { values: unknown[] };
      for (let offset = 0; offset < reviewed.values.length; offset += 8) {
        const id = reviewed.values[offset] as string;
        const row = input.rows.find((candidate) => candidate.id === id);
        if (!row) continue;
        Object.assign(row, {
          roomId: target.roomId,
          bedId: target.id,
          source: "MANUAL",
          approvedAt: null,
          approvedByMemberId: null,
          isSecondOccupant: reviewed.values[offset + 7] as boolean,
          bedType: target.bedType,
        });
      }
      return reviewed.values.length / 8;
    },
  );
  return target;
}

function request(scope: "ALLOCATION_NIGHT" | "BOOKING_GUEST" = "ALLOCATION_NIGHT") {
  return {
    anchorAllocationId: "allocation-1",
    destinationBedId: "bed-destination",
    scope,
  } as const;
}

describe("authoritative bed-allocation move", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    auditMock.mockResolvedValue(undefined);
    capacityLockMock.mockResolvedValue(undefined);
    custodianHoldsMock.mockResolvedValue([]);
    lifecycleLocksMock.mockResolvedValue(undefined);
    partnerLocksMock.mockResolvedValue(undefined);
    prismaMock.$executeRaw.mockResolvedValue(1);
    prismaMock.$transaction.mockImplementation(
      async (callback: (tx: typeof prismaMock) => unknown) => callback(prismaMock),
    );
  });

  it("resolves one exact row for night scope and every sparse/off-screen row for person scope", async () => {
    const rows = [
      allocationRow({ id: "allocation-1", stayDate: "2026-08-01" }),
      allocationRow({ id: "allocation-2", stayDate: "2026-08-17" }),
      allocationRow({ id: "allocation-3", stayDate: "2026-10-03" }),
    ];
    install({ rows });

    const night = await previewBedAllocationMove(request(), prismaMock as never);
    const person = await previewBedAllocationMove(
      request("BOOKING_GUEST"),
      prismaMock as never,
    );

    expect(night.resolvedRowCount).toBe(1);
    expect(night.changed.map((row) => row.stayDate)).toEqual(["2026-08-01"]);
    expect(person.resolvedRowCount).toBe(3);
    expect(person.changed.map((row) => row.stayDate)).toEqual([
      "2026-08-01",
      "2026-08-17",
      "2026-10-03",
    ]);
  });

  it(`accepts ${MAX_BED_ALLOCATION_PERSON_MOVE_NIGHTS} rows and refuses the next`, async () => {
    const rows = Array.from(
      { length: MAX_BED_ALLOCATION_PERSON_MOVE_NIGHTS },
      (_, index) =>
        allocationRow({
          id: `allocation-${index + 1}`,
          stayDate: new Date(Date.UTC(2026, 0, index + 1))
            .toISOString()
            .slice(0, 10),
        }),
    );
    install({ rows });
    await expect(
      previewBedAllocationMove(request("BOOKING_GUEST"), prismaMock as never),
    ).resolves.toMatchObject({ resolvedRowCount: 366 });

    rows.push(
      allocationRow({
        id: "allocation-367",
        stayDate: "2027-01-02",
      }),
    );
    await expect(
      previewBedAllocationMove(request("BOOKING_GUEST"), prismaMock as never),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("keeps an all-noop historical source-lodge drift successful and audit-free", async () => {
    const rows = [
      allocationRow({
        bedId: "bed-destination",
        roomId: "room-destination",
        roomLodgeId: "historical-lodge",
        bookingLodgeId: "lodge-1",
      }),
    ];
    install({
      rows,
      destination: destination({ lodgeId: "historical-lodge" }),
    });
    const preview = await previewBedAllocationMove(request(), prismaMock as never);
    expect(preview).toMatchObject({ changedRowCount: 0, unchangedRowCount: 1 });

    const result = await applyBedAllocationMove({
      request: { ...request(), previewDigest: preview.digest },
      actorMemberId: "admin-1",
    });
    expect(result).toEqual({
      noop: true,
      movedRowCount: 0,
      promotedRowCount: 0,
      affectedNights: [],
    });
    expect(prismaMock.bedAllocation.updateMany).not.toHaveBeenCalled();
    expect(auditMock).not.toHaveBeenCalled();
  });

  it("still refuses a historical-lodge person request when any row would change", async () => {
    const rows = [
      allocationRow({
        bedId: "bed-destination",
        roomId: "room-destination",
        roomLodgeId: "historical-lodge",
      }),
      allocationRow({
        id: "allocation-2",
        bedId: "bed-source-2",
        roomLodgeId: "historical-lodge",
        stayDate: "2026-08-02",
      }),
    ];
    install({
      rows,
      destination: destination({ lodgeId: "historical-lodge" }),
    });

    await expect(
      previewBedAllocationMove(request("BOOKING_GUEST"), prismaMock as never),
    ).resolves.toMatchObject({
      changedRowCount: 1,
      unchangedRowCount: 1,
      conflicts: [expect.objectContaining({ code: "LODGE_MISMATCH" })],
    });
  });

  it("uses the narrow confirmed-status rule for shared-double primary eligibility", async () => {
    const moving = allocationRow({ memberId: "member-a" });
    const primary = allocationRow({
      id: "other-allocation",
      bookingId: "booking-2",
      bookingGuestId: "guest-2",
      bookingStatus: "PENDING",
      bookingOrigin: true,
      roomId: "room-destination",
      bedId: "bed-destination",
      bedType: "DOUBLE",
      guestName: "Private Occupant",
      memberId: "member-b",
    });
    install({
      rows: [moving, primary],
      destination: destination({ bedType: "DOUBLE" }),
      members: [
        {
          id: "member-a",
          active: true,
          ageTier: "ADULT",
          updatedAt: new Date("2026-07-01T00:00:00.000Z"),
        },
        {
          id: "member-b",
          active: true,
          ageTier: "ADULT",
          updatedAt: new Date("2026-07-01T00:00:00.000Z"),
        },
      ],
      partnerLinks: [
        {
          id: "link-1",
          memberAId: "member-a",
          memberBId: "member-b",
          status: "CONFIRMED",
          updatedAt: new Date("2026-07-01T00:00:00.000Z"),
        },
      ],
    });

    const preview = await previewBedAllocationMove(request(), prismaMock as never);
    expect(preview.conflicts.map((item) => item.code)).toContain(
      "SHARED_DOUBLE_INELIGIBLE",
    );
    expect(JSON.stringify(preview)).not.toContain("Private Occupant");
  });

  it("moves only changed rows, resets approvals to Manual draft and writes one move audit", async () => {
    const rows = [allocationRow({ approved: true })];
    install({ rows });
    const preview = await previewBedAllocationMove(request(), prismaMock as never);

    const result = await applyBedAllocationMove({
      request: { ...request(), previewDigest: preview.digest },
      actorMemberId: "admin-1",
    });

    expect(result).toEqual({
      noop: false,
      movedRowCount: 1,
      promotedRowCount: 0,
      affectedNights: ["2026-08-01"],
    });
    expect(prismaMock.$transaction).toHaveBeenCalledWith(
      expect.any(Function),
      { timeout: 30_000, maxWait: 10_000 },
    );
    expect(rows[0]).toMatchObject({
      bedId: "bed-destination",
      roomId: "room-destination",
      source: "MANUAL",
      approvedAt: null,
      approvedByMemberId: null,
    });
    expect(auditMock).toHaveBeenCalledTimes(1);
    expect(auditMock.mock.calls[0][0]).toMatchObject({
      action: "BED_ALLOCATION_MOVE_APPLIED",
      category: "lodge",
    });
    expect(lifecycleLocksMock).toHaveBeenCalledWith(prismaMock, ["member-1"]);
    expect(partnerLocksMock).toHaveBeenCalledWith(prismaMock, ["member-1"]);
    const rawCalls = prismaMock.$executeRaw.mock.invocationCallOrder;
    expect(rawCalls).toHaveLength(3);
    expect(rawCalls[0]).toBeLessThan(
      capacityLockMock.mock.invocationCallOrder[0],
    );
    expect(capacityLockMock.mock.invocationCallOrder[0]).toBeLessThan(
      lifecycleLocksMock.mock.invocationCallOrder[0],
    );
    expect(lifecycleLocksMock.mock.invocationCallOrder[0]).toBeLessThan(
      partnerLocksMock.mock.invocationCallOrder[0],
    );
    expect(partnerLocksMock.mock.invocationCallOrder[0]).toBeLessThan(
      rawCalls[1],
    );
  });

  it("locks counterpart booking lodges in sorted order before member and tuple locks", async () => {
    const moving = allocationRow({ memberId: "member-a" });
    const occupant = allocationRow({
      id: "other-allocation",
      bookingId: "booking-2",
      bookingGuestId: "guest-2",
      bookingLodgeId: "lodge-2",
      roomId: "room-destination",
      roomLodgeId: "lodge-1",
      bedId: "bed-destination",
      memberId: "member-b",
    });
    install({ rows: [moving, occupant] });
    const preview = await previewBedAllocationMove(request(), prismaMock as never);

    await expect(
      applyBedAllocationMove({
        request: { ...request(), previewDigest: preview.digest },
        actorMemberId: "admin-1",
      }),
    ).rejects.toMatchObject({ code: "MOVE_CONFLICT" });
    expect(capacityLockMock.mock.calls.map((call) => call[1])).toEqual([
      "lodge-1",
      "lodge-2",
    ]);
    expect(capacityLockMock.mock.invocationCallOrder.at(-1)).toBeLessThan(
      lifecycleLocksMock.mock.invocationCallOrder[0],
    );
  });

  it("promotes the remaining old-bed second occupant exactly once", async () => {
    const moving = allocationRow({ bedType: "DOUBLE" });
    const second = allocationRow({
      id: "second-allocation",
      bookingId: "booking-2",
      bookingGuestId: "guest-2",
      bedId: "bed-source",
      bedType: "DOUBLE",
      second: true,
      memberId: "member-2",
    });
    const rows = [moving, second];
    install({ rows });
    const preview = await previewBedAllocationMove(request(), prismaMock as never);
    expect(preview.promotions).toEqual([
      { stayDate: "2026-08-01", bedName: "Source Bed" },
    ]);

    const result = await applyBedAllocationMove({
      request: { ...request(), previewDigest: preview.digest },
      actorMemberId: "admin-1",
    });
    expect(result.promotedRowCount).toBe(1);
    expect(second.isSecondOccupant).toBe(false);
    expect(auditMock).toHaveBeenCalledTimes(2);
    const promotionAudit = auditMock.mock.calls[1][0];
    expect(promotionAudit).toMatchObject({
      action: "BED_ALLOCATION_PARTNERS_PROMOTED",
      category: "lodge",
      targetId: "booking-1",
      details: "Promoted partner bookings: booking-2",
      metadata: {
        movePreviewDigest: preview.digest,
        promotedCount: 1,
        promotions: [
          {
            allocationId: "second-allocation",
            bookingId: "booking-2",
            bookingGuestId: "guest-2",
            bedId: "bed-source",
            stayDate: "2026-08-01",
            causalMovedAllocationId: "allocation-1",
            causalMovedBookingId: "booking-1",
            causalMovedBookingGuestId: "guest-1",
          },
        ],
        omittedPromotionCount: 0,
        promotionsTruncated: false,
      },
    });
    expect(promotionAudit.details).toContain(second.bookingId);
  });

  it("marks an eligible confirmed partner as the second occupant", async () => {
    const moving = allocationRow({ memberId: "member-a" });
    const primary = allocationRow({
      id: "primary-allocation",
      bookingId: "booking-2",
      bookingGuestId: "guest-2",
      roomId: "room-destination",
      bedId: "bed-destination",
      bedType: "DOUBLE",
      memberId: "member-b",
    });
    const rows = [moving, primary];
    install({
      rows,
      destination: destination({ bedType: "DOUBLE" }),
      members: [
        {
          id: "member-a",
          active: true,
          ageTier: "ADULT",
          updatedAt: new Date("2026-07-01T00:00:00.000Z"),
        },
        {
          id: "member-b",
          active: true,
          ageTier: "ADULT",
          updatedAt: new Date("2026-07-01T00:00:00.000Z"),
        },
      ],
      partnerLinks: [
        {
          id: "link-1",
          memberAId: "member-a",
          memberBId: "member-b",
          status: "CONFIRMED",
          updatedAt: new Date("2026-07-01T00:00:00.000Z"),
        },
      ],
    });
    const preview = await previewBedAllocationMove(request(), prismaMock as never);
    expect(preview.conflicts).toEqual([]);

    await applyBedAllocationMove({
      request: { ...request(), previewDigest: preview.digest },
      actorMemberId: "admin-1",
    });
    expect(moving.isSecondOccupant).toBe(true);
  });

  it("excludes unchanged rows from hold conflicts in a mixed person preview", async () => {
    const rows = [
      allocationRow({
        bedId: "bed-destination",
        roomId: "room-destination",
        stayDate: "2026-08-01",
      }),
      allocationRow({ id: "allocation-2", stayDate: "2026-08-02" }),
    ];
    install({ rows });
    custodianHoldsMock.mockResolvedValue([
      {
        assignmentId: "hold-1",
        memberId: "staff-1",
        memberName: "Private Staff",
        memberIsMinor: false,
        lodgeId: "lodge-1",
        bedId: "bed-destination",
        bedName: "Destination Bed",
        roomId: "room-destination",
        roomName: "Destination Room",
        startDate: "2026-08-01",
        endDate: "2026-08-01",
      },
    ]);

    const preview = await previewBedAllocationMove(
      request("BOOKING_GUEST"),
      prismaMock as never,
    );
    expect(preview).toMatchObject({
      changedRowCount: 1,
      unchangedRowCount: 1,
      conflicts: [],
    });
    expect(JSON.stringify(preview)).not.toContain("Private Staff");
  });

  it("hard-refuses destination custodian and whole-lodge holds", async () => {
    const rows = [allocationRow()];
    install({ rows });
    custodianHoldsMock.mockResolvedValue([
      {
        assignmentId: "hold-1",
        memberId: "staff-1",
        memberName: "Private Staff",
        memberIsMinor: false,
        lodgeId: "lodge-1",
        bedId: "bed-destination",
        bedName: "Destination Bed",
        roomId: "room-destination",
        roomName: "Destination Room",
        startDate: "2026-08-01",
        endDate: "2026-08-01",
      },
    ]);
    prismaMock.booking.findMany.mockResolvedValue([
      booking({ id: "whole-hold", wholeLodgeHold: true }),
    ]);

    const preview = await previewBedAllocationMove(request(), prismaMock as never);
    expect(preview.conflicts.map((item) => item.code)).toEqual([
      "CUSTODIAN_HOLD",
      "WHOLE_LODGE_HOLD",
    ]);
  });

  it("uses explicit guest nights before the stay envelope", async () => {
    const rows = [
      allocationRow({
        stayDate: "2026-08-02",
        explicitNights: ["2026-08-01", "2026-08-03"],
      }),
    ];
    install({ rows });

    const preview = await previewBedAllocationMove(request(), prismaMock as never);
    expect(preview.conflicts.map((item) => item.code)).toContain(
      "GUEST_NOT_STAYING",
    );
  });

  it("returns a refreshed preview and performs no writes for a stale digest", async () => {
    const rows = [allocationRow()];
    install({ rows });

    await expect(
      applyBedAllocationMove({
        request: { ...request(), previewDigest: `v1:${"0".repeat(64)}` },
        actorMemberId: "admin-1",
      }),
    ).rejects.toMatchObject({
      status: 409,
      code: "STALE_PREVIEW",
      refreshedPreview: expect.objectContaining({ changedRowCount: 1 }),
    });
    expect(prismaMock.bedAllocation.updateMany).not.toHaveBeenCalled();
    expect(auditMock).not.toHaveBeenCalled();
  });

  it("returns an unavailable refreshed preview when the anchor disappeared", async () => {
    install({ rows: [] });
    await expect(
      applyBedAllocationMove({
        request: { ...request(), previewDigest: `v1:${"0".repeat(64)}` },
        actorMemberId: "admin-1",
      }),
    ).rejects.toMatchObject({
      status: 409,
      code: "STALE_PREVIEW",
      refreshedPreview: expect.objectContaining({
        resolvedRowCount: 0,
        conflicts: [expect.objectContaining({ code: "ALLOCATION_UNAVAILABLE" })],
      }),
    });
  });

  it("identifies a disappeared destination separately from a disappeared anchor", async () => {
    install({
      rows: [allocationRow()],
      destination: destination({ id: "some-other-bed" }),
    });

    await expect(
      applyBedAllocationMove({
        request: { ...request(), previewDigest: `v1:${"0".repeat(64)}` },
        actorMemberId: "admin-1",
      }),
    ).rejects.toMatchObject({
      status: 409,
      code: "STALE_PREVIEW",
      refreshedPreview: expect.objectContaining({
        conflicts: [expect.objectContaining({ code: "DESTINATION_UNAVAILABLE" })],
      }),
    });
  });

  it("refuses inconsistent guest relations without disguising them as an unavailable anchor", async () => {
    const row = allocationRow();
    row.bookingGuest.id = "different-guest";
    install({ rows: [row] });

    await expect(
      applyBedAllocationMove({
        request: { ...request(), previewDigest: `v1:${"0".repeat(64)}` },
        actorMemberId: "admin-1",
      }),
    ).rejects.toMatchObject({
      status: 409,
      code: "INVALID_MOVE",
      refreshedPreview: undefined,
    });
  });

  it.each([
    ["NOT_APPLICABLE", "ADULT"],
    ["ADULT", "YOUTH"],
  ] as const)(
    "refuses symmetric cross-booking room mix for moving %s against %s",
    async (movingTier, otherTier) => {
    const moving = allocationRow({ guestAgeTier: movingTier });
    const other = allocationRow({
      id: "other-allocation",
      bookingId: "booking-2",
      bookingGuestId: "guest-2",
      roomId: "room-destination",
      bedId: "other-bed",
      guestAgeTier: otherTier,
    });
    install({ rows: [moving, other] });

    const preview = await previewBedAllocationMove(request(), prismaMock as never);
    expect(preview.conflicts.map((item) => item.code)).toContain(
      "ADULT_MINOR_MIX",
    );
    },
  );
});
