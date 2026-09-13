import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import {
  contentAdminSession,
  financeAdminSession,
  readOnlyAdminSession,
} from "./helpers/admin-area-gate-sessions";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    member: { count: vi.fn() },
    membershipType: { findMany: vi.fn() },
    xeroItemCodeMapping: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      upsert: vi.fn(),
      deleteMany: vi.fn(),
    },
  },
}));

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
const mockRequireActiveSessionUser = vi.fn<(...args: unknown[]) => Promise<Response | null>>(async () => null);
vi.mock("@/lib/session-guards", async () => ({
  requireAdmin: (await import("./helpers/require-admin-mock"))
    .evaluateRequireAdminMock,
  requireActiveSessionUser: (...args: Parameters<typeof mockRequireActiveSessionUser>) => mockRequireActiveSessionUser(...args),
}));
vi.mock("@/lib/audit", () => ({ logAudit: vi.fn() }));

import { prisma } from "@/lib/prisma";
import { auth } from "@/lib/auth";
import {
  GET as getItemCodeMappings,
  PUT as putItemCodeMappings,
} from "@/app/api/admin/xero/item-code-mappings/route";

const mockPrisma = prisma as unknown as {
  member: {
    count: ReturnType<typeof vi.fn>;
  };
  membershipType: {
    findMany: ReturnType<typeof vi.fn>;
  };
  xeroItemCodeMapping: {
    findMany: ReturnType<typeof vi.fn>;
    findFirst: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    updateMany: ReturnType<typeof vi.fn>;
    upsert: ReturnType<typeof vi.fn>;
    deleteMany: ReturnType<typeof vi.fn>;
  };
};

const mockAuth = auth as ReturnType<typeof vi.fn>;

function adminSession() {
  return { user: { id: "admin-1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }] } };
}

function makePutRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/admin/xero/item-code-mappings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const FULL_TYPE = {
  id: "type-full",
  key: "FULL",
  name: "Full Member",
  bookingBehavior: "MEMBER_RATE",
};
const NON_MEMBER_TYPE = {
  id: "type-nonmember",
  key: "NON_MEMBER",
  name: "Non-Member",
  bookingBehavior: "NON_MEMBER_RATE",
};
const SCHOOL_FLAT_TYPE = {
  id: "type-school",
  key: "SCHOOL_GROUP",
  name: "School Group",
  bookingBehavior: "MEMBER_RATE",
};
const BLOCKED_TYPE = {
  id: "type-blocked",
  key: "SOCIAL",
  name: "Social",
  bookingBehavior: "BLOCK_BOOKING",
};
/**
 * The built-in `FULL` after an officer picked a different booking behaviour for
 * it. The membership-type route's built-in guard covers deletion only, and the
 * membership-types screen renders the selector for every type. The engine still
 * resolves `FULL` by key, so its hut fees are still invoiced and still need an
 * item code (#2933).
 */
const REBEHAVED_FULL_TYPE = {
  id: "type-full-rebehaved",
  key: "FULL",
  name: "Full Member",
  bookingBehavior: "NON_MEMBER_RATE",
};

describe("Xero item-code mappings route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue(adminSession());
    mockPrisma.member.count.mockResolvedValue(1);
    mockPrisma.membershipType.findMany.mockImplementation(
      async (args: { where?: { id?: { in?: string[] } } }) => {
        const ids = args?.where?.id?.in ?? [];
        return [
          FULL_TYPE,
          NON_MEMBER_TYPE,
          SCHOOL_FLAT_TYPE,
          BLOCKED_TYPE,
          REBEHAVED_FULL_TYPE,
        ].filter((type) =>
          ids.includes(type.id)
        );
      }
    );
    mockPrisma.xeroItemCodeMapping.upsert.mockResolvedValue({});
    mockPrisma.xeroItemCodeMapping.findFirst.mockResolvedValue(null);
    mockPrisma.xeroItemCodeMapping.create.mockResolvedValue({});
    mockPrisma.xeroItemCodeMapping.update.mockResolvedValue({});
    mockPrisma.xeroItemCodeMapping.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.xeroItemCodeMapping.deleteMany.mockResolvedValue({ count: 1 });
    mockPrisma.xeroItemCodeMapping.findMany.mockResolvedValue([]);
  });

  it("returns entrance fee mappings with null item codes", async () => {
    mockPrisma.xeroItemCodeMapping.findMany.mockResolvedValue([
      {
        category: "JOINING_FEE",
        entranceFeeCategory: "ADULT",
        itemCode: null,
        amountCents: 5000,
      },
    ]);

    const res = await getItemCodeMappings();

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.entranceFees.ADULT).toEqual({ itemCode: null, amountCents: 5000 });
  });

  it("GET selects ONLY the consumed columns (#2130)", async () => {
    // Blue/green safety pin. Its original job was to stop the deployed client
    // naming XeroItemCodeMapping.isMember one release BEFORE the #2130 STEP 2
    // contract migration dropped it; that migration
    // (20260721130000_contract_drop_ismember_and_agetier_xero_columns) has now
    // shipped. The pin is kept because narrow selects remain the house rule
    // for this model and it still guards against reintroducing a no-select
    // findMany that names every column.
    mockPrisma.xeroItemCodeMapping.findMany.mockResolvedValue([]);

    await getItemCodeMappings();

    expect(mockPrisma.xeroItemCodeMapping.findMany).toHaveBeenCalledWith({
      select: {
        category: true,
        ageTier: true,
        seasonType: true,
        membershipTypeId: true,
        entranceFeeCategory: true,
        itemCode: true,
        amountCents: true,
      },
    });
    const args = mockPrisma.xeroItemCodeMapping.findMany.mock.calls[0][0] as {
      select?: Record<string, unknown>;
    };
    expect(args.select).not.toHaveProperty("isMember");
  });

  it("PUT narrows every mutation's RETURNING (#2130)", async () => {
    // Blue/green safety pin, WRITE half. Prisma emits an implicit RETURNING
    // over every scalar column of a create/update/upsert unless a `select`
    // narrows it, so an unnarrowed mutation kept naming
    // XeroItemCodeMapping.isMember even after the reads were narrowed — which
    // is why the #2130 STEP 1.5 runtime-prep release had to ship before the
    // STEP 2 contract migration dropped the column. That drop has landed; the
    // pin stays because narrow RETURNINGs remain the rule for this model.
    // Exercises all four mutation sites in one request: tiered upsert, FLAT
    // create, and the JOINING_FEE upsert.
    mockPrisma.xeroItemCodeMapping.findFirst.mockResolvedValue(null);

    const res = await putItemCodeMappings(
      makePutRequest({
        hutFees: {
          [`${FULL_TYPE.id}_WINTER_ADULT`]: { itemCode: "HUTFEE-001" },
          [`${SCHOOL_FLAT_TYPE.id}_SUMMER_FLAT`]: { itemCode: "HUTFEE-FLAT" },
        },
        entranceFees: { ADULT: { itemCode: "ENTFEE-001" } },
      })
    );
    expect(res.status).toBe(200);

    const mutationCalls = [
      ...mockPrisma.xeroItemCodeMapping.upsert.mock.calls,
      ...mockPrisma.xeroItemCodeMapping.create.mock.calls,
      ...mockPrisma.xeroItemCodeMapping.update.mock.calls,
    ];
    // 2 upserts (tiered hut fee + joining fee) and 1 create (FLAT hut fee).
    expect(mutationCalls).toHaveLength(3);
    for (const [args] of mutationCalls) {
      const select = (args as { select?: Record<string, unknown> }).select;
      expect(select).toEqual({ id: true });
      expect(select).not.toHaveProperty("isMember");
    }
  });

  it("PUT updates an existing FLAT hut fee row with a narrowed RETURNING (#2130)", async () => {
    // The find-then-update branch is the one mutation the pin above cannot
    // reach (it needs an existing row), so cover it separately.
    mockPrisma.xeroItemCodeMapping.findFirst.mockResolvedValue({ id: "row-1" });

    const res = await putItemCodeMappings(
      makePutRequest({
        hutFees: {
          [`${SCHOOL_FLAT_TYPE.id}_SUMMER_FLAT`]: { itemCode: "HUTFEE-FLAT-2" },
        },
      })
    );
    expect(res.status).toBe(200);

    const [args] = mockPrisma.xeroItemCodeMapping.update.mock.calls[0] as [
      { select?: Record<string, unknown> },
    ];
    expect(args.select).toEqual({ id: true });
    expect(args.select).not.toHaveProperty("isMember");
  });

  it("accepts entrance fee updates with a null item code", async () => {
    mockPrisma.xeroItemCodeMapping.findMany.mockResolvedValue([
      {
        category: "JOINING_FEE",
        entranceFeeCategory: "ADULT",
        itemCode: null,
        amountCents: 5000,
      },
    ]);

    const res = await putItemCodeMappings(
      makePutRequest({
        entranceFees: {
          ADULT: { itemCode: null, amountCents: 5000 },
        },
      })
    );

    expect(res.status).toBe(200);
    expect(mockPrisma.xeroItemCodeMapping.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          category_entranceFeeCategory: {
            category: "JOINING_FEE",
            entranceFeeCategory: "ADULT",
          },
        },
        update: { itemCode: null, amountCents: 5000 },
      })
    );
  });

  it("PUT with an item-code-only entry never writes amountCents (#1931 — amounts live in JoiningFee)", async () => {
    const res = await putItemCodeMappings(
      makePutRequest({
        entranceFees: {
          ADULT: { itemCode: "ENTFEE-001" },
        },
      })
    );

    expect(res.status).toBe(200);
    expect(mockPrisma.xeroItemCodeMapping.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          category_entranceFeeCategory: {
            category: "JOINING_FEE",
            entranceFeeCategory: "ADULT",
          },
        },
        // No amountCents key at all: an omitted amount must leave the stored
        // (frozen, config-transfer-exported) value untouched.
        update: { itemCode: "ENTFEE-001" },
        create: {
          category: "JOINING_FEE",
          entranceFeeCategory: "ADULT",
          itemCode: "ENTFEE-001",
        },
      })
    );
  });

  it("PUT with a null item code and no amount blanks the code but keeps the row", async () => {
    const res = await putItemCodeMappings(
      makePutRequest({
        entranceFees: {
          ADULT: { itemCode: null },
        },
      })
    );

    expect(res.status).toBe(200);
    expect(mockPrisma.xeroItemCodeMapping.updateMany).toHaveBeenCalledWith({
      where: { category: "JOINING_FEE", entranceFeeCategory: "ADULT" },
      data: { itemCode: null },
    });
    expect(mockPrisma.xeroItemCodeMapping.deleteMany).not.toHaveBeenCalled();
    expect(mockPrisma.xeroItemCodeMapping.upsert).not.toHaveBeenCalled();
  });

  it("deletes an entrance fee row when both item code and amount are cleared", async () => {
    const res = await putItemCodeMappings(
      makePutRequest({
        entranceFees: {
          ADULT: { itemCode: null, amountCents: null },
        },
      })
    );

    expect(res.status).toBe(200);
    expect(mockPrisma.xeroItemCodeMapping.deleteMany).toHaveBeenCalledWith({
      where: { category: "JOINING_FEE", entranceFeeCategory: "ADULT" },
    });
    expect(mockPrisma.xeroItemCodeMapping.upsert).not.toHaveBeenCalled();
  });

  // ── HUT_FEE re-key (#1930, E4): keys are `${membershipTypeId}_${seasonType}_${ageTier|FLAT}` ──

  it("GET returns membership-type-keyed hut fees and hides membershipTypeId-less rows", async () => {
    // The `isMember` column these fixtures used to carry was dropped by the
    // #2130 STEP 2 contract migration
    // (20260721130000_contract_drop_ismember_and_agetier_xero_columns), which
    // also deleted the orphaned legacy rows from production. The route's
    // defence does not depend on it: a HUT_FEE row is keyed, and rendered,
    // solely by membershipTypeId, so a membershipTypeId-less row stays hidden.
    mockPrisma.xeroItemCodeMapping.findMany.mockResolvedValue([
      {
        category: "HUT_FEE",
        membershipTypeId: FULL_TYPE.id,
        seasonType: "WINTER",
        ageTier: "ADULT",
        entranceFeeCategory: null,
        itemCode: "HUTFEE-FULL-WIN-AD",
        amountCents: null,
      },
      {
        category: "HUT_FEE",
        membershipTypeId: SCHOOL_FLAT_TYPE.id,
        seasonType: "SUMMER",
        ageTier: null,
        entranceFeeCategory: null,
        itemCode: "HUTFEE-SCHOOL-FLAT",
        amountCents: null,
      },
      // Residual un-keyed legacy row (no membershipTypeId): hidden.
      {
        category: "HUT_FEE",
        membershipTypeId: null,
        seasonType: "WINTER",
        ageTier: "ADULT",
        entranceFeeCategory: null,
        itemCode: "LEGACY-ADULT-WIN-MEM",
        amountCents: null,
      },
    ]);

    const res = await getItemCodeMappings();

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.hutFees).toEqual({
      [`${FULL_TYPE.id}_WINTER_ADULT`]: { itemCode: "HUTFEE-FULL-WIN-AD" },
      [`${SCHOOL_FLAT_TYPE.id}_SUMMER_FLAT`]: { itemCode: "HUTFEE-SCHOOL-FLAT" },
    });
  });

  it("PUT upserts a tiered hut fee on the membership-type composite unique", async () => {
    const res = await putItemCodeMappings(
      makePutRequest({
        hutFees: {
          [`${FULL_TYPE.id}_WINTER_ADULT`]: { itemCode: "HUTFEE-001" },
        },
      })
    );

    expect(res.status).toBe(200);
    expect(mockPrisma.xeroItemCodeMapping.upsert).toHaveBeenCalledWith({
      where: {
        category_membershipTypeId_seasonType_ageTier: {
          category: "HUT_FEE",
          membershipTypeId: FULL_TYPE.id,
          seasonType: "WINTER",
          ageTier: "ADULT",
        },
      },
      update: { itemCode: "HUTFEE-001" },
      create: {
        category: "HUT_FEE",
        membershipTypeId: FULL_TYPE.id,
        seasonType: "WINTER",
        ageTier: "ADULT",
        itemCode: "HUTFEE-001",
      },
      select: { id: true },
    });
  });

  it("PUT writes a FLAT hut fee via find-then-create (NULL ageTier cannot use the compound unique)", async () => {
    const res = await putItemCodeMappings(
      makePutRequest({
        hutFees: {
          [`${SCHOOL_FLAT_TYPE.id}_SUMMER_FLAT`]: { itemCode: "HUTFEE-FLAT" },
        },
      })
    );

    expect(res.status).toBe(200);
    expect(mockPrisma.xeroItemCodeMapping.findFirst).toHaveBeenCalledWith({
      where: {
        category: "HUT_FEE",
        membershipTypeId: SCHOOL_FLAT_TYPE.id,
        seasonType: "SUMMER",
        ageTier: null,
      },
      select: { id: true },
    });
    expect(mockPrisma.xeroItemCodeMapping.create).toHaveBeenCalledWith({
      data: {
        category: "HUT_FEE",
        membershipTypeId: SCHOOL_FLAT_TYPE.id,
        seasonType: "SUMMER",
        ageTier: null,
        itemCode: "HUTFEE-FLAT",
      },
      select: { id: true },
    });
    expect(mockPrisma.xeroItemCodeMapping.upsert).not.toHaveBeenCalled();
  });

  it("PUT updates an existing FLAT hut fee row in place", async () => {
    mockPrisma.xeroItemCodeMapping.findFirst.mockResolvedValue({ id: "row-1" });

    const res = await putItemCodeMappings(
      makePutRequest({
        hutFees: {
          [`${SCHOOL_FLAT_TYPE.id}_SUMMER_FLAT`]: { itemCode: "HUTFEE-FLAT-2" },
        },
      })
    );

    expect(res.status).toBe(200);
    expect(mockPrisma.xeroItemCodeMapping.update).toHaveBeenCalledWith({
      where: { id: "row-1" },
      data: { itemCode: "HUTFEE-FLAT-2" },
      select: { id: true },
    });
    expect(mockPrisma.xeroItemCodeMapping.create).not.toHaveBeenCalled();
  });

  it("PUT deletes a hut fee mapping when the value is null", async () => {
    const res = await putItemCodeMappings(
      makePutRequest({
        hutFees: {
          [`${FULL_TYPE.id}_WINTER_ADULT`]: null,
          [`${SCHOOL_FLAT_TYPE.id}_SUMMER_FLAT`]: null,
        },
      })
    );

    expect(res.status).toBe(200);
    expect(mockPrisma.xeroItemCodeMapping.deleteMany).toHaveBeenCalledWith({
      where: {
        category: "HUT_FEE",
        membershipTypeId: FULL_TYPE.id,
        seasonType: "WINTER",
        ageTier: "ADULT",
      },
    });
    expect(mockPrisma.xeroItemCodeMapping.deleteMany).toHaveBeenCalledWith({
      where: {
        category: "HUT_FEE",
        membershipTypeId: SCHOOL_FLAT_TYPE.id,
        seasonType: "SUMMER",
        ageTier: null,
      },
    });
  });

  it("PUT accepts hut fees for the built-in NON_MEMBER type (the non-member rate holder)", async () => {
    const res = await putItemCodeMappings(
      makePutRequest({
        hutFees: {
          [`${NON_MEMBER_TYPE.id}_WINTER_ADULT`]: { itemCode: "HUTFEE-NON" },
        },
      })
    );

    expect(res.status).toBe(200);
    expect(mockPrisma.xeroItemCodeMapping.upsert).toHaveBeenCalled();
  });

  it("PUT accepts hut fees for a key-resolved built-in whose behaviour was edited", async () => {
    // `FULL` is resolved by key for an unplaceable member and for every
    // other-lodge guest, so its hut fees are still invoiced whatever its own
    // row says about booking behaviour. Refusing it an item code here would
    // silently push those lines onto the legacy flat code (#2933).
    const res = await putItemCodeMappings(
      makePutRequest({
        hutFees: {
          [`${REBEHAVED_FULL_TYPE.id}_WINTER_ADULT`]: { itemCode: "HUTFEE-FULL" },
        },
      })
    );

    expect(res.status).toBe(200);
    expect(mockPrisma.xeroItemCodeMapping.upsert).toHaveBeenCalled();
  });

  it("PUT rejects the frozen legacy isMember-shaped key with a friendly 400", async () => {
    const res = await putItemCodeMappings(
      makePutRequest({
        hutFees: {
          ADULT_WINTER_true: { itemCode: "LEGACY-001" },
        },
      })
    );

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("Invalid hut fee mapping key");
    expect(mockPrisma.xeroItemCodeMapping.upsert).not.toHaveBeenCalled();
    expect(mockPrisma.xeroItemCodeMapping.create).not.toHaveBeenCalled();
    expect(mockPrisma.xeroItemCodeMapping.deleteMany).not.toHaveBeenCalled();
  });

  it("PUT rejects an unknown membership type with a friendly 400 and writes nothing", async () => {
    const res = await putItemCodeMappings(
      makePutRequest({
        hutFees: {
          ["type-missing_WINTER_ADULT"]: { itemCode: "HUTFEE-001" },
        },
      })
    );

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("Unknown membership type");
    expect(mockPrisma.xeroItemCodeMapping.upsert).not.toHaveBeenCalled();
    expect(mockPrisma.xeroItemCodeMapping.create).not.toHaveBeenCalled();
  });

  it("PUT rejects a non-rate-bearing membership type (D2 invariant) and writes nothing", async () => {
    const res = await putItemCodeMappings(
      makePutRequest({
        hutFees: {
          [`${FULL_TYPE.id}_WINTER_ADULT`]: { itemCode: "HUTFEE-001" },
          [`${BLOCKED_TYPE.id}_WINTER_ADULT`]: { itemCode: "HUTFEE-002" },
        },
      })
    );

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("does not carry its own hut fees");
    expect(mockPrisma.xeroItemCodeMapping.upsert).not.toHaveBeenCalled();
    expect(mockPrisma.xeroItemCodeMapping.create).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Per-area gate (#2921 / the fork PR #2949 shape). GET declares
// `{ area: "finance", level: "view" }` and PUT declares
// `{ area: "finance", level: "edit" }`. Before the sweep the mock never received
// either, so every test above proved only that the actor was *some* admin, and
// re-pointing a literal at `{ area: "overview", level: "view" }` would have left
// the file green.
// ---------------------------------------------------------------------------
describe("per-area gate on /api/admin/xero/item-code-mappings (#2921)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.member.count.mockResolvedValue(1);
    mockPrisma.membershipType.findMany.mockResolvedValue([]);
    mockPrisma.xeroItemCodeMapping.findMany.mockResolvedValue([]);
    mockPrisma.xeroItemCodeMapping.upsert.mockResolvedValue({});
  });

  it("admits a view-only admin on the finance:view read", async () => {
    mockAuth.mockResolvedValue(readOnlyAdminSession);

    const response = await getItemCodeMappings();

    expect(response.status).toBe(200);
  });

  it("refuses a view-only admin on the finance:edit write", async () => {
    mockAuth.mockResolvedValue(readOnlyAdminSession);

    const response = await putItemCodeMappings(
      makePutRequest({ entranceFees: {} }),
    );

    expect(response.status).toBe(403);
    expect(mockPrisma.xeroItemCodeMapping.upsert).not.toHaveBeenCalled();
    expect(mockPrisma.xeroItemCodeMapping.updateMany).not.toHaveBeenCalled();
  });

  it("refuses an admin with no finance access on both handlers", async () => {
    mockAuth.mockResolvedValue(contentAdminSession);

    const read = await getItemCodeMappings();
    const write = await putItemCodeMappings(
      makePutRequest({ entranceFees: {} }),
    );

    expect(read.status).toBe(403);
    expect(write.status).toBe(403);
    expect(mockPrisma.xeroItemCodeMapping.findMany).not.toHaveBeenCalled();
    expect(mockPrisma.xeroItemCodeMapping.upsert).not.toHaveBeenCalled();
  });

  it("admits a finance-editing admin on the finance:edit write", async () => {
    mockAuth.mockResolvedValue(financeAdminSession);

    const response = await putItemCodeMappings(
      makePutRequest({ entranceFees: {} }),
    );

    expect(response.status).toBe(200);
  });
});
