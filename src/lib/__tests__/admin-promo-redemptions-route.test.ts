import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { emptyAdminPermissionMatrix } from "@/lib/admin-permissions";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  requireActiveSessionUser: vi.fn(),
  createAuditLog: vi.fn(),
  prisma: {
    promoCode: { findUnique: vi.fn() },
    lodge: { findUnique: vi.fn() },
    promoRedemption: {
      aggregate: vi.fn(),
      groupBy: vi.fn(),
      count: vi.fn(),
      findMany: vi.fn(),
    },
    // Distinct members who actually benefited (#2299): the cap progress
    // numerator, separate from the every-application tiles.
    promoRedemptionAllocation: {
      groupBy: vi.fn(),
    },
    // CT-4 (#2870): the redeemed-date window is built from the club's PERSISTED
    // timezone. Without this delegate `loadPersistedClubTimeSettings()` returns
    // null and the route falls back to the container's `TZ` in silence, so a
    // suite that omits it cannot tell the two authorities apart.
    clubTimeSettings: { findUnique: vi.fn() },
  },
}));

vi.mock("@/lib/auth", () => ({
  auth: mocks.auth,
}));

vi.mock("@/lib/audit", () => ({
  createAuditLog: mocks.createAuditLog,
}));

vi.mock("@/lib/session-guards", async () => ({
  // Forward the route's explicit permission requirement so the view/edit
  // matrix is exercised end-to-end.
  requireAdmin: (await import("./helpers/require-admin-mock"))
    .evaluateRequireAdminMock,
  requireActiveSessionUser: mocks.requireActiveSessionUser,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: mocks.prisma,
}));

import { GET } from "@/app/api/admin/promo-codes/[id]/redemptions/route";
import { APP_TIME_ZONE } from "@/config/operational";
import { startOfDateOnlyForTimeZone } from "@/lib/date-only";

/** Persist a club timezone for the route's `clubTimeZone()` read to resolve. */
function persistClubZone(timeZone: string) {
  mocks.prisma.clubTimeSettings.findUnique.mockResolvedValue({
    timeZone,
    updatedByMemberId: null,
    updatedAt: new Date(0),
  });
}

function params(id: string) {
  return { params: Promise.resolve({ id }) };
}

function req(url: string) {
  return new NextRequest(url);
}

function bookingsUser(level: "view" | "edit" | "none") {
  return {
    user: {
      id: "admin-1",
      role: "ADMIN",
      adminPermissionMatrix: { ...emptyAdminPermissionMatrix(), bookings: level },
    },
  };
}

const BASE_URL = "http://localhost/api/admin/promo-codes/pc-1/redemptions";

const PROMO_CODE = {
  id: "pc-1",
  code: "WINTER20",
  description: "Winter discount",
  type: "PERCENTAGE",
  active: true,
  archivedAt: null,
  internal: false,
  currentRedemptions: 3,
  maxRedemptionsTotal: 10,
  maxUniqueMembersTotal: null,
  maxUsesPerMember: 2,
  lifetimeFreeNightsCap: null,
};

// asc history: m1 used r1 then r3, m2 used r2 → m1's r3 is use #2.
const ORDERED_FOR_CODE = [
  { id: "r1", memberId: "m1" },
  { id: "r2", memberId: "m2" },
  { id: "r3", memberId: "m1" },
];

const ROWS = [
  {
    id: "r3",
    createdAt: new Date("2026-07-10T02:00:00.000Z"),
    member: { id: "m1", firstName: "Alice", lastName: "Alpha", email: "alice@example.com" },
    booking: {
      id: "bk-aaaaaa03",
      checkIn: new Date("2026-08-01T00:00:00.000Z"),
      checkOut: new Date("2026-08-04T00:00:00.000Z"),
      lodge: { id: "lodge-1", name: "Main Lodge" },
    },
    eligibleGuestCount: 2,
    discountCents: 5000,
    freeNightsUsed: 0,
    allocations: [
      {
        memberId: "m1",
        member: { id: "m1", firstName: "Alice", lastName: "Alpha" },
        discountCents: 3000,
        freeNightsUsed: 0,
      },
      {
        memberId: "g1",
        member: { id: "g1", firstName: "Bob", lastName: "Beta" },
        discountCents: 2000,
        freeNightsUsed: 0,
      },
    ],
  },
  {
    id: "r2",
    createdAt: new Date("2026-07-05T02:00:00.000Z"),
    member: { id: "m2", firstName: "Carol", lastName: "Gamma", email: "carol@example.com" },
    booking: {
      id: "bk-bbbbbb02",
      checkIn: new Date("2026-08-10T00:00:00.000Z"),
      checkOut: new Date("2026-08-12T00:00:00.000Z"),
      lodge: { id: "lodge-1", name: "Main Lodge" },
    },
    eligibleGuestCount: 1,
    discountCents: 2500,
    freeNightsUsed: 1,
    allocations: [
      {
        memberId: "m2",
        member: { id: "m2", firstName: "Carol", lastName: "Gamma" },
        discountCents: 2500,
        freeNightsUsed: 1,
      },
    ],
  },
  {
    id: "r1",
    createdAt: new Date("2026-07-01T02:00:00.000Z"),
    member: { id: "m1", firstName: "Alice", lastName: "Alpha", email: "alice@example.com" },
    booking: {
      id: "bk-cccccc01",
      checkIn: new Date("2026-08-20T00:00:00.000Z"),
      checkOut: new Date("2026-08-21T00:00:00.000Z"),
      lodge: { id: "lodge-1", name: "Main Lodge" },
    },
    eligibleGuestCount: 1,
    discountCents: 1000,
    freeNightsUsed: 0,
    allocations: [
      {
        memberId: "m1",
        member: { id: "m1", firstName: "Alice", lastName: "Alpha" },
        discountCents: 1000,
        freeNightsUsed: 0,
      },
    ],
  },
];

function seedHappyPath(codeOverride: Record<string, unknown> = {}) {
  mocks.prisma.promoCode.findUnique.mockResolvedValue({ ...PROMO_CODE, ...codeOverride });
  // Promise.all order: aggregate(all), groupBy(all),
  // allocation.groupBy(beneficial unique members), aggregate(filtered),
  // groupBy(filtered), count(benefit-free all), count(benefit-free filtered),
  // findMany(orderedForCode), findMany(rows).
  mocks.prisma.promoRedemption.count
    .mockResolvedValueOnce(0)
    .mockResolvedValueOnce(0);
  mocks.prisma.promoRedemption.aggregate
    .mockResolvedValueOnce({
      _count: { _all: 3 },
      _sum: { discountCents: 8500, freeNightsUsed: 1 },
    })
    .mockResolvedValueOnce({
      _count: { _all: 3 },
      _sum: { discountCents: 8500, freeNightsUsed: 1 },
    });
  mocks.prisma.promoRedemption.groupBy
    .mockResolvedValueOnce([{ memberId: "m1" }, { memberId: "m2" }])
    .mockResolvedValueOnce([{ memberId: "m1" }, { memberId: "m2" }]);
  mocks.prisma.promoRedemptionAllocation.groupBy.mockResolvedValue([
    { memberId: "m1" },
    { memberId: "m2" },
  ]);
  mocks.prisma.promoRedemption.findMany
    .mockResolvedValueOnce(ORDERED_FOR_CODE)
    .mockResolvedValueOnce(ROWS);
}

// Divergent all vs filtered mocks so the totals mapping cannot silently swap the
// two aggregates/groupBys: all = 3 redemptions / 8500c / two members, filtered =
// 1 redemption / 1000c / one member.
function seedDivergentTotals() {
  mocks.prisma.promoCode.findUnique.mockResolvedValue(PROMO_CODE);
  // Promise.all order: aggregate(all), groupBy(all),
  // allocation.groupBy(beneficial unique members), aggregate(filtered),
  // groupBy(filtered), count(benefit-free all), count(benefit-free filtered),
  // findMany(orderedForCode), findMany(rows).
  // Two of the three all-time applications gave nobody anything; one of them is
  // inside the filter. Counted, never derived by subtraction.
  mocks.prisma.promoRedemption.count
    .mockResolvedValueOnce(2)
    .mockResolvedValueOnce(1);
  mocks.prisma.promoRedemption.aggregate
    .mockResolvedValueOnce({
      _count: { _all: 3 },
      _sum: { discountCents: 8500, freeNightsUsed: 4 },
    })
    .mockResolvedValueOnce({
      _count: { _all: 1 },
      _sum: { discountCents: 1000, freeNightsUsed: 1 },
    });
  mocks.prisma.promoRedemption.groupBy
    .mockResolvedValueOnce([{ memberId: "m1" }, { memberId: "m2" }])
    .mockResolvedValueOnce([{ memberId: "m1" }]);
  // Only m1 ever got a benefit, so m2 occupies no unique-member place.
  mocks.prisma.promoRedemptionAllocation.groupBy.mockResolvedValue([
    { memberId: "m1" },
  ]);
  mocks.prisma.promoRedemption.findMany
    .mockResolvedValueOnce(ORDERED_FOR_CODE)
    .mockResolvedValueOnce([ROWS[2]]);
}

describe("GET /api/admin/promo-codes/[id]/redemptions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.mockResolvedValue(bookingsUser("view"));
    mocks.requireActiveSessionUser.mockResolvedValue(null);
  });

  it("returns 401 when unauthenticated", async () => {
    mocks.auth.mockResolvedValue(null);
    const res = await GET(req(BASE_URL), params("pc-1"));
    expect(res.status).toBe(401);
    expect(mocks.prisma.promoCode.findUnique).not.toHaveBeenCalled();
  });

  it("returns 403 without bookings access", async () => {
    mocks.auth.mockResolvedValue(bookingsUser("none"));
    const res = await GET(req(BASE_URL), params("pc-1"));
    expect(res.status).toBe(403);
    expect(mocks.prisma.promoCode.findUnique).not.toHaveBeenCalled();
  });

  it("allows bookings view access (edit is not required)", async () => {
    seedHappyPath();
    const res = await GET(req(BASE_URL), params("pc-1"));
    expect(res.status).toBe(200);
  });

  it("returns 404 for an unknown code", async () => {
    mocks.prisma.promoCode.findUnique.mockResolvedValue(null);
    const res = await GET(req(BASE_URL), params("missing"));
    expect(res.status).toBe(404);
    expect(mocks.prisma.promoRedemption.aggregate).not.toHaveBeenCalled();
  });

  it("returns filtered and all-time totals with summed discount cents", async () => {
    seedHappyPath();
    const res = await GET(req(BASE_URL), params("pc-1"));
    const body = await res.json();

    expect(body.totals.all).toEqual({
      redemptions: 3,
      uniqueMembers: 2,
      discountCents: 8500,
      freeNightsUsed: 1,
      benefitFreeRedemptions: 0,
    });
    expect(body.totals.filtered).toEqual({
      redemptions: 3,
      uniqueMembers: 2,
      discountCents: 8500,
      freeNightsUsed: 1,
      benefitFreeRedemptions: 0,
    });
    expect(body.code.caps.maxRedemptionsTotal).toBe(10);
    expect(body.pagination.total).toBe(3);
  });

  it("computes memberUseIndex from full redemption history", async () => {
    seedHappyPath();
    const res = await GET(req(BASE_URL), params("pc-1"));
    const body = await res.json();
    const byId = Object.fromEntries(
      body.rows.map((r: { id: string; memberUseIndex: number }) => [r.id, r.memberUseIndex]),
    );
    // m1: r1 -> use #1, r3 -> use #2. m2: r2 -> use #1.
    expect(byId.r1).toBe(1);
    expect(byId.r3).toBe(2);
    expect(byId.r2).toBe(1);
  });

  it("includes the per-member split only on multi-member bookings", async () => {
    seedHappyPath();
    const res = await GET(req(BASE_URL), params("pc-1"));
    const body = await res.json();
    const rowsById = Object.fromEntries(
      body.rows.map((r: { id: string }) => [r.id, r]),
    );
    // r3 has two allocations -> included and named.
    expect(rowsById.r3.allocations).toHaveLength(2);
    expect(rowsById.r3.allocations[0]).toMatchObject({
      name: "Alice Alpha",
      discountCents: 3000,
    });
    // Single-allocation redemptions omit the split.
    expect(rowsById.r1.allocations).toEqual([]);
    expect(rowsById.r2.allocations).toEqual([]);
  });

  it("maps booking reference, nights, and lodge without shifting stay dates", async () => {
    seedHappyPath();
    const res = await GET(req(BASE_URL), params("pc-1"));
    const body = await res.json();
    const r3 = body.rows.find((r: { id: string }) => r.id === "r3");
    expect(r3.booking.reference).toBe("AAAAAA03");
    expect(r3.booking.checkIn).toBe("2026-08-01");
    expect(r3.booking.checkOut).toBe("2026-08-04");
    expect(r3.booking.nights).toBe(3);
    expect(r3.booking.lodgeName).toBe("Main Lodge");
    expect(r3.discountCents).toBe(5000);
  });

  it("applies date-range and lodge filters to the redemption query", async () => {
    seedHappyPath();
    mocks.prisma.lodge.findUnique.mockResolvedValue({ id: "lodge-1" });

    const res = await GET(
      req(`${BASE_URL}?from=2026-07-01&to=2026-07-31&lodgeId=lodge-1`),
      params("pc-1"),
    );
    expect(res.status).toBe(200);

    // The rows findMany is the 2nd findMany call; its where is the filtered set.
    const rowsCall = mocks.prisma.promoRedemption.findMany.mock.calls[1][0];
    expect(rowsCall.where.promoCodeId).toBe("pc-1");
    expect(rowsCall.where.booking).toEqual({ lodgeId: "lodge-1" });
    expect(rowsCall.where.createdAt.gte).toBeInstanceOf(Date);
    expect(rowsCall.where.createdAt.lte).toBeInstanceOf(Date);
    expect(rowsCall.where.createdAt.gte.getTime()).toBeLessThan(
      rowsCall.where.createdAt.lte.getTime(),
    );
  });

  it("rejects an unknown lodge filter with 400", async () => {
    mocks.prisma.promoCode.findUnique.mockResolvedValue(PROMO_CODE);
    mocks.prisma.lodge.findUnique.mockResolvedValue(null);
    const res = await GET(req(`${BASE_URL}?lodgeId=ghost`), params("pc-1"));
    expect(res.status).toBe(400);
    expect(mocks.prisma.promoRedemption.aggregate).not.toHaveBeenCalled();
  });

  it("rejects a reversed date range with 400", async () => {
    mocks.prisma.promoCode.findUnique.mockResolvedValue(PROMO_CODE);
    const res = await GET(
      req(`${BASE_URL}?from=2026-07-31&to=2026-07-01`),
      params("pc-1"),
    );
    expect(res.status).toBe(400);
    expect(mocks.prisma.promoCode.findUnique).not.toHaveBeenCalled();
  });

  it("paginates with skip/take derived from page and pageSize", async () => {
    seedHappyPath();
    const res = await GET(
      req(`${BASE_URL}?page=3&pageSize=25`),
      params("pc-1"),
    );
    expect(res.status).toBe(200);
    const rowsCall = mocks.prisma.promoRedemption.findMany.mock.calls[1][0];
    expect(rowsCall.skip).toBe(50);
    expect(rowsCall.take).toBe(25);
    const body = await res.json();
    expect(body.pagination.page).toBe(3);
    expect(body.pagination.pageSize).toBe(25);
  });

  it("retrieves redemptions for an archived, internal code", async () => {
    seedHappyPath({ archivedAt: new Date("2026-06-01T00:00:00.000Z"), internal: true });
    const res = await GET(req(BASE_URL), params("pc-1"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.code.archived).toBe(true);
    expect(body.code.internal).toBe(true);
  });

  it("maps filtered totals from the filtered aggregates and all-time totals from the all aggregates", async () => {
    // Divergent mocks: a silent swap of all<->filtered in the response mapping
    // would flip these assertions.
    seedDivergentTotals();
    const res = await GET(
      req(`${BASE_URL}?from=2026-07-01&to=2026-07-02`),
      params("pc-1"),
    );
    const body = await res.json();

    expect(body.totals.all).toEqual({
      redemptions: 3,
      uniqueMembers: 2,
      discountCents: 8500,
      freeNightsUsed: 4,
      // Counted server-side, not derived: subtracting the beneficiary counter
      // (currentRedemptions = 3) from the application count would say 0 here.
      benefitFreeRedemptions: 2,
    });
    expect(body.totals.filtered).toEqual({
      redemptions: 1,
      uniqueMembers: 1,
      discountCents: 1000,
      freeNightsUsed: 1,
      benefitFreeRedemptions: 1,
    });
    // pagination.total tracks the filtered count, not the all-time count.
    expect(body.pagination.total).toBe(1);
  });

  it("export mode returns the full filtered set in one request and writes a privacy audit", async () => {
    seedHappyPath();
    // A lodge filter is present, so the lodge existence check must resolve.
    mocks.prisma.lodge.findUnique.mockResolvedValue({ id: "lodge-1" });
    const res = await GET(
      req(`${BASE_URL}?from=2026-07-01&to=2026-07-31&lodgeId=lodge-1&export=1`),
      params("pc-1"),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.rows).toHaveLength(3);

    // Rows findMany (2nd call) requests the full bounded set, not a page.
    const rowsCall = mocks.prisma.promoRedemption.findMany.mock.calls[1][0];
    expect(rowsCall.skip).toBe(0);
    expect(rowsCall.take).toBe(10_000);

    expect(mocks.createAuditLog).toHaveBeenCalledTimes(1);
    const auditArg = mocks.createAuditLog.mock.calls[0][0];
    expect(auditArg).toMatchObject({
      action: "promoRedemptions.exported",
      memberId: "admin-1",
      category: "privacy",
      outcome: "success",
    });
    expect(auditArg.metadata).toEqual({
      promoCodeId: "pc-1",
      filters: { from: "2026-07-01", to: "2026-07-31", lodgeId: "lodge-1" },
      rowCount: 3,
      matchedRowCount: 3,
      exportLimit: 10_000,
      truncated: false,
    });
    // A complete export says so in the body too, so the client never has to
    // infer completeness from a row count it cannot compare against.
    expect(body.export).toEqual({
      truncated: false,
      limit: 10_000,
      rowCount: 3,
      matchedRowCount: 3,
    });
  });

  it("omits the export block on a normal paginated GET", async () => {
    seedHappyPath();
    const res = await GET(req(`${BASE_URL}?page=1&pageSize=1`), params("pc-1"));
    const body = await res.json();
    // A short page is not a truncated export: the marker exists only for
    // `?export=1`, where the row set is what a CSV gets built from.
    expect(body.export).toBeNull();
  });

  it("does not write an audit for a normal paginated (non-export) GET", async () => {
    seedHappyPath();
    const res = await GET(req(BASE_URL), params("pc-1"));
    expect(res.status).toBe(200);
    expect(mocks.createAuditLog).not.toHaveBeenCalled();
  });
});

// #2299: the report keeps listing every application of the code, but the usage
// caps only count applications that gave someone a benefit — so the cap
// progress has to be driven from a separate, benefit-filtered numerator.
describe("GET /api/admin/promo-codes/[id]/redemptions - cap usage (#2299)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.mockResolvedValue(bookingsUser("view"));
    mocks.requireActiveSessionUser.mockResolvedValue(null);
  });

  it("reports cap usage from beneficial rows while the totals keep every application", async () => {
    seedDivergentTotals();

    const res = await GET(req(BASE_URL), params("pc-1"));
    expect(res.status).toBe(200);
    const body = await res.json();

    // Every application still shows in the totals...
    expect(body.totals.all.redemptions).toBe(3);
    expect(body.totals.all.uniqueMembers).toBe(2);
    // ...while the cap numerators count only what actually consumes a cap.
    expect(body.code.capUsage).toEqual({
      redemptions: body.code.currentRedemptions,
      uniqueMembers: 1,
    });

    expect(mocks.prisma.promoRedemptionAllocation.groupBy).toHaveBeenCalledWith({
      by: ["memberId"],
      where: {
        promoCodeId: "pc-1",
        OR: [
          { discountCents: { gt: 0 } },
          { priceAdjustmentCents: { not: 0 } },
          { freeNightsUsed: { gt: 0 } },
        ],
      },
    });
  });

  it("does not narrow the beneficial unique-member count by the date/lodge filter", async () => {
    // The caps are all-time, so their numerator must ignore the report filter.
    seedDivergentTotals();

    await GET(
      req(`${BASE_URL}?from=2026-07-01&to=2026-07-31&lodgeId=lodge-1`),
      params("pc-1")
    );

    const [[args]] = mocks.prisma.promoRedemptionAllocation.groupBy.mock.calls;
    expect(args.where).not.toHaveProperty("createdAt");
    expect(args.where).not.toHaveProperty("booking");
  });
});

// #2244: an export is capped at EXPORT_MAX_ROWS rows. A capped export used to
// come back looking exactly like a complete one — the client built the CSV
// unconditionally and the privacy audit recorded a bare row count that asserted
// a completeness the file did not have.
describe("GET /api/admin/promo-codes/[id]/redemptions - export truncation (#2244)", () => {
  const EXPORT_MAX_ROWS = 10_000;

  // One synthetic redemption row in the shape the route's mapper expects.
  function redemptionRow(index: number) {
    return {
      id: `r${index}`,
      createdAt: new Date("2026-07-01T02:00:00.000Z"),
      member: {
        id: `m${index}`,
        firstName: "Alice",
        lastName: `Alpha${index}`,
        email: `alice${index}@example.com`,
      },
      booking: {
        id: `bk-${String(index).padStart(8, "0")}`,
        checkIn: new Date("2026-08-01T00:00:00.000Z"),
        checkOut: new Date("2026-08-02T00:00:00.000Z"),
        lodge: { id: "lodge-1", name: "Main Lodge" },
      },
      eligibleGuestCount: 1,
      discountCents: 1000,
      priceAdjustmentCents: 0,
      freeNightsUsed: 0,
      allocations: [
        {
          memberId: `m${index}`,
          member: { id: `m${index}`, firstName: "Alice", lastName: `Alpha${index}` },
          discountCents: 1000,
          freeNightsUsed: 0,
        },
      ],
    };
  }

  /**
   * `returned` rows come back from the bounded rows findMany; `matched` is what
   * the filtered aggregate counted. Real Postgres cannot return more than the
   * cap, but the two numbers are independent inputs to the truncation decision,
   * so the fixtures drive them independently.
   */
  function seedExportOfSize(returned: number, matched: number) {
    mocks.prisma.promoCode.findUnique.mockResolvedValue(PROMO_CODE);
    mocks.prisma.promoRedemption.count
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(0);
    mocks.prisma.promoRedemption.aggregate
      .mockResolvedValueOnce({
        _count: { _all: matched },
        _sum: { discountCents: matched * 1000, freeNightsUsed: 0 },
      })
      .mockResolvedValueOnce({
        _count: { _all: matched },
        _sum: { discountCents: matched * 1000, freeNightsUsed: 0 },
      });
    mocks.prisma.promoRedemption.groupBy
      .mockResolvedValueOnce([{ memberId: "m1" }])
      .mockResolvedValueOnce([{ memberId: "m1" }]);
    mocks.prisma.promoRedemptionAllocation.groupBy.mockResolvedValue([
      { memberId: "m1" },
    ]);
    const rows = Array.from({ length: returned }, (_, i) => redemptionRow(i + 1));
    mocks.prisma.promoRedemption.findMany
      .mockResolvedValueOnce(rows.map((r) => ({ id: r.id, memberId: r.member.id })))
      .mockResolvedValueOnce(rows);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.mockResolvedValue(bookingsUser("view"));
    mocks.requireActiveSessionUser.mockResolvedValue(null);
  });

  it("flags an export cut off by the cap and records the shortfall in the audit", async () => {
    // One row past the cap: the CSV can only hold EXPORT_MAX_ROWS of them.
    seedExportOfSize(EXPORT_MAX_ROWS, EXPORT_MAX_ROWS + 1);

    const res = await GET(req(`${BASE_URL}?export=1`), params("pc-1"));
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.export).toEqual({
      truncated: true,
      limit: EXPORT_MAX_ROWS,
      rowCount: EXPORT_MAX_ROWS,
      matchedRowCount: EXPORT_MAX_ROWS + 1,
    });

    const auditArg = mocks.createAuditLog.mock.calls[0][0];
    // The audit entry must not assert a complete export: the count it carries
    // is the file's, and the shortfall is spelled out beside it.
    expect(auditArg.summary).toBe(
      "Exported promo code redemptions CSV (truncated)",
    );
    expect(auditArg.metadata).toMatchObject({
      rowCount: EXPORT_MAX_ROWS,
      matchedRowCount: EXPORT_MAX_ROWS + 1,
      exportLimit: EXPORT_MAX_ROWS,
      truncated: true,
    });
  });

  it("does not flag an export that matched exactly the cap", async () => {
    // Boundary: filling the cap is not the same as being cut off by it — every
    // matching row is in the file.
    seedExportOfSize(EXPORT_MAX_ROWS, EXPORT_MAX_ROWS);

    const res = await GET(req(`${BASE_URL}?export=1`), params("pc-1"));
    const body = await res.json();

    expect(body.export.truncated).toBe(false);
    expect(body.export.rowCount).toBe(EXPORT_MAX_ROWS);
    expect(mocks.createAuditLog.mock.calls[0][0].summary).toBe(
      "Exported promo code redemptions CSV",
    );
    expect(mocks.createAuditLog.mock.calls[0][0].metadata).toMatchObject({
      truncated: false,
    });
  });

  it("does not flag a short export that never reached the cap", async () => {
    // The aggregate and the rows findMany are separate queries in one
    // Promise.all, so a concurrent write can leave the count above the rows
    // returned. Below the cap that is a race, not a truncation.
    seedExportOfSize(3, 5);

    const res = await GET(req(`${BASE_URL}?export=1`), params("pc-1"));
    const body = await res.json();

    expect(body.export.truncated).toBe(false);
    expect(mocks.createAuditLog.mock.calls[0][0].metadata).toMatchObject({
      truncated: false,
      rowCount: 3,
      matchedRowCount: 5,
    });
  });
});

/*
  CT-4 (#2870), epic #2988 — the redeemed-date window is club civil time, and it
  comes from the club's own setting.

  `PromoRedemption.createdAt` is a real INSTANT, so "redeemed on 1 July" only
  means something once a zone says when 1 July began and ended. That zone is the
  persisted `ClubTimeSettings.timeZone` (`INV-CONFIG-002`), never the container's
  `TZ` — and the difference is not cosmetic here: a redemption at 07:00Z on 1
  July is inside the club's 1 July in Denver and inside its 30 JUNE in New
  Zealand, so the report shows or hides a real row depending on which authority
  answered.

  The neighbouring `applies date-range and lodge filters` case above asserts only
  that the two bounds are Dates in the right order, which every zone satisfies.
  This is the one that says which zone.
*/
describe("promo redemptions — the window comes from the persisted club zone (CT-4, #2870)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.mockResolvedValue(bookingsUser("edit"));
    mocks.requireActiveSessionUser.mockResolvedValue(null);
    persistClubZone("America/Denver");
  });

  it("bounds a one-day window by the club's civil day, not the container's", async () => {
    // The premise, measured as an ANSWER rather than a zone identifier: the
    // environment authority — which is what `startOfDateOnlyForTimeZone` reads,
    // and what this route used to call — must open the day somewhere else, or
    // the assertions below cannot fail for the right reason. Comparing zone
    // NAMES would not establish that; `America/Chicago` gives Denver's answer.
    expect(
      startOfDateOnlyForTimeZone("2026-07-01", APP_TIME_ZONE).toISOString(),
      "INV-CONFIG-002: the environment authority now opens the club day at the " +
        "same instant the persisted zone does, so this window cannot tell which " +
        "of the two the route obeyed.",
    ).not.toBe("2026-07-01T06:00:00.000Z");

    seedHappyPath();
    const res = await GET(
      req(`${BASE_URL}?from=2026-07-01&to=2026-07-01`),
      params("pc-1"),
    );
    expect(res.status).toBe(200);

    const rowsCall = mocks.prisma.promoRedemption.findMany.mock.calls[1][0];
    // 1 July 2026 in Denver is MDT (UTC-6): the club's day runs 06:00Z to
    // 05:59:59.999Z the next morning. Under the environment's Pacific/Auckland
    // it would be 2026-06-30T12:00Z to 2026-07-01T11:59:59.999Z — a different
    // set of redemptions over a real instant column.
    expect(rowsCall.where.createdAt.gte.toISOString()).toBe("2026-07-01T06:00:00.000Z");
    // The `lte` keeps the INCLUSIVE last millisecond this filter has always
    // used; the kernel's own day end is half-open, hence the -1.
    expect(rowsCall.where.createdAt.lte.toISOString()).toBe("2026-07-02T05:59:59.999Z");
  });

  /*
    `9999-12-31` is a REAL day, so it passes `isDateOnlyString` and reaches the
    window derivation. What it has not got is a day AFTER it, and the club day's
    end is defined as the next day's start — so `addCalendarDays` throws a
    `RangeError` from outside any `try`, and the request dies as an unhandled
    rejection instead of answering. `src/lib/club-time/calendar-date.ts` records
    `/admin/audit-log?to=9999-12-31` as a value that has really reached
    production, which is why this is a guard rather than a curiosity.
  */
  it("refuses a window whose end has no day after it, rather than throwing", async () => {
    mocks.prisma.promoCode.findUnique.mockResolvedValue(PROMO_CODE);

    const res = await GET(
      req(`${BASE_URL}?from=2026-07-01&to=9999-12-31`),
      params("pc-1"),
    );

    expect(res.status).toBe(400);
    expect(mocks.prisma.promoRedemption.findMany).not.toHaveBeenCalled();
  });
});
