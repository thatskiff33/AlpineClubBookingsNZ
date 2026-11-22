/**
 * ALP-719 (`INV-MCP-006`): the Bookings & Beds setup actions an officer's AI
 * app connection may run: seasons, booking policies, age groups, member-guest
 * and booking-request settings. Each route answers the browser as before; the
 * connection gets exactly the action's `returns` fields
 * (`expectActionContract`). Every handler runs twice (connection, then
 * browser), so the write mocks answer both runs.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const prisma = {
    $executeRaw: vi.fn(),
    $transaction: vi.fn(),
    season: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    lodge: { findUnique: vi.fn() },
    cancellationPolicy: { findMany: vi.fn(), deleteMany: vi.fn(), createMany: vi.fn() },
    bookingDefaults: { findUnique: vi.fn(), upsert: vi.fn() },
    bookingPeriod: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    minimumStayPolicy: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      updateMany: vi.fn(),
    },
    groupDiscountSetting: { findUnique: vi.fn(), upsert: vi.fn(), update: vi.fn() },
    membershipType: { findFirst: vi.fn() },
    adultMemberHostingPolicy: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      updateMany: vi.fn(),
    },
    ageTierSetting: { findMany: vi.fn(), upsert: vi.fn(), deleteMany: vi.fn() },
    member: { count: vi.fn() },
    bookingGuest: { count: vi.fn() },
    bookingRequestSettings: { findUnique: vi.fn(), upsert: vi.fn() },
    memberGuestSettings: { findUnique: vi.fn(), upsert: vi.fn() },
    auditLog: { create: vi.fn() },
  };
  return {
    prisma,
    requireAdmin: vi.fn(),
    logAudit: vi.fn(),
    revalidate: vi.fn(),
    syncOtherLodges: vi.fn(),
    validateRates: vi.fn(),
    replaceRates: vi.fn(),
    lodgeCapacity: vi.fn(),
    enqueueReconciliation: vi.fn(),
    settleCoverage: vi.fn(),
  };
});

vi.mock("@/lib/session-guards", () => ({ requireAdmin: h.requireAdmin }));
vi.mock("@/lib/prisma", () => ({ prisma: h.prisma }));
vi.mock("@/lib/audit", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/audit")),
  logAudit: h.logAudit,
}));
vi.mock("@/lib/public-content-revalidation", () => ({ revalidatePublicPageContent: h.revalidate }));
vi.mock("@/lib/other-lodge-fees-sync", () => ({ syncOwnOtherLodgesFromFees: h.syncOtherLodges }));
vi.mock("@/lib/season-rate-editor", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/season-rate-editor")),
  validateMembershipTypeSeasonRates: h.validateRates,
  replaceMembershipTypeSeasonRates: h.replaceRates,
}));
vi.mock("@/lib/lodge-capacity", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/lodge-capacity")),
  getDefaultLodgeCapacity: h.lodgeCapacity,
}));
vi.mock("@/lib/adult-member-hosting-policy-reconciliation", () => ({
  HOSTING_POLICY_RECONCILIATION_SELECT: { id: true },
  enqueueActiveHostingIncidentPolicyReconciliation: h.enqueueReconciliation,
}));
vi.mock("@/lib/adult-member-hosting-coverage-drain", () => ({
  settleHostingCoverageAfterCommit: h.settleCoverage,
}));

import { GET as getAgeTiers, PUT as putAgeTiers } from "@/app/api/admin/age-tier-settings/route";
import {
  GET as getHosting,
  PUT as putHosting,
} from "@/app/api/admin/booking-policies/adult-member-hosting/route";
import {
  GET as getCancellation,
  PUT as putCancellation,
} from "@/app/api/admin/booking-policies/cancellation/route";
import {
  GET as getGroupDiscount,
  PUT as putGroupDiscount,
} from "@/app/api/admin/booking-policies/group-discount/route";
import {
  GET as listMinimumStay,
  POST as createMinimumStay,
} from "@/app/api/admin/booking-policies/minimum-stay/route";
import {
  DELETE as deleteMinimumStay,
  PUT as putMinimumStay,
} from "@/app/api/admin/booking-policies/minimum-stay/[id]/route";
import {
  GET as listPeriods,
  POST as createPeriod,
} from "@/app/api/admin/booking-policies/periods/route";
import {
  DELETE as deletePeriod,
  GET as getPeriod,
  PUT as putPeriod,
} from "@/app/api/admin/booking-policies/periods/[id]/route";
import {
  GET as getRequestSettings,
  PUT as putRequestSettings,
} from "@/app/api/admin/booking-requests/settings/route";
import { GET as getMemberGuest } from "@/app/api/admin/member-guest-settings/route";
import { GET as listSeasons, POST as createSeason } from "@/app/api/admin/seasons/route";
import {
  DELETE as deleteSeason,
  GET as getSeason,
  PUT as putSeason,
} from "@/app/api/admin/seasons/[id]/route";
import { expectActionContract, officerMemberSession } from "@/lib/__tests__/helpers/mcp-action-contract";

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
  // Interactive transactions run against the same doubles.
  h.prisma.$transaction.mockImplementation(async (fn: (tx: typeof h.prisma) => unknown) => fn(h.prisma));
  h.prisma.$executeRaw.mockResolvedValue(1);
  h.prisma.lodge.findUnique.mockResolvedValue({ id: "lodge-1", active: true });
  h.validateRates.mockResolvedValue(null);
});

// ---------------------------------------------------------------------------
// Seasons
// ---------------------------------------------------------------------------

function seasonRow() {
  return {
    id: "season-1",
    name: "Winter 2026",
    type: "WINTER",
    startDate: day("2026-06-01"),
    endDate: day("2026-10-01"),
    active: true,
    flatWholeLodgeNightCents: 250000,
    lodgeId: "lodge-1",
    ...STAMPS,
    membershipTypeRates: [
      {
        id: "rate-1",
        seasonId: "season-1",
        membershipTypeId: "mt-full",
        ageTier: "ADULT",
        pricePerNightCents: 4500,
        ...STAMPS,
      },
    ],
  };
}

const PROJECTED_SEASON = {
  id: "season-1",
  name: "Winter 2026",
  type: "WINTER",
  startDate: "2026-06-01T00:00:00.000Z",
  endDate: "2026-10-01T00:00:00.000Z",
  active: true,
  flatWholeLodgeNightCents: 250000,
  lodgeId: "lodge-1",
  membershipTypeRates: [{ membershipTypeId: "mt-full", ageTier: "ADULT", pricePerNightCents: 4500 }],
};

describe("list_seasons", () => {
  it("sends a connection the seasons under `seasons` without row stamps; the browser keeps the bare array", async () => {
    h.prisma.season.findMany.mockResolvedValue([seasonRow()]);

    const { connection, browser } = await expectActionContract({
      actionId: "list_seasons",
      handler: listSeasons,
      args: { lodgeId: "lodge-1" },
    });

    expect(h.prisma.season.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.anything(), orderBy: { startDate: "desc" } }),
    );
    expect(connection).toEqual({ seasons: [PROJECTED_SEASON] });
    expect(browser).toEqual(asJson([seasonRow()]));
  });
});

describe("get_season", () => {
  it("answers one season with its rates and drops the stamps and rate ids", async () => {
    h.prisma.season.findUnique.mockResolvedValue(seasonRow());

    const { connection, browser } = await expectActionContract({
      actionId: "get_season",
      handler: getSeason,
      args: { id: "season-1" },
    });

    expect(h.prisma.season.findUnique).toHaveBeenCalledWith({
      where: { id: "season-1" },
      include: { membershipTypeRates: true },
    });
    expect(connection).toEqual(PROJECTED_SEASON);
    expect(browser).toEqual(asJson(seasonRow()));
  });
});

describe("create_season", () => {
  it("creates the season with its rates at the lodge and answers it", async () => {
    h.prisma.season.findFirst.mockResolvedValue(null);
    h.prisma.season.create.mockResolvedValue({ id: "season-1" });
    h.prisma.season.findUnique.mockResolvedValue(seasonRow());

    const { connection, browser } = await expectActionContract({
      actionId: "create_season",
      handler: createSeason,
      args: {
        name: "Winter 2026",
        type: "WINTER",
        startDate: "2026-06-01",
        endDate: "2026-10-01",
        membershipTypeRates: [{ membershipTypeId: "mt-full", ageTier: "ADULT", pricePerNightCents: 4500 }],
        flatWholeLodgeNightCents: 250000,
        lodgeId: "lodge-1",
      },
    });

    expect(h.prisma.season.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        name: "Winter 2026",
        startDate: day("2026-06-01"),
        endDate: day("2026-10-01"),
        flatWholeLodgeNightCents: 250000,
        lodgeId: "lodge-1",
        membershipTypeRates: {
          create: [{ membershipTypeId: "mt-full", ageTier: "ADULT", pricePerNightCents: 4500 }],
        },
      }),
    });
    expect(connection).toEqual(PROJECTED_SEASON);
    expect(browser).toEqual(asJson(seasonRow()));
  });
});

describe("update_season", () => {
  it("updates the season, replaces its rates and answers it", async () => {
    h.prisma.season.findUnique.mockResolvedValue(seasonRow());
    h.prisma.season.findFirst.mockResolvedValue(null);
    h.prisma.season.update.mockResolvedValue({ id: "season-1" });

    const rates = [{ membershipTypeId: "mt-full", ageTier: "ADULT", pricePerNightCents: 4800 }];
    const { connection, browser } = await expectActionContract({
      actionId: "update_season",
      handler: putSeason,
      args: { id: "season-1", name: "Winter 2026 (revised)", membershipTypeRates: rates },
    });

    expect(h.prisma.season.update).toHaveBeenCalledWith({
      where: { id: "season-1" },
      data: { name: "Winter 2026 (revised)" },
    });
    expect(h.replaceRates).toHaveBeenCalledWith(h.prisma, "season-1", rates);
    expect(connection).not.toHaveProperty("updatedAt");
    expect(browser).toEqual(asJson(seasonRow()));
  });
});

describe("delete_season", () => {
  it("deletes the season and answers success", async () => {
    h.prisma.season.findUnique.mockResolvedValue(seasonRow());

    const { connection, browser } = await expectActionContract({
      actionId: "delete_season",
      handler: deleteSeason,
      args: { id: "season-1" },
    });

    expect(h.prisma.season.delete).toHaveBeenCalledWith({ where: { id: "season-1" } });
    expect(connection).toEqual({ success: true });
    expect(browser).toEqual({ success: true });
  });
});

// ---------------------------------------------------------------------------
// Cancellation policy
// ---------------------------------------------------------------------------

function cancellationRow() {
  return {
    id: "tier-1",
    daysBeforeStay: 14,
    refundPercentage: 90,
    creditRefundPercentage: 100,
    fixedFeeCents: 1500,
    creditFixedFeeCents: 0,
    lodgeId: "lodge-1",
    ...STAMPS,
  };
}

const BOOKING_DEFAULTS_ROW = {
  id: "default",
  nonMemberHoldEnabled: true,
  nonMemberHoldDays: 10,
  waitlistCrossLodgeOrder: "MERGED",
  linkedMoveChargesBothChangeFees: true,
  lateCaptureRefundNeedsApproval: false,
  preArrivalReminderDays: 7,
  additionalPaymentReminderDays: 3,
  policyExceptionHoldDays: 5,
  ...STAMPS,
};

const PROJECTED_RULE = {
  daysBeforeStay: 14,
  refundPercentage: 90,
  creditRefundPercentage: 100,
  fixedFeeCents: 1500,
  creditFixedFeeCents: 0,
};

const PROJECTED_DEFAULTS = {
  nonMemberHoldEnabled: true,
  nonMemberHoldDays: 10,
  waitlistCrossLodgeOrder: "MERGED",
  linkedMoveChargesBothChangeFees: true,
  lateCaptureRefundNeedsApproval: false,
  preArrivalReminderDays: 7,
  additionalPaymentReminderDays: 3,
  policyExceptionHoldDays: 5,
};

describe("get_cancellation_policy", () => {
  it("answers the lodge partition's tiers and the club-wide defaults", async () => {
    h.prisma.cancellationPolicy.findMany.mockResolvedValue([cancellationRow()]);
    h.prisma.bookingDefaults.findUnique.mockResolvedValue(BOOKING_DEFAULTS_ROW);

    const { connection, browser } = await expectActionContract({
      actionId: "get_cancellation_policy",
      handler: getCancellation,
      args: { lodgeId: "lodge-1" },
    });

    expect(h.prisma.cancellationPolicy.findMany).toHaveBeenCalledWith({
      where: { lodgeId: "lodge-1" },
      orderBy: { daysBeforeStay: "desc" },
    });
    // The route already answers normalised tiers and named defaults only.
    expect(connection).toEqual({ rules: [PROJECTED_RULE], ...PROJECTED_DEFAULTS, lodgeId: "lodge-1" });
    expect(browser).toEqual(connection);
  });
});

describe("update_cancellation_policy", () => {
  it("replaces the club-wide tiers, saves the named default and answers both", async () => {
    h.prisma.bookingDefaults.findUnique.mockResolvedValue(BOOKING_DEFAULTS_ROW);
    h.prisma.cancellationPolicy.findMany.mockResolvedValue([{ ...cancellationRow(), lodgeId: null }]);

    const { connection, browser } = await expectActionContract({
      actionId: "update_cancellation_policy",
      handler: putCancellation,
      args: {
        rules: [PROJECTED_RULE],
        nonMemberHoldDays: 10,
      },
    });

    expect(h.prisma.cancellationPolicy.deleteMany).toHaveBeenCalledWith({ where: { lodgeId: null } });
    expect(h.prisma.cancellationPolicy.createMany).toHaveBeenCalledWith({
      data: [{ ...PROJECTED_RULE, lodgeId: null }],
    });
    expect(h.prisma.bookingDefaults.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: { nonMemberHoldDays: 10 } }),
    );
    expect(connection).toEqual({ rules: [PROJECTED_RULE], ...PROJECTED_DEFAULTS });
    expect(browser).toEqual(connection);
  });
});

// ---------------------------------------------------------------------------
// Booking periods
// ---------------------------------------------------------------------------

function periodRow() {
  return {
    id: "period-1",
    name: "School holidays",
    startDate: day("2026-07-04"),
    endDate: day("2026-07-19"),
    nonMemberHoldEnabled: true,
    nonMemberHoldDays: 5,
    cancellationRules: [PROJECTED_RULE],
    active: true,
    lodgeId: "lodge-1",
    ...STAMPS,
  };
}

const PROJECTED_PERIOD = {
  id: "period-1",
  name: "School holidays",
  startDate: "2026-07-04T00:00:00.000Z",
  endDate: "2026-07-19T00:00:00.000Z",
  nonMemberHoldEnabled: true,
  nonMemberHoldDays: 5,
  cancellationRules: [PROJECTED_RULE],
  active: true,
  lodgeId: "lodge-1",
};

describe("list_booking_periods", () => {
  it("sends a connection the periods under `periods`; the browser keeps the bare array", async () => {
    h.prisma.bookingPeriod.findMany.mockResolvedValue([periodRow()]);

    const { connection, browser } = await expectActionContract({
      actionId: "list_booking_periods",
      handler: listPeriods,
      args: { lodgeId: "lodge-1" },
    });

    expect(h.prisma.bookingPeriod.findMany).toHaveBeenCalledWith({
      where: { lodgeId: "lodge-1" },
      orderBy: { startDate: "asc" },
    });
    expect(connection).toEqual({ periods: [PROJECTED_PERIOD] });
    expect(browser).toEqual(asJson([periodRow()]));
  });
});

describe("get_booking_period", () => {
  it("answers one period without its row stamps", async () => {
    h.prisma.bookingPeriod.findUnique.mockResolvedValue(periodRow());

    const { connection, browser } = await expectActionContract({
      actionId: "get_booking_period",
      handler: getPeriod,
      args: { id: "period-1" },
    });

    expect(connection).toEqual(PROJECTED_PERIOD);
    expect(browser).toEqual(asJson(periodRow()));
  });
});

describe("create_booking_period", () => {
  it("creates the lodge's period and answers it", async () => {
    h.prisma.bookingPeriod.create.mockResolvedValue(periodRow());

    const { connection, browser } = await expectActionContract({
      actionId: "create_booking_period",
      handler: createPeriod,
      args: {
        name: "School holidays",
        startDate: "2026-07-04",
        endDate: "2026-07-19",
        nonMemberHoldDays: 5,
        cancellationRules: [{ daysBeforeStay: 14, refundPercentage: 90 }],
        lodgeId: "lodge-1",
      },
    });

    expect(h.prisma.bookingPeriod.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        name: "School holidays",
        startDate: day("2026-07-04"),
        endDate: day("2026-07-19"),
        nonMemberHoldDays: 5,
        lodgeId: "lodge-1",
      }),
    });
    expect(connection).toEqual(PROJECTED_PERIOD);
    expect(browser).toEqual(asJson(periodRow()));
  });
});

describe("update_booking_period", () => {
  it("updates the period and answers it", async () => {
    h.prisma.bookingPeriod.findUnique.mockResolvedValue(periodRow());
    h.prisma.bookingPeriod.update.mockResolvedValue({ ...periodRow(), nonMemberHoldDays: 9 });

    const { connection, browser } = await expectActionContract({
      actionId: "update_booking_period",
      handler: putPeriod,
      args: { id: "period-1", nonMemberHoldDays: 9 },
    });

    expect(h.prisma.bookingPeriod.update).toHaveBeenCalledWith({
      where: { id: "period-1" },
      data: { nonMemberHoldDays: 9 },
    });
    expect(connection).toEqual({ ...PROJECTED_PERIOD, nonMemberHoldDays: 9 });
    expect(browser).toEqual(asJson({ ...periodRow(), nonMemberHoldDays: 9 }));
  });
});

describe("delete_booking_period", () => {
  it("deletes the period and answers success", async () => {
    h.prisma.bookingPeriod.findUnique.mockResolvedValue(periodRow());

    const { connection, browser } = await expectActionContract({
      actionId: "delete_booking_period",
      handler: deletePeriod,
      args: { id: "period-1" },
    });

    expect(h.prisma.bookingPeriod.delete).toHaveBeenCalledWith({ where: { id: "period-1" } });
    expect(connection).toEqual({ success: true });
    expect(browser).toEqual({ success: true });
  });
});

// ---------------------------------------------------------------------------
// Minimum stay
// ---------------------------------------------------------------------------

function minimumStayRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "policy-1",
    name: "Winter Saturdays",
    startDate: day("2026-07-01"),
    endDate: day("2026-09-30"),
    triggerDays: [5, 6],
    minimumNights: 2,
    active: true,
    capacityMode: "HOLD",
    version: 3,
    lodgeId: null,
    ...STAMPS,
    ...overrides,
  };
}

function projectedMinimumStay(overrides: Record<string, unknown> = {}) {
  const { createdAt: _created, updatedAt: _updated, ...rest } = asJson(minimumStayRow(overrides)) as Record<
    string,
    unknown
  >;
  return rest;
}

describe("list_minimum_stay_policies", () => {
  it("sends a connection the policies under `policies`; the browser keeps the bare array", async () => {
    h.prisma.minimumStayPolicy.findMany.mockResolvedValue([minimumStayRow()]);

    const { connection, browser } = await expectActionContract({
      actionId: "list_minimum_stay_policies",
      handler: listMinimumStay,
    });

    // Omitted lodge reads the club-wide partition.
    expect(h.prisma.minimumStayPolicy.findMany).toHaveBeenCalledWith({
      where: { lodgeId: null },
      orderBy: { startDate: "desc" },
    });
    expect(connection).toEqual({ policies: [projectedMinimumStay()] });
    expect(browser).toEqual(asJson([minimumStayRow()]));
  });
});

describe("create_minimum_stay_policy", () => {
  it("creates the policy under the policy-set lock and answers it", async () => {
    h.prisma.minimumStayPolicy.findFirst.mockResolvedValue(null);
    h.prisma.minimumStayPolicy.create.mockResolvedValue(minimumStayRow({ version: 1 }));

    const { connection, browser } = await expectActionContract({
      actionId: "create_minimum_stay_policy",
      handler: createMinimumStay,
      args: {
        name: "Winter Saturdays",
        startDate: "2026-07-01",
        endDate: "2026-09-30",
        triggerDays: [6, 5, 6],
        minimumNights: 2,
        capacityMode: "HOLD",
      },
    });

    expect(h.prisma.$executeRaw).toHaveBeenCalled();
    expect(h.prisma.minimumStayPolicy.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ name: "Winter Saturdays", triggerDays: [5, 6], lodgeId: null, version: 1 }),
    });
    expect(connection).toEqual(projectedMinimumStay({ version: 1 }));
    expect(browser).toEqual(asJson(minimumStayRow({ version: 1 })));
  });
});

describe("update_minimum_stay_policy", () => {
  it("claims the policy at the version sent and answers the saved row", async () => {
    const saved = minimumStayRow({ minimumNights: 3, version: 4 });
    // Each run reads the current row, then the saved one.
    h.prisma.minimumStayPolicy.findUnique
      .mockResolvedValueOnce(minimumStayRow())
      .mockResolvedValueOnce(saved)
      .mockResolvedValueOnce(minimumStayRow())
      .mockResolvedValueOnce(saved);
    h.prisma.minimumStayPolicy.findFirst.mockResolvedValue(null);
    h.prisma.minimumStayPolicy.updateMany.mockResolvedValue({ count: 1 });

    const { connection, browser } = await expectActionContract({
      actionId: "update_minimum_stay_policy",
      handler: putMinimumStay,
      args: { id: "policy-1", version: 3, minimumNights: 3 },
    });

    expect(h.prisma.minimumStayPolicy.updateMany).toHaveBeenCalledWith({
      where: { id: "policy-1", version: 3 },
      data: { minimumNights: 3, version: { increment: 1 } },
    });
    expect(connection).toEqual(projectedMinimumStay({ minimumNights: 3, version: 4 }));
    expect(browser).toEqual(asJson(saved));
  });
});

describe("deactivate_minimum_stay_policy", () => {
  it("deactivates the policy at the version sent and answers it", async () => {
    h.prisma.minimumStayPolicy.findUnique.mockResolvedValue(minimumStayRow());
    h.prisma.minimumStayPolicy.updateMany.mockResolvedValue({ count: 1 });

    const { connection, browser } = await expectActionContract({
      actionId: "deactivate_minimum_stay_policy",
      handler: deleteMinimumStay,
      args: { id: "policy-1", version: 3 },
    });

    expect(h.prisma.minimumStayPolicy.updateMany).toHaveBeenCalledWith({
      where: { id: "policy-1", version: 3, active: true },
      data: { active: false, version: { increment: 1 } },
    });
    expect(connection).toEqual({
      success: true,
      policy: projectedMinimumStay({ active: false, version: 4 }),
    });
    expect(browser).toEqual(asJson({ success: true, policy: minimumStayRow({ active: false, version: 4 }) }));
  });
});

// ---------------------------------------------------------------------------
// Group discount
// ---------------------------------------------------------------------------

const GROUP_DISCOUNT_ROW = {
  id: "default",
  minGroupSize: 8,
  summerOnly: true,
  enabled: true,
  rateMembershipTypeId: "mt-full",
  applyToEdits: true,
  ...STAMPS,
};

const PROJECTED_GROUP_DISCOUNT = {
  minGroupSize: 8,
  summerOnly: true,
  enabled: true,
  rateMembershipTypeId: "mt-full",
  applyToEdits: true,
};

describe("get_group_discount_policy", () => {
  it("answers the saved policy and `configured`, without the row id or stamps", async () => {
    h.prisma.groupDiscountSetting.findUnique.mockResolvedValue(GROUP_DISCOUNT_ROW);

    const { connection, browser } = await expectActionContract({
      actionId: "get_group_discount_policy",
      handler: getGroupDiscount,
    });

    expect(connection).toEqual({ ...PROJECTED_GROUP_DISCOUNT, configured: true });
    expect(browser).toEqual(asJson({ ...GROUP_DISCOUNT_ROW, configured: true }));
  });
});

describe("update_group_discount_policy", () => {
  it("saves the policy and answers the stored row", async () => {
    h.lodgeCapacity.mockResolvedValue(40);
    h.prisma.membershipType.findFirst.mockResolvedValue({ id: "mt-full" });
    h.prisma.groupDiscountSetting.upsert.mockResolvedValue({ ...GROUP_DISCOUNT_ROW });

    const { connection, browser } = await expectActionContract({
      actionId: "update_group_discount_policy",
      handler: putGroupDiscount,
      args: { minGroupSize: 8, summerOnly: true, enabled: true },
    });

    expect(h.prisma.groupDiscountSetting.upsert).toHaveBeenCalledWith({
      where: { id: "default" },
      update: { minGroupSize: 8, summerOnly: true, enabled: true },
      create: {
        id: "default",
        minGroupSize: 8,
        summerOnly: true,
        enabled: true,
        rateMembershipTypeId: "mt-full",
      },
    });
    expect(connection).toEqual(PROJECTED_GROUP_DISCOUNT);
    expect(browser).toEqual(asJson(GROUP_DISCOUNT_ROW));
  });
});

// ---------------------------------------------------------------------------
// Adult-member hosting
// ---------------------------------------------------------------------------

function hostingRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "hosting-1",
    lodgeId: null,
    scopeKey: "club-wide",
    mode: "ADMIN_REVIEW_REQUIRED",
    capacityMode: "HOLD",
    hostScopeSameBooking: true,
    hostScopeSameBookingOwner: true,
    hostScopeSameGroupTrip: false,
    version: 2,
    ...STAMPS,
    ...overrides,
  };
}

describe("get_adult_member_hosting_policy", () => {
  it("answers the scope's policy and what is in force, without the raw scope columns", async () => {
    h.prisma.adultMemberHostingPolicy.findMany.mockResolvedValue([hostingRow()]);

    const { connection, browser } = await expectActionContract({
      actionId: "get_adult_member_hosting_policy",
      handler: getHosting,
    });

    expect(connection).toMatchObject({
      id: "hosting-1",
      mode: "ADMIN_REVIEW_REQUIRED",
      hostScopes: { sameBooking: true, sameBookingOwner: true, sameGroupTrip: false },
      configured: true,
      effective: { mode: "ADMIN_REVIEW_REQUIRED", modeSource: "CLUB_WIDE" },
    });
    expect(connection).not.toHaveProperty("hostScopeSameBooking");
    expect(browser).toMatchObject({ hostScopeSameBooking: true, createdAt: STAMPS.createdAt.toISOString() });
  });
});

describe("update_adult_member_hosting_policy", () => {
  it("compare-and-swaps the club-wide row and answers the saved policy", async () => {
    const saved = hostingRow({ mode: "ENFORCED", version: 3 });
    h.prisma.adultMemberHostingPolicy.findMany.mockResolvedValue([saved]);
    // Each run reads the stored row, then the reloaded one.
    h.prisma.adultMemberHostingPolicy.findUnique
      .mockResolvedValueOnce(hostingRow())
      .mockResolvedValueOnce(saved)
      .mockResolvedValueOnce(hostingRow())
      .mockResolvedValueOnce(saved);
    h.prisma.adultMemberHostingPolicy.updateMany.mockResolvedValue({ count: 1 });
    h.enqueueReconciliation.mockResolvedValue(0);

    const { connection, browser } = await expectActionContract({
      actionId: "update_adult_member_hosting_policy",
      handler: putHosting,
      args: {
        mode: "ENFORCED",
        capacityMode: "HOLD",
        hostScopes: { sameBooking: true, sameBookingOwner: true, sameGroupTrip: false },
        version: 2,
      },
    });

    expect(h.prisma.adultMemberHostingPolicy.updateMany).toHaveBeenCalledWith({
      where: { scopeKey: "club-wide", version: 2 },
      data: expect.objectContaining({ mode: "ENFORCED", capacityMode: "HOLD", version: 3 }),
    });
    expect(connection).toMatchObject({ mode: "ENFORCED", version: 3, effective: { mode: "ENFORCED" } });
    expect(connection).not.toHaveProperty("updatedAt");
    expect(browser).toMatchObject({ mode: "ENFORCED", hostScopeSameBookingOwner: true });
  });
});

// ---------------------------------------------------------------------------
// Age groups
// ---------------------------------------------------------------------------

const AGE_TIER_ROWS = [
  {
    tier: "CHILD",
    minAge: 0,
    maxAge: 17,
    label: "Child",
    subscriptionRequiredForBooking: false,
    familyGroupRequestCreateMemberAllowed: true,
    sortOrder: 0,
  },
  {
    tier: "ADULT",
    minAge: 18,
    maxAge: null,
    label: "Adult",
    subscriptionRequiredForBooking: true,
    familyGroupRequestCreateMemberAllowed: false,
    sortOrder: 1,
  },
];

describe("get_age_tier_settings", () => {
  it("answers the club's age groups", async () => {
    h.prisma.ageTierSetting.findMany.mockResolvedValue(AGE_TIER_ROWS);

    const { connection, browser } = await expectActionContract({
      actionId: "get_age_tier_settings",
      handler: getAgeTiers,
    });

    expect(h.prisma.ageTierSetting.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: { sortOrder: "asc" } }),
    );
    // Every field is configuration the officer edits, so both match.
    expect(connection).toEqual({ settings: AGE_TIER_ROWS });
    expect(browser).toEqual(connection);
  });
});

describe("update_age_tier_settings", () => {
  it("upserts every kept group, removes none, and answers the saved set", async () => {
    // Each run reads the stored tiers, then the saved set.
    const stored = AGE_TIER_ROWS.map(({ tier }) => ({ tier }));
    h.prisma.ageTierSetting.findMany
      .mockResolvedValueOnce(stored)
      .mockResolvedValueOnce(AGE_TIER_ROWS)
      .mockResolvedValueOnce(stored)
      .mockResolvedValueOnce(AGE_TIER_ROWS);

    const { connection, browser } = await expectActionContract({
      actionId: "update_age_tier_settings",
      handler: putAgeTiers,
      args: { settings: AGE_TIER_ROWS },
    });

    expect(h.prisma.ageTierSetting.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tier: "ADULT" }, update: expect.objectContaining({ minAge: 18 }) }),
    );
    expect(h.prisma.ageTierSetting.deleteMany).not.toHaveBeenCalled();
    expect(connection).toEqual({ settings: AGE_TIER_ROWS });
    expect(browser).toEqual(connection);
  });
});

// ---------------------------------------------------------------------------
// Booking-request settings
// ---------------------------------------------------------------------------

const REQUEST_SETTINGS = {
  showPricingToNonMembers: true,
  quoteResponseTtlDays: 14,
  quoteReminderLeadDays: 3,
  attendeeConfirmationLeadDays: 21,
  attendeeConfirmationReminderDays: 4,
};

describe("get_booking_request_settings", () => {
  it("answers the five settings and never who saved them", async () => {
    h.prisma.bookingRequestSettings.findUnique.mockResolvedValue({
      id: "default",
      ...REQUEST_SETTINGS,
      lodgeId: null,
      updatedByMemberId: "admin-9",
      ...STAMPS,
    });

    const { connection, browser } = await expectActionContract({
      actionId: "get_booking_request_settings",
      handler: getRequestSettings,
    });

    expect(connection).toEqual(REQUEST_SETTINGS);
    expect(browser).toEqual(REQUEST_SETTINGS);
  });
});

describe("update_booking_request_settings", () => {
  it("saves the settings as the officer and answers them", async () => {
    h.prisma.bookingRequestSettings.upsert.mockResolvedValue({
      id: "default",
      ...REQUEST_SETTINGS,
      updatedByMemberId: "officer-1",
      ...STAMPS,
    });

    const { connection, browser } = await expectActionContract({
      actionId: "update_booking_request_settings",
      handler: putRequestSettings,
      args: REQUEST_SETTINGS,
    });

    expect(h.prisma.bookingRequestSettings.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: { ...REQUEST_SETTINGS, updatedByMemberId: "officer-1" } }),
    );
    expect(connection).toEqual(REQUEST_SETTINGS);
    expect(browser).toEqual(REQUEST_SETTINGS);
  });
});

// ---------------------------------------------------------------------------
// Member-guest settings
// ---------------------------------------------------------------------------

const MEMBER_GUEST_VALUES = {
  approvalRequired: true,
  pendingHoldExpiryDays: 7,
  openMemberSearchEnabled: false,
  openMemberSearchIncludesMinors: false,
};

function memberGuestRow() {
  return { id: "default", ...MEMBER_GUEST_VALUES, updatedByMemberId: "admin-9", ...STAMPS };
}

describe("get_member_guest_settings", () => {
  it("answers the settings, bounds and access, but not who last saved them", async () => {
    h.prisma.memberGuestSettings.findUnique.mockResolvedValue(memberGuestRow());

    const { connection, browser } = await expectActionContract({
      actionId: "get_member_guest_settings",
      handler: getMemberGuest,
    });

    expect(connection).toMatchObject({
      settings: MEMBER_GUEST_VALUES,
      updatedAt: STAMPS.updatedAt.toISOString(),
      access: "manage",
    });
    expect(connection).not.toHaveProperty("updatedByMemberId");
    expect(browser).toMatchObject({ updatedByMemberId: "admin-9", access: "manage" });
  });
});
