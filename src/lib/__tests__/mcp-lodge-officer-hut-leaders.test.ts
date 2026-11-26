/**
 * ALP-722 (`INV-MCP-006`): the Lodge Operations hut-leader and chore-roster
 * actions an officer's AI app connection may run: hut leader assignments and
 * their pickers, the nights with no leader, who may lead a school booking's
 * nights, and the chore roster. Each route answers the browser as before; the
 * connection gets exactly the action's `returns` fields
 * (`expectActionContract`). Every handler runs twice (connection, then
 * browser), so the mocks answer both runs.
 *
 * The services behind the routes are mocked at their module boundary: what is
 * pinned here is what each route sends, to whom, and with which arguments.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const prisma = {
    $transaction: vi.fn(),
    $executeRaw: vi.fn(),
    hutLeaderAssignment: { findMany: vi.fn(), findUnique: vi.fn(), create: vi.fn() },
    member: { findUnique: vi.fn() },
    bookingGuest: { findMany: vi.fn() },
    lodge: { findUnique: vi.fn() },
  };
  return {
    prisma,
    requireAdmin: vi.fn(),
    resolveLodge: vi.fn(),
    moduleEnabled: vi.fn(),
    sendAssignmentEmail: vi.fn(),
    overlapRefusal: vi.fn(),
    stayRefusal: vi.fn(),
    assertStayed: vi.fn(),
    recordAssignmentAudit: vi.fn(),
    schoolNightsWarning: vi.fn(),
    savedSchoolNightsWarning: vi.fn(),
    applyEdit: vi.fn(),
    deleteUnderLock: vi.fn(),
    validateBedHold: vi.fn(),
    bedOptions: vi.fn(),
    loadCover: vi.fn(),
    mayLeadNight: vi.fn(),
    listNightLeaders: vi.fn(),
    unassignedDates: vi.fn(),
    loadKinds: vi.fn(),
    saveKinds: vi.fn(),
    createAuditLog: vi.fn(),
    rosterForDate: vi.fn(),
    updateRoster: vi.fn(),
    rosterMonthStatus: vi.fn(),
  };
});

vi.mock("@/lib/session-guards", () => ({ requireAdmin: h.requireAdmin }));
vi.mock("@/lib/prisma", () => ({ prisma: h.prisma }));
vi.mock("@/lib/logger", () => ({ default: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock("@/lib/lodges", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/lodges")),
  resolveOptionalActiveLodgeId: h.resolveLodge,
}));
vi.mock("@/lib/admin-modules", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/admin-modules")),
  isEffectiveModuleEnabled: h.moduleEnabled,
}));
vi.mock("@/lib/email", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/email")),
  sendHutLeaderAssignmentEmail: h.sendAssignmentEmail,
}));
vi.mock("@/lib/lodge-pin-session", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/lodge-pin-session")),
  generateHutLeaderPin: () => "482913",
  hashHutLeaderPin: async () => "hashed-pin",
}));
vi.mock("@/lib/capacity", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/capacity")),
  acquireLodgeCapacityLock: vi.fn(),
}));
vi.mock("@/lib/audit", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/audit")),
  createAuditLog: h.createAuditLog,
}));
vi.mock("@/lib/hut-leader-overlap-guard", () => ({ findHutLeaderOverlapRefusal: h.overlapRefusal }));
vi.mock("@/lib/hut-leader-stayed-nights", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/hut-leader-stayed-nights")),
  findHutLeaderStayRefusal: h.stayRefusal,
  assertHutLeaderNightsStayed: h.assertStayed,
}));
vi.mock("@/lib/hut-leader-assignment-audit", () => ({ recordHutLeaderAssignmentAudit: h.recordAssignmentAudit }));
vi.mock("@/lib/hut-leader-school-nights-warning", () => ({
  readHutLeaderSchoolNightsWarning: h.schoolNightsWarning,
  readSavedHutLeaderSchoolNightsWarning: h.savedSchoolNightsWarning,
}));
vi.mock("@/lib/hut-leader-assignment-service", () => ({
  applyHutLeaderAssignmentEditUnderLocks: h.applyEdit,
  deleteHutLeaderAssignmentUnderLodgeLock: h.deleteUnderLock,
  validateCustodianBedHoldAndHoldAmendment: h.validateBedHold,
}));
vi.mock("@/lib/custodian-assignment", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/custodian-assignment")),
  listCustodianBedOptions: h.bedOptions,
}));
vi.mock("@/lib/hut-leader-night-cover", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/hut-leader-night-cover")),
  loadHutLeaderNightCover: h.loadCover,
  memberMayLeadNight: h.mayLeadNight,
  listHutLeaderNightLeaders: h.listNightLeaders,
}));
vi.mock("@/lib/hut-leader-coverage", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/hut-leader-coverage")),
  getUnassignedHutLeaderDates: h.unassignedDates,
}));
vi.mock("@/lib/lodge-settings", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/lodge-settings")),
  loadSchoolHutLeaderKinds: h.loadKinds,
  saveSchoolHutLeaderKinds: h.saveKinds,
}));
vi.mock("@/lib/admin-roster-service", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/admin-roster-service")),
  getAdminRosterForDate: h.rosterForDate,
  updateAdminRosterForDate: h.updateRoster,
}));
vi.mock("@/lib/roster-status", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/roster-status")),
  getRosterMonthStatus: h.rosterMonthStatus,
}));

import { GET as listHutLeaders, POST as createHutLeader } from "@/app/api/admin/hut-leaders/route";
import { DELETE as deleteHutLeader, PUT as putHutLeader } from "@/app/api/admin/hut-leaders/[id]/route";
import { GET as listBedOptions } from "@/app/api/admin/hut-leaders/available-beds/route";
import { GET as listCandidates } from "@/app/api/admin/hut-leaders/eligible-members/route";
import { GET as listUnassignedNights } from "@/app/api/admin/hut-leaders/unassigned-dates/route";
import {
  GET as getSchoolKinds,
  PUT as putSchoolKinds,
} from "@/app/api/admin/lodge-settings/school-hut-leaders/route";
import { GET as getRoster, PUT as putRoster } from "@/app/api/admin/roster/[date]/route";
import { GET as getRosterStatus } from "@/app/api/admin/roster/status/route";
import { expectActionContract, officerMemberSession } from "@/lib/__tests__/helpers/mcp-action-contract";
import { mcpActionInputSchema, type McpAction } from "@/lib/mcp/catalogue";
import { LODGE_HUT_LEADER_MCP_ACTIONS } from "@/lib/mcp/catalogue/lodge-hut-leaders";

function day(date: string) {
  return new Date(`${date}T00:00:00.000Z`);
}

function entry(id: string): McpAction {
  const action = LODGE_HUT_LEADER_MCP_ACTIONS.find((candidate) => candidate.id === id);
  if (!action) throw new Error(`${id} is not in the hut-leader catalogue module`);
  return action;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.requireAdmin.mockResolvedValue({ ok: true, session: officerMemberSession() });
  h.prisma.$transaction.mockImplementation(async (fn: (tx: typeof h.prisma) => unknown) => fn(h.prisma));
  h.prisma.$executeRaw.mockResolvedValue(1);
  // An explicit lodge resolves to itself; none means the club's default.
  h.resolveLodge.mockImplementation(async (_db: unknown, lodgeId?: string | null) => lodgeId ?? "lodge-1");
  h.moduleEnabled.mockResolvedValue(true);
});

// ---------------------------------------------------------------------------
// Hut leader assignments
// ---------------------------------------------------------------------------

function assignmentRow() {
  return {
    id: "hla-1",
    memberId: "member-2",
    startDate: day("2026-07-10"),
    endDate: day("2026-07-12"),
    hutLeaderPin: "stored-hash",
    lodgeId: "lodge-1",
    bedId: "bed-1",
    isCustodian: false,
    source: "MANUAL",
    createdAt: new Date("2026-06-20T03:00:00.000Z"),
    updatedAt: new Date("2026-06-20T03:00:00.000Z"),
    member: { id: "member-2", firstName: "Aroha", lastName: "Ngata", email: "aroha@example.test" },
    lodge: { id: "lodge-1", name: "Main Lodge" },
    bed: { id: "bed-1", name: "Bunk 1", room: { name: "Room A" } },
  };
}

describe("list_hut_leaders", () => {
  it("is the one listed tool of this module", () => {
    expect(LODGE_HUT_LEADER_MCP_ACTIONS.filter((action) => action.core).map((action) => action.id)).toEqual([
      "list_hut_leaders",
    ]);
  });

  it("sends a connection each assignment without the leader's email, the row stamp or any PIN", async () => {
    h.prisma.hutLeaderAssignment.findMany.mockResolvedValue([assignmentRow()]);

    const { connection, browser } = await expectActionContract({
      actionId: "list_hut_leaders",
      handler: listHutLeaders,
      args: { lodgeId: "lodge-1" },
    });

    expect(h.prisma.hutLeaderAssignment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { lodgeId: "lodge-1" }, orderBy: { startDate: "desc" } }),
    );
    expect(connection).toEqual({
      bedAllocationEnabled: true,
      assignments: [
        {
          id: "hla-1",
          memberId: "member-2",
          memberName: "Aroha Ngata",
          startDate: "2026-07-10",
          endDate: "2026-07-12",
          lodgeId: "lodge-1",
          lodgeName: "Main Lodge",
          bedId: "bed-1",
          bedName: "Bunk 1",
          bedRoomName: "Room A",
          isCustodian: false,
          source: "MANUAL",
        },
      ],
    });
    expect(JSON.stringify(connection)).not.toMatch(/aroha@|stored-hash|Pin/);
    expect(browser).toEqual({
      bedAllocationEnabled: true,
      assignments: [
        expect.objectContaining({ memberEmail: "aroha@example.test", createdAt: "2026-06-20T03:00:00.000Z" }),
      ],
    });
  });

  it("still refuses a missing lodge with the page's 400", async () => {
    const response = await listHutLeaders(new NextRequest("https://club.example.test/api/admin/hut-leaders"));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "A valid lodgeId is required." });
  });
});

describe("create_hut_leader_assignment", () => {
  it("creates the assignment, emails the PIN to the leader and never answers it", async () => {
    const member = {
      id: "member-2",
      active: true,
      email: "aroha@example.test",
      firstName: "Aroha",
      ageTier: "ADULT",
      accessRoles: [{ role: "USER" }],
    };
    h.prisma.member.findUnique.mockResolvedValue(member);
    h.overlapRefusal.mockResolvedValue(null);
    h.stayRefusal.mockResolvedValue(null);
    h.prisma.hutLeaderAssignment.create.mockResolvedValue({ id: "hla-9" });
    h.schoolNightsWarning.mockResolvedValue("Not accepted for school nights 2026-07-11.");

    const { connection, browser } = await expectActionContract({
      actionId: "create_hut_leader_assignment",
      handler: createHutLeader,
      args: { memberId: "member-2", startDate: "2026-07-10", endDate: "2026-07-12", lodgeId: "lodge-1" },
    });

    expect(h.prisma.hutLeaderAssignment.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        memberId: "member-2",
        startDate: day("2026-07-10"),
        endDate: day("2026-07-12"),
        hutLeaderPin: "hashed-pin",
        lodgeId: "lodge-1",
        source: "MANUAL",
        isCustodian: false,
      }),
    });
    expect(h.sendAssignmentEmail).toHaveBeenCalledWith(
      expect.objectContaining({ email: "aroha@example.test", pin: "482913", assignmentId: "hla-9" }),
    );
    const expected = {
      id: "hla-9",
      emailSent: true,
      minorCustodianWarning: null,
      schoolNightsWarning: "Not accepted for school nights 2026-07-11.",
    };
    expect(connection).toEqual(expected);
    expect(browser).toEqual(expected);
    expect(JSON.stringify(connection)).not.toContain("482913");
  });
});

describe("update_hut_leader_assignment", () => {
  it("applies the edit under the locks and answers success with any warning", async () => {
    h.prisma.hutLeaderAssignment.findUnique.mockResolvedValue(assignmentRow());
    h.applyEdit.mockResolvedValue(null);
    h.savedSchoolNightsWarning.mockResolvedValue(null);

    const { connection, browser } = await expectActionContract({
      actionId: "update_hut_leader_assignment",
      handler: putHutLeader,
      args: { id: "hla-1", endDate: "2026-07-13", bedId: null },
    });

    expect(h.applyEdit).toHaveBeenCalledWith(
      expect.objectContaining({
        assignmentId: "hla-1",
        intendedLodgeId: "lodge-1",
        updateData: { endDate: day("2026-07-13"), bedId: null },
        bedIdProvided: true,
      }),
    );
    expect(connection).toEqual({ success: true, schoolNightsWarning: null });
    expect(browser).toEqual({ success: true, schoolNightsWarning: null });
  });
});

describe("delete_hut_leader_assignment", () => {
  it("deletes under the lodge lock and answers success", async () => {
    h.prisma.hutLeaderAssignment.findUnique.mockResolvedValue(assignmentRow());
    h.deleteUnderLock.mockResolvedValue(null);

    const { connection, browser } = await expectActionContract({
      actionId: "delete_hut_leader_assignment",
      handler: deleteHutLeader,
      args: { id: "hla-1" },
    });

    expect(h.deleteUnderLock).toHaveBeenCalledWith(
      expect.objectContaining({ assignmentId: "hla-1", lodgeId: "lodge-1", actorMemberId: "officer-1" }),
    );
    expect(connection).toEqual({ success: true });
    expect(browser).toEqual({ success: true });
  });
});

describe("list_hut_leader_bed_options", () => {
  it("answers every bed by room, without repeating the room on each bed", async () => {
    const option = {
      bedId: "bed-1",
      bedName: "Bunk 1",
      bedType: "SINGLE",
      roomId: "room-a",
      roomName: "Room A",
      available: false,
      allocatedNights: ["2026-07-11"],
      custodianHeldNights: ["2026-07-12"],
      heldByThisAssignment: false,
    };
    h.bedOptions.mockResolvedValue([option]);

    const { connection, browser } = await expectActionContract({
      actionId: "list_hut_leader_bed_options",
      handler: listBedOptions,
      args: { lodgeId: "lodge-1", startDate: "2026-07-10", endDate: "2026-07-12" },
    });

    expect(h.bedOptions).toHaveBeenCalledWith({
      lodgeId: "lodge-1",
      startDate: day("2026-07-10"),
      endDate: day("2026-07-12"),
      assignmentId: undefined,
    });
    expect(connection).toEqual({
      lodgeId: "lodge-1",
      rooms: [
        {
          roomId: "room-a",
          roomName: "Room A",
          beds: [
            {
              bedId: "bed-1",
              bedName: "Bunk 1",
              bedType: "SINGLE",
              available: false,
              allocatedNights: ["2026-07-11"],
              custodianHeldNights: ["2026-07-12"],
              heldByThisAssignment: false,
            },
          ],
        },
      ],
    });
    expect(browser).toEqual({ lodgeId: "lodge-1", rooms: [{ roomId: "room-a", roomName: "Room A", beds: [option] }] });
  });
});

describe("list_hut_leader_candidates", () => {
  it("answers each candidate's name and suggested nights, never their email", async () => {
    h.prisma.bookingGuest.findMany.mockResolvedValue([
      {
        memberId: "member-2",
        stayStart: day("2026-07-10"),
        stayEnd: day("2026-07-12"),
        nights: [{ stayDate: day("2026-07-10") }, { stayDate: day("2026-07-11") }],
        member: {
          id: "member-2",
          firstName: "Aroha",
          lastName: "Ngata",
          email: "aroha@example.test",
          active: true,
          hutLeaderEligible: true,
          hutLeaderEligibleAt: new Date("2025-05-01T00:00:00.000Z"),
        },
        booking: { id: "booking-1", checkIn: day("2026-07-10"), checkOut: day("2026-07-12") },
      },
    ]);
    h.loadCover.mockResolvedValue({ isCovered: () => false });
    h.mayLeadNight.mockReturnValue(true);

    const { connection, browser } = await expectActionContract({
      actionId: "list_hut_leader_candidates",
      handler: listCandidates,
      args: { lodgeId: "lodge-1", startDate: "2026-07-10", endDate: "2026-07-11" },
    });

    expect(connection).toEqual({
      members: [
        {
          id: "member-2",
          firstName: "Aroha",
          lastName: "Ngata",
          hutLeaderEligible: true,
          bookingCheckIn: "2026-07-10",
          bookingCheckOut: "2026-07-12",
          suggestedStartDate: "2026-07-10",
          suggestedEndDate: "2026-07-11",
          uncoveredNightCount: 2,
          schoolNightsNotAccepted: 0,
          fullyCovered: false,
        },
      ],
    });
    expect(JSON.stringify(connection)).not.toContain("aroha@");
    expect(browser).toEqual({
      members: [
        expect.objectContaining({
          email: "aroha@example.test",
          hutLeaderEligibleAt: "2025-05-01T00:00:00.000Z",
        }),
      ],
    });
  });
});

describe("list_nights_without_hut_leader", () => {
  const uncovered = {
    date: "2026-07-11",
    lodgeId: "lodge-1",
    lodgeName: "Main Lodge",
    lodgeActive: true,
    bookingCount: 2,
    guestCount: 5,
  };

  it("answers the upcoming nights with no leader when no window is given", async () => {
    h.unassignedDates.mockResolvedValue([uncovered]);

    const { connection, browser } = await expectActionContract({
      actionId: "list_nights_without_hut_leader",
      handler: listUnassignedNights,
      args: { lodgeId: "lodge-1" },
      oneOfSeveralAnswers: true,
    });

    expect(h.unassignedDates).toHaveBeenCalledWith({ scope: { kind: "lodge", lodgeId: "lodge-1" } });
    expect(connection).toEqual({ unassignedDates: [uncovered] });
    expect(browser).toEqual({ unassignedDates: [uncovered] });
  });

  it("adds who leads each covered night for a month", async () => {
    h.loadCover.mockResolvedValue({ kind: "cover" });
    h.unassignedDates.mockResolvedValue([uncovered]);
    h.listNightLeaders.mockReturnValue([
      { date: "2026-07-01", lodgeId: "lodge-1", leaders: [{ memberId: "member-2", name: "Aroha Ngata" }] },
    ]);

    const { connection, browser } = await expectActionContract({
      actionId: "list_nights_without_hut_leader",
      handler: listUnassignedNights,
      args: { lodgeId: "lodge-1", month: "2026-07" },
    });

    expect(h.loadCover).toHaveBeenCalledWith(h.prisma, {
      scope: { kind: "lodge", lodgeId: "lodge-1" },
      from: day("2026-06-30"),
      to: day("2026-07-31"),
      withNames: true,
    });
    const expected = {
      unassignedDates: [uncovered],
      coveredNights: [{ date: "2026-07-01", leaders: [{ memberId: "member-2", name: "Aroha Ngata" }] }],
    };
    expect(connection).toEqual(expected);
    expect(browser).toEqual(expected);
  });
});

// ---------------------------------------------------------------------------
// Who can be hut leader for school bookings
// ---------------------------------------------------------------------------

const KINDS = { teacherOnBooking: false, custodian: true, memberOnBooking: true, memberStayingSeparately: true };

describe("get_school_hut_leader_kinds", () => {
  it("answers the lodge's four kinds", async () => {
    h.prisma.lodge.findUnique.mockResolvedValue({ active: true });
    h.loadKinds.mockResolvedValue(KINDS);

    const { connection, browser } = await expectActionContract({
      actionId: "get_school_hut_leader_kinds",
      handler: getSchoolKinds,
      args: { lodgeId: "lodge-1" },
    });

    expect(h.loadKinds).toHaveBeenCalledWith(h.prisma, "lodge-1");
    expect(connection).toEqual({ kinds: KINDS });
    expect(browser).toEqual({ kinds: KINDS });
  });
});

describe("update_school_hut_leader_kinds", () => {
  it("saves all four kinds, audits the change and answers the saved kinds", async () => {
    const saved = { ...KINDS, teacherOnBooking: true };
    h.prisma.lodge.findUnique.mockResolvedValue({ active: true });
    h.saveKinds.mockResolvedValue({ previous: KINDS, saved });

    const { connection, browser } = await expectActionContract({
      actionId: "update_school_hut_leader_kinds",
      handler: putSchoolKinds,
      args: { lodgeId: "lodge-1", kinds: saved },
    });

    expect(h.saveKinds).toHaveBeenCalledWith({ lodgeId: "lodge-1", kinds: saved, updatedByMemberId: "officer-1" });
    expect(h.createAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: "LODGE_SETTINGS_UPDATED" }));
    expect(connection).toEqual({ kinds: saved });
    expect(browser).toEqual({ kinds: saved });
  });
});

// ---------------------------------------------------------------------------
// The chore roster
// ---------------------------------------------------------------------------

function rosterSnapshot() {
  return {
    date: "2026-07-10",
    lodgeId: "lodge-1",
    revision: "rev-abc",
    guests: [
      {
        id: "guest-1",
        bookingId: "booking-1",
        firstName: "Aroha",
        lastName: "Ngata",
        ageTier: "ADULT",
        isArriving: false,
        isDeparting: true,
        bookingGroupLabel: "Booking for Aroha Ngata",
      },
    ],
    assignments: [
      {
        id: "chore-assignment-1",
        choreTemplateId: "chore-1",
        choreTemplateName: "Sweep the drying room",
        choreDescription: "Brooms by the door",
        choreSortOrder: 1,
        bookingGuestId: "guest-1",
        guestName: "Aroha Ngata",
        guestAgeTier: "ADULT",
        bookingId: "booking-1",
        status: "SUGGESTED",
      },
    ],
    templates: [
      {
        id: "chore-1",
        name: "Sweep the drying room",
        description: "Brooms by the door",
        recommendedPeopleMin: 1,
        recommendedPeopleMax: 2,
        isEssential: true,
        ageRestriction: "ANY",
        conditionalNote: null,
        minAge: 0,
        sortOrder: 1,
        timeOfDay: "MORNING",
        frequencyMode: "DAILY",
        frequencyDays: null,
        frequencyDaysOfWeek: [],
        active: true,
        lodgeId: "lodge-1",
        createdAt: "2026-05-01T00:00:00.000Z",
        updatedAt: "2026-06-01T00:00:00.000Z",
        isDueOnDate: true,
      },
    ],
    guestHistory: { "guest-1": [{ date: "2026-07-08", choreName: "Dishes" }] },
    guestCount: 1,
  };
}

/** The snapshot as a connection gets it: the chores without their row stamps. */
function projectedRoster() {
  const snapshot = rosterSnapshot();
  return {
    ...snapshot,
    templates: snapshot.templates.map((template) => {
      const kept: Record<string, unknown> = { ...template };
      delete kept.createdAt;
      delete kept.updatedAt;
      return kept;
    }),
  };
}

describe("get_chore_roster", () => {
  it("answers the night's roster without the chores' row stamps", async () => {
    h.rosterForDate.mockResolvedValue({ body: rosterSnapshot() });

    const { connection, browser } = await expectActionContract({
      actionId: "get_chore_roster",
      handler: getRoster,
      args: { date: "2026-07-10", lodgeId: "lodge-1", includeNonEssential: "false" },
    });

    expect(h.rosterForDate).toHaveBeenCalledWith({
      date: day("2026-07-10"),
      dateString: "2026-07-10",
      regenerate: false,
      includeNonEssential: false,
      lodgeId: "lodge-1",
    });
    expect(connection).toEqual(projectedRoster());
    expect(browser).toEqual(rosterSnapshot());
  });

  it("never lets an app regenerate through the read: `regenerate` is not an argument", () => {
    const input = mcpActionInputSchema(entry("get_chore_roster"));
    expect(Object.keys(input.shape)).not.toContain("regenerate");
    expect(Object.keys(input.shape).sort()).toEqual(["date", "includeNonEssential", "lodgeId"]);
  });
});

describe("save_chore_roster", () => {
  it("sends the whole roster as a save and answers the saved roster", async () => {
    h.updateRoster.mockResolvedValue({ body: rosterSnapshot() });
    const assignments = [
      { rowKey: "row-1", assignmentId: "chore-assignment-1", choreTemplateId: "chore-1", bookingGuestId: "guest-1" },
    ];

    const { connection, browser } = await expectActionContract({
      actionId: "save_chore_roster",
      handler: putRoster,
      args: { date: "2026-07-10", lodgeId: "lodge-1", baseRevision: "rev-abc", acknowledgeCompletedReset: false, assignments },
    });

    expect(h.updateRoster).toHaveBeenCalledWith({
      date: day("2026-07-10"),
      dateString: "2026-07-10",
      data: { action: "save", baseRevision: "rev-abc", acknowledgeCompletedReset: false, assignments },
      lodgeId: "lodge-1",
      adminMemberId: "officer-1",
    });
    expect(connection).toEqual(projectedRoster());
    expect(browser).toEqual(rosterSnapshot());
  });
});

describe("regenerate_chore_roster", () => {
  it("sends a regenerate and answers success", async () => {
    h.updateRoster.mockResolvedValue({ body: { success: true } });

    const { connection, browser } = await expectActionContract({
      actionId: "regenerate_chore_roster",
      handler: putRoster,
      args: { date: "2026-07-10", overwriteConfirmed: true },
    });

    expect(h.updateRoster).toHaveBeenCalledWith(
      expect.objectContaining({ data: { action: "regenerate", overwriteConfirmed: true }, lodgeId: "lodge-1" }),
    );
    expect(connection).toEqual({ success: true });
    expect(browser).toEqual({ success: true });
  });
});

describe("confirm_chore_roster", () => {
  it("sends a confirm and answers success", async () => {
    h.updateRoster.mockResolvedValue({ body: { success: true } });

    const { connection, browser } = await expectActionContract({
      actionId: "confirm_chore_roster",
      handler: putRoster,
      args: { date: "2026-07-10", lodgeId: "lodge-1" },
    });

    expect(h.updateRoster).toHaveBeenCalledWith(expect.objectContaining({ data: { action: "confirm" } }));
    expect(connection).toEqual({ success: true });
    expect(browser).toEqual({ success: true });
  });
});

describe("email_chore_roster", () => {
  const sent = {
    success: true,
    partialFailure: true,
    sent: 3,
    failed: 1,
    skipped: 1,
    failures: [{ error: "Address rejected: aroha@example.test" }],
  };

  it("sends the email action and answers the counts, never a provider's failure text", async () => {
    h.updateRoster.mockResolvedValue({ body: sent });

    const { connection, browser } = await expectActionContract({
      actionId: "email_chore_roster",
      handler: putRoster,
      args: { date: "2026-07-10", lodgeId: "lodge-1" },
      oneOfSeveralAnswers: true,
    });

    expect(h.updateRoster).toHaveBeenCalledWith(expect.objectContaining({ data: { action: "email" } }));
    expect(connection).toEqual({ success: true, partialFailure: true, sent: 3, failed: 1, skipped: 1 });
    expect(browser).toEqual(sent);
  });

  it("answers a suppressed send as such", async () => {
    const suppressed = { success: true, suppressed: true, sent: 0, skipped: 0, failed: 0, failures: [] };
    h.updateRoster.mockResolvedValue({ body: suppressed });

    const { connection, browser } = await expectActionContract({
      actionId: "email_chore_roster",
      handler: putRoster,
      args: { date: "2026-07-10", notifyMember: false },
      oneOfSeveralAnswers: true,
    });

    expect(h.updateRoster).toHaveBeenCalledWith(
      expect.objectContaining({ data: { action: "email", notifyMember: false } }),
    );
    expect(connection).toEqual({ success: true, suppressed: true, sent: 0, skipped: 0, failed: 0 });
    expect(browser).toEqual(suppressed);
  });
});

describe("get_chore_roster_month_status", () => {
  it("answers each day's roster state for the month", async () => {
    const statuses = [
      { date: "2026-07-10", status: "needs-attention", stayingBookingCount: 3, uncoveredBookingCount: 1 },
    ];
    h.rosterMonthStatus.mockResolvedValue(statuses);

    const { connection, browser } = await expectActionContract({
      actionId: "get_chore_roster_month_status",
      handler: getRosterStatus,
      args: { month: "2026-07", lodgeId: "lodge-1" },
    });

    expect(h.rosterMonthStatus).toHaveBeenCalledWith({ month: "2026-07", lodgeId: "lodge-1" });
    expect(connection).toEqual({ month: "2026-07", statuses });
    expect(browser).toEqual({ month: "2026-07", statuses });
  });
});

describe("the module's kinds", () => {
  it("reads only with GETs and marks every change destructive", () => {
    for (const action of LODGE_HUT_LEADER_MCP_ACTIONS) {
      expect(action.kind, action.id).toBe(action.method === "GET" ? "read" : "destructive");
    }
  });

  it("offers no action on the kiosk's PIN reset", () => {
    expect(LODGE_HUT_LEADER_MCP_ACTIONS.some((action) => action.path.endsWith("/pin"))).toBe(false);
  });
});
