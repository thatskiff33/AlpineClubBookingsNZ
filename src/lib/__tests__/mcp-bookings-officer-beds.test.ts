/**
 * ALP-719 (`INV-MCP-006`): the bed allocation actions an officer's AI app
 * connection may run: the board, its settings, rooms, beds, and placing,
 * moving, approving and removing allocations. Each route answers the browser
 * as before; the connection gets exactly the action's `returns` fields
 * (`expectActionContract`), and the route's own guard asks for the same
 * Bookings & Beds level it asks a browser for. Every handler runs twice
 * (connection, then browser), so the service mocks answer both runs.
 *
 * The services are mocked at their module boundary: what is under test is the
 * route's guard, its schema and its projection, not the allocation rules.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  moduleEnabled: vi.fn(),
  prisma: {
    lodge: { findUnique: vi.fn() },
    booking: { findUnique: vi.fn() },
  },
  createAuditLog: vi.fn(),
  logAudit: vi.fn(),
  revalidatePublicSite: vi.fn(),
  getDashboard: vi.fn(),
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
  getRooms: vi.fn(),
  createRoom: vi.fn(),
  createRoomsBulk: vi.fn(),
  importRooms: vi.fn(),
  updateRoom: vi.fn(),
  deleteRoom: vi.fn(),
  createBed: vi.fn(),
  updateBed: vi.fn(),
  deleteBed: vi.fn(),
  allocateBed: vi.fn(),
  allocateNights: vi.fn(),
  moveSameDate: vi.fn(),
  previewMove: vi.fn(),
  applyMove: vi.fn(),
  assignRange: vi.fn(),
  previewRemoval: vi.fn(),
  applyRemoval: vi.fn(),
  approve: vi.fn(),
  autoAllocate: vi.fn(),
}));

vi.mock("@/lib/session-guards", () => ({ requireAdmin: h.requireAdmin }));
vi.mock("@/lib/prisma", () => ({ prisma: h.prisma }));
vi.mock("@/lib/admin-modules", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/admin-modules")),
  isEffectiveModuleEnabled: h.moduleEnabled,
}));
vi.mock("@/lib/club-time/server", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/club-time/server")),
  clubTime: async () => ({ today: () => "2026-07-01" }),
}));
vi.mock("@/lib/audit", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/audit")),
  createAuditLog: h.createAuditLog,
  logAudit: h.logAudit,
}));
vi.mock("@/lib/public-content-revalidation", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/public-content-revalidation")),
  revalidatePublicSite: h.revalidatePublicSite,
}));
vi.mock("@/lib/bed-allocation-board", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/bed-allocation-board")),
  getBedAllocationDashboard: h.getDashboard,
}));
vi.mock("@/lib/bed-allocation-admin-settings", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/bed-allocation-admin-settings")),
  getEffectiveBedAllocationSettings: h.getSettings,
  updateBedAllocationSettings: h.updateSettings,
}));
vi.mock("@/lib/bed-allocation-rooms", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/bed-allocation-rooms")),
  getRoomsAndBedsConfiguration: h.getRooms,
  createBedAllocationRoom: h.createRoom,
  createBedAllocationRoomsBulk: h.createRoomsBulk,
  importRoomsAndBedsFromClubConfig: h.importRooms,
  updateBedAllocationRoom: h.updateRoom,
  deleteBedAllocationRoom: h.deleteRoom,
}));
vi.mock("@/lib/bed-allocation-beds", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/bed-allocation-beds")),
  createBedAllocationBed: h.createBed,
  updateBedAllocationBed: h.updateBed,
  deleteBedAllocationBed: h.deleteBed,
}));
vi.mock("@/lib/bed-allocation-manual-writes", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/bed-allocation-manual-writes")),
  manuallyAllocateBed: h.allocateBed,
  manuallyAllocateBedForNights: h.allocateNights,
  moveBedAllocationsSameDate: h.moveSameDate,
}));
vi.mock("@/lib/bed-allocation-move", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/bed-allocation-move")),
  previewBedAllocationMove: h.previewMove,
  applyBedAllocationMove: h.applyMove,
}));
vi.mock("@/lib/bed-allocation-range-assign", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/bed-allocation-range-assign")),
  assignBedRange: h.assignRange,
}));
vi.mock("@/lib/bed-allocation-removal", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/bed-allocation-removal")),
  previewBedAllocationRemoval: h.previewRemoval,
  applyBedAllocationRemoval: h.applyRemoval,
}));
vi.mock("@/lib/bed-allocation-approval", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/bed-allocation-approval")),
  approveBedAllocations: h.approve,
}));
vi.mock("@/lib/bed-allocation-auto-allocate", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/bed-allocation-auto-allocate")),
  runAutoBedAllocation: h.autoAllocate,
}));

import { GET as getBoard } from "@/app/api/admin/bed-allocation/route";
import {
  PATCH as moveAllocation,
  POST as allocateNight,
} from "@/app/api/admin/bed-allocation/allocations/route";
import { POST as allocateNights } from "@/app/api/admin/bed-allocation/allocations/bulk/route";
import { POST as previewMove } from "@/app/api/admin/bed-allocation/allocations/move/route";
import { POST as assignRange } from "@/app/api/admin/bed-allocation/allocations/range/route";
import {
  POST as previewRemoval,
  PUT as applyRemoval,
} from "@/app/api/admin/bed-allocation/allocations/removal/route";
import { POST as approve } from "@/app/api/admin/bed-allocation/approve/route";
import { POST as autoAllocate } from "@/app/api/admin/bed-allocation/auto-allocate/route";
import { POST as createBed } from "@/app/api/admin/bed-allocation/beds/route";
import { DELETE as deleteBed, PATCH as updateBed } from "@/app/api/admin/bed-allocation/beds/[id]/route";
import { GET as listRooms, POST as createRoom } from "@/app/api/admin/bed-allocation/rooms/route";
import { DELETE as deleteRoom, PATCH as updateRoom } from "@/app/api/admin/bed-allocation/rooms/[id]/route";
import { POST as createRoomsBulk } from "@/app/api/admin/bed-allocation/rooms/bulk/route";
import { POST as importRooms } from "@/app/api/admin/bed-allocation/rooms/import-from-config/route";
import { GET as getSettings, PUT as putSettings } from "@/app/api/admin/bed-allocation/settings/route";
import { expectActionContract, officerMemberSession } from "@/lib/__tests__/helpers/mcp-action-contract";
import { MCP_PRINCIPAL_HEADER } from "@/lib/mcp/principal";

const VIEW = { permission: { area: "bookings", level: "view" } };
const EDIT = { permission: { area: "bookings", level: "edit" } };

const DIGEST = `v1:${"a".repeat(64)}`;

function day(date: string) {
  return new Date(`${date}T00:00:00.000Z`);
}

/** What the browser receives: the fixture after a JSON round trip. */
function asJson(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

const STAMPS = {
  createdAt: new Date("2026-05-01T00:00:00.000Z"),
  updatedAt: new Date("2026-06-01T00:00:00.000Z"),
};

beforeEach(() => {
  vi.clearAllMocks();
  h.requireAdmin.mockResolvedValue({ ok: true, session: officerMemberSession() });
  h.moduleEnabled.mockResolvedValue(true);
  h.prisma.lodge.findUnique.mockResolvedValue({ id: "lodge-1", active: true });
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** The effective settings, with the provenance an app does not need. */
function settingsFixture() {
  return {
    autoAllocationEnabled: true,
    allocationPriorityOrder: ["BOOKING_COHESION", "REQUESTED_ROOM"],
    authoritativeLodgeId: "lodge-1",
    settingsId: "lodge-1",
    source: "LODGE",
    fallback: "NONE",
    updatedByMemberId: "member-other",
    updatedAt: "2026-06-01T00:00:00.000Z",
  };
}

function dashboardRoom() {
  return {
    id: "room-1",
    name: "Kea",
    sortOrder: 1,
    active: true,
    notes: "Downstairs",
    beds: [
      { id: "bed-1", roomId: "room-1", name: "Bed 1", sortOrder: 1, active: true, bedType: "BUNK_TOP", bunkGroup: "A" },
    ],
  };
}

function dashboardFixture() {
  return {
    settings: settingsFixture(),
    range: { fromDate: "2026-07-01", toDate: "2026-07-08" },
    rooms: [dashboardRoom()],
    bookings: [
      {
        id: "booking-1",
        status: "PAID",
        holdsCapacity: true,
        createdAt: "2026-05-01T00:00:00.000Z",
        checkIn: "2026-07-02",
        checkOut: "2026-07-04",
        memberName: "Ana Reid",
        guests: [
          {
            id: "guest-1",
            bookingId: "booking-1",
            name: "Ana Reid",
            ageTier: "ADULT",
            stayStart: "2026-07-02",
            stayEnd: "2026-07-04",
          },
        ],
        requestedRoom: { id: "room-1", name: "Kea", active: true },
        parentBookingId: "booking-0",
        wholeLodgeHold: false,
        overlapsExclusiveHold: false,
      },
    ],
    allocations: [
      {
        id: "alloc-1",
        bookingId: "booking-1",
        bookingGuestId: "guest-1",
        guestName: "Ana Reid",
        guestAgeTier: "ADULT",
        roomId: "room-1",
        roomName: "Kea",
        bedId: "bed-1",
        bedName: "Bed 1",
        stayDate: "2026-07-02",
        source: "MANUAL",
        approvedAt: "2026-06-20T00:00:00.000Z",
        approvedByName: "Olive Officer",
        isSecondOccupant: false,
        bookingStatus: "PAID",
        holdsCapacity: true,
      },
    ],
    unallocatedGuestNights: [
      {
        bookingId: "booking-1",
        bookingGuestId: "guest-1",
        guestName: "Ana Reid",
        guestAgeTier: "ADULT",
        memberName: "Ana Reid",
        stayDate: "2026-07-03",
      },
    ],
    exclusiveHolds: [
      {
        bookingId: "booking-2",
        memberName: "Ben Hart",
        checkIn: "2026-07-05",
        checkOut: "2026-07-07",
        guestCount: 12,
        nights: ["2026-07-05", "2026-07-06"],
      },
    ],
    custodianHolds: [
      {
        assignmentId: "assignment-1",
        memberName: "Cara Lee",
        bedId: "bed-1",
        bedName: "Bed 1",
        roomId: "room-1",
        roomName: "Kea",
        startDate: "2026-06-01",
        endDate: "2026-10-01",
        nights: ["2026-07-07"],
      },
    ],
    pendingAdultReservations: [{ bookingId: "booking-3", night: "2026-07-02", adultCount: 2 }],
    suggestedAllocations: [
      { bookingId: "booking-1", bookingGuestId: "guest-1", roomId: "room-1", bedId: "bed-1", stayDate: "2026-07-03", source: "AUTO" },
    ],
    suggestedUnallocatedGuestNights: [
      { bookingId: "booking-1", bookingGuestId: "guest-1", stayDate: "2026-07-03", reason: "NO_BED_AVAILABLE" },
    ],
    warnings: [
      {
        id: "warning-1",
        type: "BOOKING_SPLIT",
        severity: "warning",
        bookingId: "booking-1",
        bookingGuestId: "guest-1",
        stayDate: "2026-07-02",
        roomId: "room-1",
        message: "Party split across rooms",
      },
    ],
    focusedBooking: { id: "booking-1", checkIn: "2026-07-02", checkOut: "2026-07-04" },
  };
}

function roomRow() {
  return { id: "room-1", name: "Kea", sortOrder: 1, active: true, notes: "Downstairs", lodgeId: "lodge-1", ...STAMPS };
}

const PROJECTED_ROOM = { id: "room-1", name: "Kea", sortOrder: 1, active: true, notes: "Downstairs", lodgeId: "lodge-1" };

function bedRow() {
  return {
    id: "bed-1",
    roomId: "room-1",
    name: "Bed 1",
    sortOrder: 1,
    active: true,
    bedType: "DOUBLE",
    bunkGroup: "A",
    ...STAMPS,
  };
}

const PROJECTED_BED = {
  id: "bed-1",
  roomId: "room-1",
  name: "Bed 1",
  sortOrder: 1,
  active: true,
  bedType: "DOUBLE",
  bunkGroup: "A",
};

function allocationRow() {
  return {
    id: "alloc-1",
    bookingId: "booking-1",
    bookingGuestId: "guest-1",
    roomId: "room-1",
    bedId: "bed-1",
    stayDate: day("2026-07-02"),
    source: "MANUAL",
    approvedByMemberId: "member-other",
    approvedAt: null,
    isSecondOccupant: false,
    bedType: "SINGLE",
    ...STAMPS,
  };
}

const MOVE_DETAIL = {
  allocationId: "alloc-1",
  stayDate: "2026-07-02",
  source: "MANUAL",
  approved: true,
  sourceRoomName: "Kea",
  sourceBedName: "Bed 1",
};

function movePreviewFixture() {
  return {
    digestVersion: "v1",
    digest: DIGEST,
    scope: "BOOKING_GUEST",
    anchor: { allocationId: "alloc-1", guestName: "Ana Reid", stayDate: "2026-07-02" },
    destination: { bedId: "bed-2", label: "Kea / Bed 2", available: true },
    resolvedRowCount: 2,
    changedRowCount: 1,
    unchangedRowCount: 1,
    approvedToDraftCount: 1,
    changed: [MOVE_DETAIL],
    unchanged: [{ ...MOVE_DETAIL, allocationId: "alloc-2", stayDate: "2026-07-03" }],
    promotions: [{ stayDate: "2026-07-02", bedName: "Bed 1" }],
    conflicts: [{ allocationId: "alloc-3", stayDate: null, code: "BED_TAKEN", message: "Taken" }],
  };
}

function removalPreviewFixture() {
  return {
    digestVersion: "v1",
    digest: DIGEST,
    scope: { type: "WINDOW", lodgeId: "lodge-1", from: "2026-07-01", to: "2026-07-08" },
    context: {
      lodgeId: "lodge-1",
      lodgeName: "Ruapehu",
      from: "2026-07-01",
      to: "2026-07-08",
      bookingId: "booking-1",
      bookingGuestId: "guest-1",
      guestName: "Ana Reid",
      anchorNight: "2026-07-02",
    },
    categories: { AUTO_DRAFT: 2, MANUAL_DRAFT: 1, APPROVED: 0 },
    matchedRowCount: 3,
    affectedBookingCount: 1,
    affectedNights: ["2026-07-02", "2026-07-03"],
    promotions: [
      {
        allocationId: "alloc-9",
        bookingId: "booking-4",
        bookingGuestId: "guest-9",
        guestName: "Dan Moss",
        lodgeId: "lodge-1",
        roomId: "room-1",
        roomName: "Kea",
        bedId: "bed-1",
        bedName: "Bed 1",
        stayDate: "2026-07-02",
      },
    ],
    reopenedBookings: [{ bookingId: "booking-1", memberName: "Ana Reid" }],
  };
}

const REMOVAL_WINDOW = {
  scope: { type: "WINDOW", lodgeId: "lodge-1", from: "2026-07-01", to: "2026-07-08" },
  categories: ["AUTO_DRAFT", "MANUAL_DRAFT"],
};

// ---------------------------------------------------------------------------
// The board
// ---------------------------------------------------------------------------

describe("get_bed_allocation_board", () => {
  it("answers the board without the approver's name, debugging fields or settings provenance", async () => {
    h.getDashboard.mockResolvedValue(dashboardFixture());

    const { connection, browser } = await expectActionContract({
      actionId: "get_bed_allocation_board",
      handler: getBoard,
      args: { from: "2026-07-01", to: "2026-07-08", lodgeId: "lodge-1" },
    });

    expect(h.requireAdmin).toHaveBeenCalledWith(VIEW);
    expect(h.getDashboard).toHaveBeenCalledWith(
      expect.objectContaining({ lodgeId: "lodge-1", bookingId: null, range: expect.objectContaining({ fromDate: "2026-07-01", toDate: "2026-07-08" }) }),
    );
    expect(browser).toEqual(asJson({ ...dashboardFixture(), scopedLodgeId: "lodge-1" }));
    expect(connection).toMatchObject({
      scopedLodgeId: "lodge-1",
      settings: { autoAllocationEnabled: true, allocationPriorityOrder: ["BOOKING_COHESION", "REQUESTED_ROOM"] },
      allocations: [{ id: "alloc-1", guestName: "Ana Reid", approvedAt: "2026-06-20T00:00:00.000Z" }],
      custodianHolds: [{ memberName: "Cara Lee", bedId: "bed-1" }],
    });
    const projected = connection as {
      allocations: Array<Record<string, unknown>>;
      settings: Record<string, unknown>;
      custodianHolds: Array<Record<string, unknown>>;
    };
    expect(projected.allocations[0]).not.toHaveProperty("approvedByName");
    expect(projected.allocations[0]).not.toHaveProperty("bookingStatus");
    expect(projected.settings).not.toHaveProperty("updatedByMemberId");
    expect(projected.custodianHolds[0]).not.toHaveProperty("assignmentId");
  });

  it("keeps the module check: a club with bed allocation off answers 404, to a connection too", async () => {
    h.moduleEnabled.mockResolvedValue(false);
    const response = await getBoard(
      new NextRequest("https://club.example.test/api/admin/bed-allocation", {
        headers: { [MCP_PRINCIPAL_HEADER]: "contract-test-principal" },
      }),
    );
    expect(response.status).toBe(404);
    expect(h.getDashboard).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Placing and moving guests
// ---------------------------------------------------------------------------

describe("allocate_guest_bed_night", () => {
  it("answers the allocation row without who approved it or row timestamps", async () => {
    h.allocateBed.mockResolvedValue({ allocation: allocationRow(), promotedPartner: null });

    const { connection, browser } = await expectActionContract({
      actionId: "allocate_guest_bed_night",
      handler: allocateNight,
      args: { bookingGuestId: "guest-1", bedId: "bed-1", stayDate: "2026-07-02" },
    });

    expect(h.requireAdmin).toHaveBeenCalledWith(EDIT);
    expect(h.allocateBed).toHaveBeenCalledWith({ bookingGuestId: "guest-1", bedId: "bed-1", stayDate: "2026-07-02" });
    expect(connection).toEqual({
      allocation: {
        id: "alloc-1",
        bookingId: "booking-1",
        bookingGuestId: "guest-1",
        roomId: "room-1",
        bedId: "bed-1",
        stayDate: "2026-07-02T00:00:00.000Z",
        source: "MANUAL",
        isSecondOccupant: false,
      },
    });
    expect(browser).toEqual(asJson({ allocation: allocationRow() }));
  });
});

describe("allocate_guest_bed_nights", () => {
  it("answers the rows written, the conflicts and the skipped nights", async () => {
    h.allocateNights.mockResolvedValue({
      allocations: [allocationRow()],
      conflicts: [{ stayDate: "2026-07-03", reason: "BED_TAKEN" }],
      skipped: ["2026-07-04"],
      promotedPartners: [],
    });

    const { connection, browser } = await expectActionContract({
      actionId: "allocate_guest_bed_nights",
      handler: allocateNights,
      args: { bookingGuestId: "guest-1", bedId: "bed-1", stayDates: ["2026-07-02", "2026-07-03", "2026-07-04"] },
    });

    expect(h.requireAdmin).toHaveBeenCalledWith(EDIT);
    const expected = {
      allocations: [
        {
          id: "alloc-1",
          bookingId: "booking-1",
          bookingGuestId: "guest-1",
          roomId: "room-1",
          bedId: "bed-1",
          stayDate: "2026-07-02",
          source: "MANUAL",
        },
      ],
      conflicts: [{ stayDate: "2026-07-03", reason: "BED_TAKEN" }],
      skipped: ["2026-07-04"],
    };
    // The route already sends only these fields; the two answers match.
    expect(connection).toEqual(expected);
    expect(browser).toEqual(expected);
  });
});

describe("assign_guest_bed_range", () => {
  it("answers the range report, leaving out the partner rows the route audits", async () => {
    const report = {
      applied: true,
      partialByConsent: true,
      bookingId: "booking-1",
      bookingGuestId: "guest-1",
      guestName: "Ana Reid",
      bedId: "bed-1",
      bedName: "Bed 1",
      roomName: "Kea",
      fromDate: "2026-07-02",
      toDate: "2026-07-04",
      requestedNights: ["2026-07-02", "2026-07-03"],
      freeNights: ["2026-07-02"],
      writtenNights: ["2026-07-02"],
      refusals: [
        {
          stayDate: "2026-07-03",
          category: "BED_TAKEN",
          occupiedBy: { guestName: "Ben Hart", memberName: "Ben Hart", bookingId: "booking-2", holdsCapacity: false },
          hold: { bookingId: "booking-2", memberName: "Ben Hart", ownBooking: false },
        },
      ],
    };
    h.assignRange.mockResolvedValue({ ...report, promotedPartners: [allocationRow()] });

    const { connection, browser } = await expectActionContract({
      actionId: "assign_guest_bed_range",
      handler: assignRange,
      args: { bookingGuestId: "guest-1", bedId: "bed-1", from: "2026-07-02", to: "2026-07-04", nights: ["2026-07-02"] },
    });

    expect(h.requireAdmin).toHaveBeenCalledWith(EDIT);
    expect(h.assignRange).toHaveBeenCalledWith(
      expect.objectContaining({ nights: ["2026-07-02"], approvedByMemberId: "officer-1" }),
    );
    expect(connection).toEqual({ result: report });
    expect(browser).toEqual({ result: report });
  });
});

describe("preview_bed_allocation_move", () => {
  it("answers the preview and its digest, changing nothing", async () => {
    h.previewMove.mockResolvedValue(movePreviewFixture());

    const { connection, browser } = await expectActionContract({
      actionId: "preview_bed_allocation_move",
      handler: previewMove,
      args: { anchorAllocationId: "alloc-1", destinationBedId: "bed-2", scope: "BOOKING_GUEST" },
    });

    // A preview needs only view access, as on the board.
    expect(h.requireAdmin).toHaveBeenCalledWith(VIEW);
    expect(h.applyMove).not.toHaveBeenCalled();
    const projected: Record<string, unknown> = { ...movePreviewFixture() };
    delete projected.digestVersion;
    expect(connection).toEqual(projected);
    expect(browser).toEqual(movePreviewFixture());
  });
});

describe("move_bed_allocation", () => {
  it("applies the previewed move and answers what moved", async () => {
    const result = { noop: false, movedRowCount: 1, promotedRowCount: 0, affectedNights: ["2026-07-02"] };
    h.applyMove.mockResolvedValue(result);

    const { connection, browser } = await expectActionContract({
      actionId: "move_bed_allocation",
      handler: moveAllocation,
      args: { anchorAllocationId: "alloc-1", destinationBedId: "bed-2", scope: "ALLOCATION_NIGHT", previewDigest: DIGEST },
    });

    expect(h.requireAdmin).toHaveBeenCalledWith(EDIT);
    expect(h.applyMove).toHaveBeenCalledWith({
      request: { anchorAllocationId: "alloc-1", destinationBedId: "bed-2", scope: "ALLOCATION_NIGHT", previewDigest: DIGEST },
      actorMemberId: "officer-1",
    });
    expect(h.moveSameDate).not.toHaveBeenCalled();
    expect(connection).toEqual(result);
    expect(browser).toEqual(result);
  });

  it("sends a connection only `noop` from the older id-list move the catalogue does not offer", async () => {
    h.moveSameDate.mockResolvedValue({ noop: false, allocations: [allocationRow()], promotedPartners: [] });
    const response = await moveAllocation(
      new NextRequest("https://club.example.test/api/admin/bed-allocation/allocations", {
        method: "PATCH",
        headers: { [MCP_PRINCIPAL_HEADER]: "contract-test-principal", "content-type": "application/json" },
        body: JSON.stringify({ allocationIds: ["alloc-1"], bedId: "bed-2" }),
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ noop: false });
  });
});

describe("auto_allocate_beds", () => {
  it("answers how many draft rows were written", async () => {
    h.autoAllocate.mockResolvedValue({ count: 4 });

    const { connection, browser } = await expectActionContract({
      actionId: "auto_allocate_beds",
      handler: autoAllocate,
      args: { lodgeId: "lodge-1", from: "2026-07-01", to: "2026-07-08" },
    });

    expect(h.requireAdmin).toHaveBeenCalledWith(EDIT);
    expect(h.autoAllocate).toHaveBeenCalledWith(expect.objectContaining({ lodgeId: "lodge-1" }));
    expect(connection).toEqual({ createdCount: 4 });
    expect(browser).toEqual({ createdCount: 4 });
  });
});

describe("approve_bed_allocations", () => {
  it("approves at the named lodge and answers the count", async () => {
    h.approve.mockResolvedValue({ count: 2 });

    const { connection, browser } = await expectActionContract({
      actionId: "approve_bed_allocations",
      handler: approve,
      args: { lodgeId: "lodge-1", bookingId: "booking-1" },
    });

    expect(h.requireAdmin).toHaveBeenCalledWith(EDIT);
    expect(h.approve).toHaveBeenCalledWith(
      expect.objectContaining({ approvedByMemberId: "officer-1", bookingId: "booking-1", lodgeId: "lodge-1" }),
    );
    expect(connection).toEqual({ approvedCount: 2 });
    expect(browser).toEqual({ approvedCount: 2 });
  });
});

describe("preview_bed_allocation_removal", () => {
  it("answers the preview and its digest without echoing the scope, changing nothing", async () => {
    h.previewRemoval.mockResolvedValue(removalPreviewFixture());

    const { connection, browser } = await expectActionContract({
      actionId: "preview_bed_allocation_removal",
      handler: previewRemoval,
      args: REMOVAL_WINDOW,
    });

    expect(h.requireAdmin).toHaveBeenCalledWith(VIEW);
    expect(h.previewRemoval).toHaveBeenCalledWith(REMOVAL_WINDOW);
    expect(h.applyRemoval).not.toHaveBeenCalled();
    const fixture = removalPreviewFixture();
    const promotion: Record<string, unknown> = { ...fixture.promotions[0] };
    delete promotion.lodgeId;
    delete promotion.roomId;
    const projected: Record<string, unknown> = { ...fixture, promotions: [promotion] };
    delete projected.digestVersion;
    delete projected.scope;
    expect(connection).toEqual(projected);
    expect(browser).toEqual(removalPreviewFixture());
  });
});

describe("remove_bed_allocations", () => {
  it("applies the reviewed preview and answers what was removed", async () => {
    const result = { removedRowCount: 3, promotedRowCount: 1, affectedBookingCount: 1, affectedNights: ["2026-07-02"] };
    h.applyRemoval.mockResolvedValue(result);

    const { connection, browser } = await expectActionContract({
      actionId: "remove_bed_allocations",
      handler: applyRemoval,
      args: { ...REMOVAL_WINDOW, previewDigest: DIGEST },
    });

    expect(h.requireAdmin).toHaveBeenCalledWith(EDIT);
    expect(h.applyRemoval).toHaveBeenCalledWith({
      request: { ...REMOVAL_WINDOW, previewDigest: DIGEST },
      actorMemberId: "officer-1",
    });
    expect(connection).toEqual(result);
    expect(browser).toEqual(result);
  });
});

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

const PROJECTED_SETTINGS = {
  settings: {
    autoAllocationEnabled: true,
    allocationPriorityOrder: ["BOOKING_COHESION", "REQUESTED_ROOM"],
    source: "LODGE",
    updatedAt: "2026-06-01T00:00:00.000Z",
  },
};

describe("get_bed_allocation_settings", () => {
  it("answers the effective settings without who saved them", async () => {
    h.getSettings.mockResolvedValue(settingsFixture());

    const { connection, browser } = await expectActionContract({
      actionId: "get_bed_allocation_settings",
      handler: getSettings,
      args: { lodgeId: "lodge-1" },
    });

    expect(h.requireAdmin).toHaveBeenCalledWith(VIEW);
    expect(h.getSettings).toHaveBeenCalledWith(undefined, "lodge-1");
    expect(connection).toEqual(PROJECTED_SETTINGS);
    expect(browser).toEqual({ settings: settingsFixture() });
  });
});

describe("update_bed_allocation_settings", () => {
  it("saves both fields for the lodge and answers the saved settings", async () => {
    h.updateSettings.mockResolvedValue(settingsFixture());

    const { connection, browser } = await expectActionContract({
      actionId: "update_bed_allocation_settings",
      handler: putSettings,
      args: { lodgeId: "lodge-1", autoAllocationEnabled: true, allocationPriorityOrder: ["BOOKING_COHESION", "REQUESTED_ROOM"] },
    });

    expect(h.requireAdmin).toHaveBeenCalledWith(EDIT);
    expect(h.updateSettings).toHaveBeenCalledWith({
      autoAllocationEnabled: true,
      allocationPriorityOrder: ["BOOKING_COHESION", "REQUESTED_ROOM"],
      updatedByMemberId: "officer-1",
      lodgeId: "lodge-1",
    });
    expect(connection).toEqual(PROJECTED_SETTINGS);
    expect(browser).toEqual({ settings: settingsFixture() });
  });
});

// ---------------------------------------------------------------------------
// Rooms
// ---------------------------------------------------------------------------

const PROJECTED_INVENTORY_ROOM = {
  id: "room-1",
  name: "Kea",
  sortOrder: 1,
  active: true,
  notes: "Downstairs",
  beds: [{ id: "bed-1", name: "Bed 1", sortOrder: 1, active: true, bedType: "BUNK_TOP", bunkGroup: "A" }],
};

describe("list_lodge_rooms_and_beds", () => {
  it("answers the rooms, beds and capacity", async () => {
    const configuration = {
      rooms: [dashboardRoom()],
      capacity: {
        capacity: 10,
        source: "configured_beds",
        bedAllocationEnabled: true,
        activeBedCount: 10,
        fallbackCapacity: 0,
        activeDoubleBedCount: 1,
        partnerSharedHeadroom: 1,
      },
      canImportFromConfig: false,
      configBeds: [{ id: "dorm", name: "Dorm", capacity: 10, type: "dorm" }],
    };
    h.getRooms.mockResolvedValue(configuration);

    const { connection, browser } = await expectActionContract({
      actionId: "list_lodge_rooms_and_beds",
      handler: listRooms,
      args: { lodgeId: "lodge-1" },
    });

    expect(h.requireAdmin).toHaveBeenCalledWith(VIEW);
    expect(h.getRooms).toHaveBeenCalledWith(undefined, "lodge-1");
    expect(connection).toEqual({ ...configuration, rooms: [PROJECTED_INVENTORY_ROOM] });
    expect(browser).toEqual(configuration);
  });
});

describe("create_lodge_room", () => {
  it("creates the room at the lodge and answers it without timestamps", async () => {
    h.createRoom.mockResolvedValue(roomRow());

    const { connection, browser } = await expectActionContract({
      actionId: "create_lodge_room",
      handler: createRoom,
      args: { name: "Kea", sortOrder: 1, notes: "Downstairs", lodgeId: "lodge-1" },
    });

    expect(h.requireAdmin).toHaveBeenCalledWith(EDIT);
    expect(h.createRoom).toHaveBeenCalledWith({ name: "Kea", sortOrder: 1, active: true, notes: "Downstairs", lodgeId: "lodge-1" });
    expect(connection).toEqual({ room: PROJECTED_ROOM });
    expect(browser).toEqual(asJson({ room: roomRow() }));
  });
});

describe("create_lodge_rooms_in_bulk", () => {
  it("answers how many rooms and beds were created", async () => {
    h.createRoomsBulk.mockResolvedValue({ createdRoomCount: 3, createdBedCount: 12 });

    const { connection, browser } = await expectActionContract({
      actionId: "create_lodge_rooms_in_bulk",
      handler: createRoomsBulk,
      args: { roomCount: 3, bedsPerRoom: 4, namePrefix: "Bunkroom", lodgeId: "lodge-1" },
    });

    expect(h.requireAdmin).toHaveBeenCalledWith(EDIT);
    expect(h.createRoomsBulk).toHaveBeenCalledWith({ roomCount: 3, bedsPerRoom: 4, namePrefix: "Bunkroom", lodgeId: "lodge-1" });
    expect(connection).toEqual({ createdRoomCount: 3, createdBedCount: 12 });
    expect(browser).toEqual({ createdRoomCount: 3, createdBedCount: 12 });
  });
});

describe("import_rooms_and_beds_from_config", () => {
  it("answers the counts and the imported rooms", async () => {
    const result = { createdRoomCount: 1, createdBedCount: 1, rooms: [dashboardRoom()] };
    h.importRooms.mockResolvedValue(result);

    const { connection, browser } = await expectActionContract({
      actionId: "import_rooms_and_beds_from_config",
      handler: importRooms,
    });

    expect(h.requireAdmin).toHaveBeenCalledWith(EDIT);
    expect(connection).toEqual({ createdRoomCount: 1, createdBedCount: 1, rooms: [PROJECTED_INVENTORY_ROOM] });
    expect(browser).toEqual(result);
  });
});

describe("update_lodge_room", () => {
  it("changes only the fields sent and answers the room", async () => {
    h.updateRoom.mockResolvedValue(roomRow());

    const { connection, browser } = await expectActionContract({
      actionId: "update_lodge_room",
      handler: updateRoom,
      args: { id: "room-1", notes: "Downstairs" },
    });

    expect(h.requireAdmin).toHaveBeenCalledWith(EDIT);
    expect(h.updateRoom).toHaveBeenCalledWith({ id: "room-1", notes: "Downstairs" });
    expect(connection).toEqual({ room: PROJECTED_ROOM });
    expect(browser).toEqual(asJson({ room: roomRow() }));
  });
});

describe("delete_lodge_room", () => {
  it("deletes the room and answers it", async () => {
    h.deleteRoom.mockResolvedValue(roomRow());

    const { connection, browser } = await expectActionContract({
      actionId: "delete_lodge_room",
      handler: deleteRoom,
      args: { id: "room-1" },
    });

    expect(h.requireAdmin).toHaveBeenCalledWith(EDIT);
    expect(h.deleteRoom).toHaveBeenCalledWith({ id: "room-1" });
    expect(connection).toEqual({ room: PROJECTED_ROOM });
    expect(browser).toEqual(asJson({ room: roomRow() }));
  });
});

// ---------------------------------------------------------------------------
// Beds
// ---------------------------------------------------------------------------

describe("create_lodge_bed", () => {
  it("creates the bed in the room and answers it without timestamps", async () => {
    h.createBed.mockResolvedValue(bedRow());

    const { connection, browser } = await expectActionContract({
      actionId: "create_lodge_bed",
      handler: createBed,
      args: { roomId: "room-1", name: "Bed 1", sortOrder: 1, bedType: "DOUBLE", bunkGroup: "A" },
    });

    expect(h.requireAdmin).toHaveBeenCalledWith(EDIT);
    expect(h.createBed).toHaveBeenCalledWith({
      roomId: "room-1",
      name: "Bed 1",
      sortOrder: 1,
      active: true,
      bedType: "DOUBLE",
      bunkGroup: "A",
    });
    expect(connection).toEqual({ bed: PROJECTED_BED });
    expect(browser).toEqual(asJson({ bed: bedRow() }));
  });
});

describe("update_lodge_bed", () => {
  it("changes only the fields sent and answers the bed", async () => {
    h.updateBed.mockResolvedValue(bedRow());

    const { connection, browser } = await expectActionContract({
      actionId: "update_lodge_bed",
      handler: updateBed,
      args: { id: "bed-1", bedType: "DOUBLE" },
    });

    expect(h.requireAdmin).toHaveBeenCalledWith(EDIT);
    expect(h.updateBed).toHaveBeenCalledWith({ id: "bed-1", bedType: "DOUBLE" });
    expect(connection).toEqual({ bed: PROJECTED_BED });
    expect(browser).toEqual(asJson({ bed: bedRow() }));
  });
});

describe("delete_lodge_bed", () => {
  it("deletes the bed and answers it", async () => {
    h.deleteBed.mockResolvedValue(bedRow());

    const { connection, browser } = await expectActionContract({
      actionId: "delete_lodge_bed",
      handler: deleteBed,
      args: { id: "bed-1" },
    });

    expect(h.requireAdmin).toHaveBeenCalledWith(EDIT);
    expect(h.deleteBed).toHaveBeenCalledWith({ id: "bed-1" });
    expect(connection).toEqual({ bed: PROJECTED_BED });
    expect(browser).toEqual(asJson({ bed: bedRow() }));
  });
});
