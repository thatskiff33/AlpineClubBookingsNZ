/**
 * ALP-722 (`INV-MCP-006`): the Lodge Operations chore and work-party actions
 * an officer's AI app connection may run. Each route answers the browser as
 * before; the connection gets exactly the action's `returns` fields
 * (`expectActionContract`). Every handler runs twice (connection, then
 * browser), so the mocks answer both runs.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const prisma = {
    $transaction: vi.fn(),
    choreTemplate: { findMany: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
    workPartyEvent: { findMany: vi.fn(), findUnique: vi.fn(), delete: vi.fn() },
    promoCode: { delete: vi.fn() },
    lodge: { findUnique: vi.fn() },
  };
  return {
    prisma,
    modules: { eventsCalendar: true },
    requireAdmin: vi.fn(),
    resolveLodge: vi.fn(),
    createAuditLog: vi.fn(),
    logAudit: vi.fn(),
    createWorkParty: vi.fn(),
    syncCreated: vi.fn(),
    updateWithCalendar: vi.fn(),
    addToCalendar: vi.fn(),
    removeCalendarEntries: vi.fn(),
  };
});

vi.mock("@/lib/session-guards", () => ({ requireAdmin: h.requireAdmin }));
vi.mock("@/lib/prisma", () => ({ prisma: h.prisma }));
vi.mock("@/lib/lodges", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/lodges")),
  resolveOptionalActiveLodgeId: h.resolveLodge,
}));
vi.mock("@/lib/capacity", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/capacity")),
  acquireLodgeCapacityLock: vi.fn(),
}));
vi.mock("@/lib/audit", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/audit")),
  createAuditLog: h.createAuditLog,
  logAudit: h.logAudit,
}));
vi.mock("@/lib/club-time/server", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/club-time/server")),
  clubTodayDateOnlyInstant: vi.fn(async () => new Date("2026-07-01T00:00:00.000Z")),
}));
vi.mock("@/lib/module-settings", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/module-settings")),
  loadEffectiveModuleFlags: vi.fn(async () => h.modules),
}));
vi.mock("@/lib/work-party", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/work-party")),
  createWorkPartyEventWithPromo: h.createWorkParty,
}));
vi.mock("@/lib/work-party-calendar", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/work-party-calendar")),
  syncCreatedWorkPartyCalendar: h.syncCreated,
  updateWorkPartyWithCalendar: h.updateWithCalendar,
  addWorkPartyToCalendar: h.addToCalendar,
}));
vi.mock("@/lib/calendar-work-party-entries", () => ({
  removeWorkPartyCalendarEventsInTransaction: h.removeCalendarEntries,
}));

import { GET as listChores, POST as createChore } from "@/app/api/admin/chores/route";
import { DELETE as deleteChore, PUT as putChore } from "@/app/api/admin/chores/[id]/route";
import { GET as listWorkParties, POST as createWorkParty } from "@/app/api/admin/work-parties/route";
import {
  DELETE as deleteWorkParty,
  GET as getWorkParty,
  PUT as putWorkParty,
} from "@/app/api/admin/work-parties/[id]/route";
import { POST as addWorkPartyToCalendar } from "@/app/api/admin/work-parties/[id]/calendar/route";
import { expectActionContract, officerMemberSession } from "@/lib/__tests__/helpers/mcp-action-contract";
import { LODGE_CHORE_WORK_PARTY_MCP_ACTIONS } from "@/lib/mcp/catalogue/lodge-chores-work-parties";

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
  h.modules.eventsCalendar = true;
  h.requireAdmin.mockResolvedValue({ ok: true, session: officerMemberSession() });
  h.prisma.$transaction.mockImplementation(async (fn: (tx: typeof h.prisma) => unknown) => fn(h.prisma));
  h.resolveLodge.mockImplementation(async (_db: unknown, lodgeId?: string | null) => lodgeId ?? "lodge-1");
  h.prisma.lodge.findUnique.mockResolvedValue({ active: true });
});

// ---------------------------------------------------------------------------
// Chores
// ---------------------------------------------------------------------------

const PROJECTED_CHORE = {
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
  frequencyMode: "SPECIFIC_DAYS",
  frequencyDays: null,
  frequencyDaysOfWeek: [1, 5],
  active: true,
  lodgeId: "lodge-1",
};

function choreRow() {
  return { ...PROJECTED_CHORE, ...STAMPS };
}

describe("list_chore_templates", () => {
  it("sends a connection the chores under `chores` without row stamps; the browser keeps the bare array", async () => {
    h.prisma.choreTemplate.findMany.mockResolvedValue([choreRow()]);

    const { connection, browser } = await expectActionContract({
      actionId: "list_chore_templates",
      handler: listChores,
      args: { lodgeId: "lodge-1" },
    });

    expect(h.prisma.choreTemplate.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.anything(), orderBy: { sortOrder: "asc" } }),
    );
    expect(connection).toEqual({ chores: [PROJECTED_CHORE] });
    expect(browser).toEqual(asJson([choreRow()]));
  });
});

describe("create_chore_template", () => {
  it("creates the chore at the lodge, audits it and answers it", async () => {
    h.prisma.choreTemplate.create.mockResolvedValue(choreRow());

    const { connection, browser } = await expectActionContract({
      actionId: "create_chore_template",
      handler: createChore,
      args: {
        name: "Sweep the drying room",
        description: "Brooms by the door",
        isEssential: true,
        sortOrder: 1,
        timeOfDay: "MORNING",
        frequencyMode: "SPECIFIC_DAYS",
        frequencyDaysOfWeek: [1, 5],
        lodgeId: "lodge-1",
      },
    });

    expect(h.prisma.choreTemplate.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        name: "Sweep the drying room",
        frequencyMode: "SPECIFIC_DAYS",
        frequencyDaysOfWeek: [1, 5],
        recommendedPeopleMin: 1,
        recommendedPeopleMax: 2,
        lodgeId: "lodge-1",
      }),
    });
    expect(h.createAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: "CHORE_TEMPLATE_CREATED" }));
    expect(connection).toEqual(PROJECTED_CHORE);
    expect(browser).toEqual(asJson(choreRow()));
  });
});

describe("update_chore_template", () => {
  it("updates only what is sent and answers the saved chore", async () => {
    h.prisma.choreTemplate.findUnique.mockResolvedValue(choreRow());
    h.prisma.choreTemplate.update.mockResolvedValue(choreRow());

    const { connection, browser } = await expectActionContract({
      actionId: "update_chore_template",
      handler: putChore,
      args: { id: "chore-1", active: false },
    });

    expect(h.prisma.choreTemplate.update).toHaveBeenCalledWith({ where: { id: "chore-1" }, data: { active: false } });
    expect(connection).toEqual(PROJECTED_CHORE);
    expect(browser).toEqual(asJson(choreRow()));
  });
});

describe("delete_chore_template", () => {
  it("deletes the chore and answers success", async () => {
    h.prisma.choreTemplate.findUnique.mockResolvedValue(choreRow());

    const { connection, browser } = await expectActionContract({
      actionId: "delete_chore_template",
      handler: deleteChore,
      args: { id: "chore-1" },
    });

    expect(h.prisma.choreTemplate.delete).toHaveBeenCalledWith({ where: { id: "chore-1" } });
    expect(connection).toEqual({ success: true });
    expect(browser).toEqual({ success: true });
  });
});

// ---------------------------------------------------------------------------
// Work parties
// ---------------------------------------------------------------------------

const PROJECTED_WORK_PARTY = {
  id: "wp-1",
  name: "Spring working bee",
  description: "Bring gloves",
  startDate: "2026-07-10T00:00:00.000Z",
  endDate: "2026-07-12T00:00:00.000Z",
  discountPercent: 50,
  active: true,
  lodgeId: "lodge-1",
};

function workPartyRow() {
  return {
    id: "wp-1",
    name: "Spring working bee",
    description: "Bring gloves",
    startDate: day("2026-07-10"),
    endDate: day("2026-07-12"),
    discountPercent: 50,
    active: true,
    promoCodeId: "promo-1",
    lodgeId: "lodge-1",
    ...STAMPS,
  };
}

const WORK_PARTY_ARGS = {
  name: "Spring working bee",
  description: "Bring gloves",
  startDate: "2026-07-10",
  endDate: "2026-07-12",
  discountPercent: 50,
  active: true,
  lodgeId: "lodge-1",
};

describe("list_all_work_parties", () => {
  it("answers every work party with its counts, without the promo code id or row stamps", async () => {
    h.prisma.workPartyEvent.findMany.mockResolvedValue([
      {
        ...workPartyRow(),
        lodge: { name: "Main Lodge" },
        _count: { calendarEvents: 0 },
        promoCode: { id: "promo-1", redemptions: [{ discountCents: 4500 }, { discountCents: 3000 }] },
      },
    ]);

    const { connection, browser } = await expectActionContract({
      actionId: "list_all_work_parties",
      handler: listWorkParties,
    });

    const extras = {
      lodgeName: "Main Lodge",
      onCalendar: false,
      canAddToCalendar: true,
      bookingCount: 2,
      totalDiscountCents: 7500,
    };
    expect(connection).toEqual({ events: [{ ...PROJECTED_WORK_PARTY, ...extras }] });
    expect(browser).toEqual({ events: [{ ...(asJson(workPartyRow()) as object), ...extras }] });
  });
});

describe("get_work_party_attendance", () => {
  it("answers the work party and each attending booking, without the member's email", async () => {
    const redemption = {
      id: "redemption-1",
      discountCents: 4500,
      createdAt: new Date("2026-06-15T00:00:00.000Z"),
      booking: {
        id: "booking-1",
        checkIn: day("2026-07-10"),
        checkOut: day("2026-07-13"),
        status: "PAID",
        finalPriceCents: 9000,
      },
      member: { id: "member-2", firstName: "Aroha", lastName: "Ngata", email: "aroha@example.test" },
    };
    h.prisma.workPartyEvent.findUnique.mockResolvedValue({
      ...workPartyRow(),
      promoCode: { id: "promo-1", redemptions: [redemption] },
    });

    const { connection, browser } = await expectActionContract({
      actionId: "get_work_party_attendance",
      handler: getWorkParty,
      args: { id: "wp-1" },
    });

    expect(connection).toEqual({
      event: PROJECTED_WORK_PARTY,
      attendingBookings: [
        {
          id: "redemption-1",
          discountCents: 4500,
          booking: {
            id: "booking-1",
            checkIn: "2026-07-10T00:00:00.000Z",
            checkOut: "2026-07-13T00:00:00.000Z",
            status: "PAID",
            finalPriceCents: 9000,
          },
          member: { id: "member-2", firstName: "Aroha", lastName: "Ngata" },
        },
      ],
      totalDiscountCents: 4500,
    });
    expect(JSON.stringify(connection)).not.toContain("aroha@");
    expect(browser).toEqual(
      asJson({ event: workPartyRow(), attendingBookings: [redemption], totalDiscountCents: 4500 }),
    );
  });
});

describe("create_work_party", () => {
  it("creates the work party with its promo, syncs the calendar and answers it", async () => {
    h.createWorkParty.mockResolvedValue(workPartyRow());
    h.syncCreated.mockResolvedValue(null);

    const { connection, browser } = await expectActionContract({
      actionId: "create_work_party",
      handler: createWorkParty,
      args: WORK_PARTY_ARGS,
    });

    expect(h.createWorkParty).toHaveBeenCalledWith({
      name: "Spring working bee",
      description: "Bring gloves",
      startDate: day("2026-07-10"),
      endDate: day("2026-07-12"),
      discountPercent: 50,
      active: true,
      lodgeId: "lodge-1",
    });
    expect(h.syncCreated).toHaveBeenCalledWith("wp-1", "officer-1");
    expect(connection).toEqual({ event: PROJECTED_WORK_PARTY, calendarWarning: null });
    expect(browser).toEqual(asJson({ event: workPartyRow(), calendarWarning: null }));
  });
});

describe("update_work_party", () => {
  it("saves the work party with its calendar entries and answers it", async () => {
    h.prisma.workPartyEvent.findUnique.mockResolvedValue(workPartyRow());
    h.updateWithCalendar.mockResolvedValue(workPartyRow());

    const { connection, browser } = await expectActionContract({
      actionId: "update_work_party",
      handler: putWorkParty,
      args: { id: "wp-1", ...WORK_PARTY_ARGS },
    });

    expect(h.updateWithCalendar).toHaveBeenCalledWith(
      "wp-1",
      expect.objectContaining({ name: "Spring working bee", discountPercent: 50, lodgeId: "lodge-1" }),
      "officer-1",
    );
    expect(connection).toEqual({ event: PROJECTED_WORK_PARTY });
    expect(browser).toEqual(asJson({ event: workPartyRow() }));
  });
});

describe("delete_work_party", () => {
  it("deletes the work party, its calendar entries and its promo, and answers success", async () => {
    h.prisma.workPartyEvent.findUnique.mockResolvedValue({
      ...workPartyRow(),
      promoCode: { id: "promo-1", redemptions: [] },
    });

    const { connection, browser } = await expectActionContract({
      actionId: "delete_work_party",
      handler: deleteWorkParty,
      args: { id: "wp-1" },
    });

    expect(h.removeCalendarEntries).toHaveBeenCalledWith(h.prisma, "wp-1");
    expect(h.prisma.workPartyEvent.delete).toHaveBeenCalledWith({ where: { id: "wp-1" } });
    expect(h.prisma.promoCode.delete).toHaveBeenCalledWith({ where: { id: "promo-1" } });
    expect(connection).toEqual({ success: true });
    expect(browser).toEqual({ success: true });
  });
});

describe("add_work_party_to_calendar", () => {
  it("puts the work party on the calendar and answers the entry count", async () => {
    h.prisma.workPartyEvent.findUnique.mockResolvedValue({ id: "wp-1", name: "Spring working bee" });
    h.addToCalendar.mockResolvedValue(3);

    const { connection, browser } = await expectActionContract({
      actionId: "add_work_party_to_calendar",
      handler: addWorkPartyToCalendar,
      args: { id: "wp-1" },
    });

    expect(h.addToCalendar).toHaveBeenCalledWith("wp-1", "officer-1");
    expect(connection).toEqual({ entryCount: 3 });
    expect(browser).toEqual({ entryCount: 3 });
  });
});

describe("the module's kinds and names", () => {
  it("reads only with GETs, marks every change destructive and lists none as a core tool", () => {
    for (const action of LODGE_CHORE_WORK_PARTY_MCP_ACTIONS) {
      expect(action.kind, action.id).toBe(action.method === "GET" ? "read" : "destructive");
      expect(action.core, action.id).toBe(false);
    }
  });

  it("keeps the member's work-party action names for the member", () => {
    const ids = LODGE_CHORE_WORK_PARTY_MCP_ACTIONS.map((action) => action.id);
    expect(ids).not.toContain("list_work_parties");
    expect(ids).not.toContain("get_work_party");
  });
});
