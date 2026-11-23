/**
 * ALP-719 (`INV-MCP-006`, `INV-MONEY`): the promo-code actions an officer's AI
 * app connection may run (`/api/admin/promo-codes/**`). Each route answers the
 * browser as before; the connection gets exactly the action's `returns`
 * fields (`expectActionContract`). Every handler runs twice (connection, then
 * browser), so the write mocks answer both runs.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const prisma = {
    $transaction: vi.fn(),
    promoCode: { findMany: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
    promoCodeAssignment: { createMany: vi.fn(), deleteMany: vi.fn() },
    promoCodeLodge: { createMany: vi.fn(), deleteMany: vi.fn() },
    promoRedemption: { groupBy: vi.fn(), aggregate: vi.fn(), count: vi.fn(), findMany: vi.fn() },
    promoRedemptionAllocation: { groupBy: vi.fn() },
    lodge: { findMany: vi.fn(), findUnique: vi.fn() },
  };
  return { prisma, requireAdmin: vi.fn(), logAudit: vi.fn(), createAuditLog: vi.fn() };
});

vi.mock("@/lib/session-guards", () => ({ requireAdmin: h.requireAdmin }));
vi.mock("@/lib/prisma", () => ({ prisma: h.prisma }));
vi.mock("@/lib/audit", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/audit")),
  logAudit: h.logAudit,
  createAuditLog: h.createAuditLog,
}));
vi.mock("@/lib/club-time/server", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/club-time/server")),
  clubTimeZone: async () => "Pacific/Auckland",
}));

import { GET as getRedemptions } from "@/app/api/admin/promo-codes/[id]/redemptions/route";
import {
  DELETE as deletePromoCode,
  GET as getPromoCode,
  PATCH as restorePromoCode,
  PUT as updatePromoCode,
} from "@/app/api/admin/promo-codes/[id]/route";
import { GET as listPromoCodes, POST as createPromoCode } from "@/app/api/admin/promo-codes/route";
import {
  buildActionRequest,
  expectActionContract,
  officerMemberSession,
} from "@/lib/__tests__/helpers/mcp-action-contract";
import { findMcpAction, type McpAction } from "@/lib/mcp/catalogue";

const VIEW = { permission: { area: "bookings", level: "view" } };
const EDIT = { permission: { area: "bookings", level: "edit" } };

function day(date: string) {
  return new Date(`${date}T00:00:00.000Z`);
}

/** A promo code row as stored, with every column. */
function promoCodeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "promo-1",
    code: "FAMILY10",
    description: "Ten percent off for family weekends",
    type: "PERCENTAGE",
    valueCents: null,
    percentOff: 10,
    freeNightsPerIndividual: null,
    lifetimeFreeNightsCap: null,
    fixedNightlyPriceCents: null,
    fixedNightlyMode: null,
    maxNightlyValueCents: 2000,
    maxGuestsPerBooking: 6,
    maxRedemptionsTotal: 50,
    maxUniqueMembersTotal: 20,
    maxUsesPerMember: 2,
    currentRedemptions: 3,
    validFrom: day("2026-06-01"),
    validUntil: day("2026-09-30"),
    bookingStartFrom: day("2026-07-01"),
    bookingStartUntil: day("2026-10-01"),
    membersOnly: true,
    memberGuestsOnly: false,
    assignedMembersOnlyOwnNights: true,
    xeroItemCode: "PROMO",
    xeroAccountCode: "200",
    internal: false,
    active: true,
    archivedAt: null,
    createdAt: day("2026-05-01"),
    updatedAt: day("2026-05-02"),
    ...overrides,
  };
}

function assignmentRow() {
  return {
    id: "assign-1",
    promoCodeId: "promo-1",
    memberId: "member-1",
    createdAt: day("2026-05-01"),
    member: { id: "member-1", firstName: "Ana", lastName: "Reid", email: "ana@example.test" },
  };
}

/** What a connection is sent of one code. */
const CONNECTION_PROMO_CODE = {
  id: "promo-1",
  code: "FAMILY10",
  description: "Ten percent off for family weekends",
  type: "PERCENTAGE",
  valueCents: null,
  percentOff: 10,
  freeNightsPerIndividual: null,
  lifetimeFreeNightsCap: null,
  fixedNightlyPriceCents: null,
  fixedNightlyMode: null,
  maxNightlyValueCents: 2000,
  maxGuestsPerBooking: 6,
  maxRedemptionsTotal: 50,
  maxUniqueMembersTotal: 20,
  maxUsesPerMember: 2,
  currentRedemptions: 3,
  validFrom: "2026-06-01T00:00:00.000Z",
  validUntil: "2026-09-30T00:00:00.000Z",
  bookingStartFrom: "2026-07-01T00:00:00.000Z",
  bookingStartUntil: "2026-10-01T00:00:00.000Z",
  membersOnly: true,
  memberGuestsOnly: false,
  assignedMembersOnlyOwnNights: true,
  xeroItemCode: "PROMO",
  xeroAccountCode: "200",
  active: true,
  archivedAt: null,
  lodgeIds: ["lodge-1"],
  assignments: [{ memberId: "member-1", member: { firstName: "Ana", lastName: "Reid" } }],
};

beforeEach(() => {
  vi.clearAllMocks();
  h.requireAdmin.mockResolvedValue({ ok: true, session: officerMemberSession() });
  h.prisma.$transaction.mockImplementation(async (fn: (tx: typeof h.prisma) => unknown) => fn(h.prisma));
});

describe("list_promo_codes", () => {
  it("answers the codes under `promoCodes`, without allocation rows, emails or the internal flag", async () => {
    h.prisma.promoCode.findMany.mockResolvedValue([
      {
        ...promoCodeRow(),
        allocations: [
          { id: "alloc-1", discountCents: 1200, priceAdjustmentCents: -1200, memberId: "member-2", createdAt: day("2026-06-10") },
        ],
        _count: { redemptions: 4 },
        assignments: [assignmentRow()],
        lodges: [{ lodgeId: "lodge-1" }],
      },
    ]);
    h.prisma.promoRedemption.groupBy.mockResolvedValue([{ promoCodeId: "promo-1", _count: { _all: 1 } }]);

    const { connection, browser } = await expectActionContract({
      actionId: "list_promo_codes",
      handler: listPromoCodes,
      args: { archived: "true" },
    });

    expect(h.requireAdmin).toHaveBeenCalledWith(VIEW);
    expect(h.prisma.promoCode.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { archivedAt: { not: null }, internal: false } }),
    );
    expect(connection).toEqual({
      promoCodes: [{ ...CONNECTION_PROMO_CODE, totalRedemptionCount: 4, benefitFreeRedemptionCount: 1 }],
    });
    // The browser keeps the bare array, with the allocation rows and emails.
    expect(Array.isArray(browser)).toBe(true);
    expect(browser).toMatchObject([
      {
        internal: false,
        redemptions: [{ id: "alloc-1", memberId: "member-2" }],
        assignments: [{ member: { email: "ana@example.test" } }],
      },
    ]);
  });
});

describe("get_promo_code", () => {
  it("answers the one code, leaving its uses to the redemptions report", async () => {
    h.prisma.promoCode.findUnique.mockResolvedValue({
      ...promoCodeRow(),
      allocations: [
        {
          id: "alloc-1",
          discountCents: 1200,
          memberId: "member-2",
          booking: { id: "booking-1", checkIn: day("2026-07-10"), checkOut: day("2026-07-12") },
          member: { id: "member-2", firstName: "Kim", lastName: "Hale", email: "kim@example.test" },
        },
      ],
      assignments: [assignmentRow()],
      lodges: [{ lodgeId: "lodge-1" }],
    });

    const { connection, browser } = await expectActionContract({
      actionId: "get_promo_code",
      handler: getPromoCode,
      args: { id: "promo-1" },
    });

    expect(h.requireAdmin).toHaveBeenCalledWith(VIEW);
    expect(connection).toEqual(CONNECTION_PROMO_CODE);
    expect(browser).toMatchObject({ redemptions: [{ member: { email: "kim@example.test" } }] });
  });

  it("still hides a work-party code", async () => {
    h.prisma.promoCode.findUnique.mockResolvedValue({
      ...promoCodeRow({ internal: true }),
      allocations: [],
      assignments: [],
      lodges: [],
    });
    const { request, context } = buildActionRequest(findMcpAction("get_promo_code") as McpAction, { id: "promo-1" }, true);
    const response = await getPromoCode(request as never, context as never);
    expect(response.status).toBe(404);
  });
});

/** The saved code the create and update transactions read back. */
function savedWithRelations() {
  return { ...promoCodeRow(), assignments: [assignmentRow()], lodges: [{ lodgeId: "lodge-1" }] };
}

describe("create_promo_code", () => {
  it("creates the code with its assignments and lodges and answers it", async () => {
    // The duplicate check (by code) finds nothing; the read-back (by id) finds the saved code.
    h.prisma.promoCode.findUnique.mockImplementation(async ({ where }: { where: { code?: string; id?: string } }) =>
      where.id ? savedWithRelations() : null,
    );
    h.prisma.lodge.findMany.mockResolvedValue([{ id: "lodge-1" }]);
    h.prisma.promoCode.create.mockResolvedValue(promoCodeRow());

    const { connection, browser } = await expectActionContract({
      actionId: "create_promo_code",
      handler: createPromoCode,
      args: {
        code: " family10 ",
        type: "PERCENTAGE",
        percentOff: 10,
        maxNightlyValueCents: 2000,
        validFrom: "2026-06-01",
        validUntil: "2026-09-30",
        membersOnly: true,
        assignedMemberIds: ["member-1"],
        lodgeIds: ["lodge-1"],
      },
    });

    expect(h.requireAdmin).toHaveBeenCalledWith(EDIT);
    expect(h.prisma.promoCode.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        code: "FAMILY10",
        type: "PERCENTAGE",
        percentOff: 10,
        valueCents: null,
        maxNightlyValueCents: 2000,
        validFrom: day("2026-06-01"),
        membersOnly: true,
        memberGuestsOnly: false,
        assignedMembersOnlyOwnNights: true,
        active: true,
      }),
    });
    expect(h.prisma.promoCodeAssignment.createMany).toHaveBeenCalledWith({
      data: [{ promoCodeId: "promo-1", memberId: "member-1" }],
    });
    expect(h.logAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "promo.create", category: "booking" }));
    expect(connection).toEqual(CONNECTION_PROMO_CODE);
    expect(browser).toMatchObject({ internal: false, assignments: [{ member: { email: "ana@example.test" } }] });
  });

  it("still refuses a type without its value", async () => {
    const { request } = buildActionRequest(
      findMcpAction("create_promo_code") as McpAction,
      { code: "BIG", type: "FIXED_AMOUNT" },
      true,
    );
    const response = await createPromoCode(request as never);
    expect(response.status).toBe(400);
    expect(h.prisma.promoCode.create).not.toHaveBeenCalled();
  });
});

describe("update_promo_code", () => {
  it("changes the named fields and answers the saved code", async () => {
    h.prisma.promoCode.findUnique.mockImplementation(async ({ include }: { include?: unknown }) =>
      include ? savedWithRelations() : promoCodeRow(),
    );
    h.prisma.lodge.findMany.mockResolvedValue([{ id: "lodge-1" }]);
    h.prisma.promoCode.update.mockResolvedValue(promoCodeRow());

    const { connection, browser } = await expectActionContract({
      actionId: "update_promo_code",
      handler: updatePromoCode,
      args: { id: "promo-1", percentOff: 15, lodgeIds: ["lodge-1"] },
    });

    expect(h.requireAdmin).toHaveBeenCalledWith(EDIT);
    expect(h.prisma.promoCode.update).toHaveBeenCalledWith({
      where: { id: "promo-1" },
      data: { percentOff: 15 },
    });
    expect(h.prisma.promoCodeLodge.createMany).toHaveBeenCalledWith({
      data: [{ promoCodeId: "promo-1", lodgeId: "lodge-1" }],
    });
    // Assignments were not named, so they are left alone.
    expect(h.prisma.promoCodeAssignment.deleteMany).not.toHaveBeenCalled();
    expect(connection).toEqual(CONNECTION_PROMO_CODE);
    expect(browser).toMatchObject({ internal: false });
  });
});

describe("restore_promo_code", () => {
  it("restores an archived code", async () => {
    h.prisma.promoCode.findUnique.mockResolvedValue(promoCodeRow({ archivedAt: day("2026-06-15"), active: false }));

    const { connection, browser } = await expectActionContract({
      actionId: "restore_promo_code",
      handler: restorePromoCode,
      args: { id: "promo-1" },
    });

    expect(h.requireAdmin).toHaveBeenCalledWith(EDIT);
    expect(h.prisma.promoCode.update).toHaveBeenCalledWith({ where: { id: "promo-1" }, data: { archivedAt: null } });
    expect(h.logAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "promo.restore" }));
    expect(connection).toEqual({ success: true });
    expect(browser).toEqual({ success: true });
  });
});

describe("delete_promo_code", () => {
  it("archives a code that was ever applied", async () => {
    h.prisma.promoCode.findUnique.mockResolvedValue({ ...promoCodeRow(), _count: { redemptions: 2 } });

    const { connection, browser } = await expectActionContract({
      actionId: "delete_promo_code",
      handler: deletePromoCode,
      args: { id: "promo-1" },
    });

    expect(h.requireAdmin).toHaveBeenCalledWith(EDIT);
    expect(h.prisma.promoCode.update).toHaveBeenCalledWith({
      where: { id: "promo-1" },
      data: { archivedAt: expect.any(Date), active: false },
    });
    expect(h.prisma.promoCode.delete).not.toHaveBeenCalled();
    expect(connection).toEqual({ success: true, archived: true });
    expect(browser).toEqual({ success: true, archived: true });
  });

  it("deletes a code never applied", async () => {
    h.prisma.promoCode.findUnique.mockResolvedValue({ ...promoCodeRow(), _count: { redemptions: 0 } });

    const { connection } = await expectActionContract({
      actionId: "delete_promo_code",
      handler: deletePromoCode,
      args: { id: "promo-1" },
    });

    expect(h.prisma.promoCode.delete).toHaveBeenCalledWith({ where: { id: "promo-1" } });
    expect(h.logAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "promo.delete" }));
    expect(connection).toEqual({ success: true, archived: false });
  });
});

describe("get_promo_code_redemptions", () => {
  function redemptionFixtures() {
    h.prisma.promoCode.findUnique.mockResolvedValue(promoCodeRow());
    h.prisma.lodge.findUnique.mockResolvedValue({ id: "lodge-1" });
    h.prisma.promoRedemption.aggregate.mockResolvedValue({
      _count: { _all: 1 },
      _sum: { discountCents: 2400, freeNightsUsed: 0 },
    });
    h.prisma.promoRedemption.groupBy.mockResolvedValue([{ memberId: "member-1" }]);
    h.prisma.promoRedemptionAllocation.groupBy.mockResolvedValue([{ memberId: "member-1" }, { memberId: "member-2" }]);
    h.prisma.promoRedemption.count.mockResolvedValue(0);
    h.prisma.promoRedemption.findMany.mockImplementation(async ({ select }: { select?: unknown }) =>
      select
        ? [{ id: "redemption-1", memberId: "member-1" }]
        : [
            {
              id: "redemption-1",
              promoCodeId: "promo-1",
              bookingId: "booking-1",
              memberId: "member-1",
              createdAt: day("2026-06-10"),
              eligibleGuestCount: 2,
              discountCents: 2400,
              priceAdjustmentCents: -2400,
              freeNightsUsed: null,
              member: { id: "member-1", firstName: "Ana", lastName: "Reid", email: "ana@example.test" },
              booking: {
                id: "booking-abcdefgh12345678",
                checkIn: day("2026-07-10"),
                checkOut: day("2026-07-12"),
                memberId: "member-1",
                member: { firstName: "Ana", lastName: "Reid", email: "ana@example.test" },
                organisation: null,
                lodge: { id: "lodge-1", name: "Ruapehu Lodge" },
              },
              allocations: [
                {
                  id: "alloc-1",
                  memberId: "member-1",
                  discountCents: 1200,
                  freeNightsUsed: 0,
                  member: { id: "member-1", firstName: "Ana", lastName: "Reid" },
                },
                {
                  id: "alloc-2",
                  memberId: "member-2",
                  discountCents: 1200,
                  freeNightsUsed: 0,
                  member: { id: "member-2", firstName: "Kim", lastName: "Hale" },
                },
              ],
            },
          ],
    );
  }

  it("answers the code's caps, totals and each use, without emails", async () => {
    redemptionFixtures();

    const { connection, browser } = await expectActionContract({
      actionId: "get_promo_code_redemptions",
      handler: getRedemptions,
      args: { id: "promo-1", from: "2026-06-01", to: "2026-06-30", lodgeId: "lodge-1" },
    });

    expect(h.requireAdmin).toHaveBeenCalledWith(VIEW);
    // Paged browsing writes no privacy audit row; only the website's export does.
    expect(h.createAuditLog).not.toHaveBeenCalled();
    const totals = { redemptions: 1, uniqueMembers: 1, discountCents: 2400, freeNightsUsed: 0, benefitFreeRedemptions: 0 };
    expect(connection).toEqual({
      code: {
        id: "promo-1",
        code: "FAMILY10",
        description: "Ten percent off for family weekends",
        type: "PERCENTAGE",
        active: true,
        archived: false,
        internal: false,
        currentRedemptions: 3,
        capUsage: { redemptions: 3, uniqueMembers: 2 },
        caps: { maxRedemptionsTotal: 50, maxUniqueMembersTotal: 20, maxUsesPerMember: 2, lifetimeFreeNightsCap: null },
      },
      totals: { all: totals, filtered: totals },
      pagination: { page: 1, pageSize: 50, total: 1 },
      rows: [
        {
          id: "redemption-1",
          createdAt: "2026-06-10T00:00:00.000Z",
          member: { id: "member-1", name: "Ana Reid" },
          booking: {
            id: "booking-abcdefgh12345678",
            reference: "BOOKING-",
            lodgeId: "lodge-1",
            lodgeName: "Ruapehu Lodge",
            checkIn: "2026-07-10",
            checkOut: "2026-07-12",
            nights: 2,
          },
          eligibleGuestCount: 2,
          discountCents: 2400,
          priceAdjustmentCents: -2400,
          freeNightsUsed: 0,
          gaveBenefit: true,
          memberUseIndex: 1,
          allocations: [
            { memberId: "member-1", name: "Ana Reid", discountCents: 1200, freeNightsUsed: 0 },
            { memberId: "member-2", name: "Kim Hale", discountCents: 1200, freeNightsUsed: 0 },
          ],
        },
      ],
    });
    expect(browser).toMatchObject({ export: null, rows: [{ member: { email: "ana@example.test" } }] });
  });

  it("cannot reach the CSV export: `export` is not one of the action's arguments", async () => {
    redemptionFixtures();

    const { connection } = await expectActionContract({
      actionId: "get_promo_code_redemptions",
      handler: getRedemptions,
      args: { id: "promo-1", export: "1" },
    });

    expect(h.createAuditLog).not.toHaveBeenCalled();
    expect(h.prisma.promoRedemption.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 50, skip: 0 }));
    expect(connection).not.toHaveProperty("export");
  });
});
