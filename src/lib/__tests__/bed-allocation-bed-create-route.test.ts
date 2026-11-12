import { beforeEach, describe, expect, it, vi } from "vitest";

// #2352 slice-1 review: these writers now clear the STORED public pages, not just
// the capacity tag. `revalidatePath` needs a static-generation store that no unit
// test has, so the shared helper is stubbed here; its own contents are pinned by
// public-content-invalidation-contract.test.ts.
vi.mock("@/lib/public-content-revalidation", () => ({
  revalidatePublicSite: vi.fn(),
  revalidatePublicPageContent: vi.fn(),
}));
import { Prisma } from "@prisma/client";

// POST /api/admin/bed-allocation/beds and DELETE /api/admin/bed-allocation/beds/[id]
// both funnel typed errors through the shared bedAllocationErrorResponse mapper.
// The next-auth chain (session-guards / admin-modules) is mocked so the real
// route handlers, the real createBedAllocationBed / deleteBedAllocationBed
// helpers, and the real mapper all run without loading auth. prisma is mocked at
// the DB seam so we can drive the concurrent-write P2003 races (#1700):
//   - create against a just-deleted room => LodgeBed.roomId -> LodgeRoom FK
//   - delete a bed with past allocation history => BedAllocation restrict FK
const {
  mockRequireAdmin,
  mockLogAudit,
  lodgeBedCreate,
  lodgeBedDelete,
  bedAllocationFindMany,
  prismaTransaction,
  txExecuteRaw,
  txLodgeBedFindUnique,
  txLodgeBedFindMany,
  txLodgeBedCreate,
  txLodgeBedDelete,
  txBedAllocationFindMany,
  txHutLeaderAssignmentFindMany,
} = vi.hoisted(() => ({
  mockRequireAdmin: vi.fn(),
  mockLogAudit: vi.fn(),
  lodgeBedCreate: vi.fn(),
  lodgeBedDelete: vi.fn(),
  bedAllocationFindMany: vi.fn(),
  prismaTransaction: vi.fn(),
  txExecuteRaw: vi.fn(),
  txLodgeBedFindUnique: vi.fn(),
  txLodgeBedFindMany: vi.fn(),
  txLodgeBedCreate: vi.fn(),
  txLodgeBedDelete: vi.fn(),
  txBedAllocationFindMany: vi.fn(),
  txHutLeaderAssignmentFindMany: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    lodgeBed: { create: lodgeBedCreate, delete: lodgeBedDelete },
    bedAllocation: { findMany: bedAllocationFindMany },
    // #2286: the delete guard also refuses a bed a custodian holds. None here,
    // so the pre-existing allocation-history mapping is what gets asserted.
    hutLeaderAssignment: { findMany: vi.fn().mockResolvedValue([]) },
    $transaction: prismaTransaction,
  },
}));
vi.mock("@/lib/lodge-capacity", () => ({ getLodgeCapacityStatus: vi.fn() }));
vi.mock("@/lib/session-guards", () => ({
  requireAdmin: () => mockRequireAdmin(),
}));
vi.mock("@/lib/admin-modules", () => ({
  isEffectiveModuleEnabled: () => Promise.resolve(true),
}));
vi.mock("@/lib/audit", () => ({
  logAudit: (...args: unknown[]) => mockLogAudit(...args),
}));

function fkError() {
  return new Prisma.PrismaClientKnownRequestError(
    "Foreign key constraint violated",
    { code: "P2003", clientVersion: "test", meta: { field_name: "LodgeBed_roomId_fkey (index)" } },
  );
}

function restrictError() {
  return new Prisma.PrismaClientKnownRequestError(
    "Foreign key constraint violated",
    { code: "P2003", clientVersion: "test", meta: { field_name: "BedAllocation_bedId_roomId_fkey (index)" } },
  );
}

function callCreate(body: unknown) {
  return import("@/app/api/admin/bed-allocation/beds/route").then(({ POST }) =>
    POST(
      new Request("http://localhost/api/admin/bed-allocation/beds", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    ),
  );
}

function callDelete(id: string) {
  return import("@/app/api/admin/bed-allocation/beds/[id]/route").then(
    ({ DELETE }) =>
      DELETE(
        new Request(`http://localhost/api/admin/bed-allocation/beds/${id}`, {
          method: "DELETE",
        }),
        { params: Promise.resolve({ id }) },
      ),
  );
}

describe("bed-allocation bed routes P2003 mapping (#1700)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireAdmin.mockResolvedValue({
      ok: true,
      session: { user: { id: "admin-1" } },
    });
  });

  it("maps a create against a just-deleted room to 404 with a refresh steer", async () => {
    lodgeBedCreate.mockRejectedValue(fkError());

    const res = await callCreate({ roomId: "room-gone", name: "Bed 1" });
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body.error).toBe(
      "The room for this bed no longer exists. Refresh and try again.",
    );
    // The create path must never surface the delete-history steer.
    expect(body.error).not.toMatch(/deactivate/i);
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  it("maps a grouped create against a just-deleted room to the same 404 (recursive $transaction branch)", async () => {
    // The grouped branch self-wraps in prisma.$transaction and recurses with
    // db: tx; the inner frame maps the raw P2003, and the outer catch must pass
    // the already-typed error through unchanged (no double-wrap / re-map).
    prismaTransaction.mockImplementation(
      async (cb: (tx: unknown) => Promise<unknown>) =>
        cb({
    $queryRaw: vi.fn().mockResolvedValue([{ held: true }]),
          // Room already deleted: the FOR UPDATE lock matches no rows...
          $executeRaw: txExecuteRaw.mockResolvedValue(0),
          lodgeBed: {
            // ...the group has no members...
            findMany: txLodgeBedFindMany.mockResolvedValue([]),
            // ...and the insert trips the LodgeBed.roomId Restrict FK.
            create: txLodgeBedCreate.mockRejectedValue(fkError()),
          },
        }),
    );

    const res = await callCreate({
      roomId: "room-gone",
      name: "Top bunk",
      bedType: "BUNK_TOP",
      bunkGroup: "Bunk A",
    });
    const body = await res.json();

    expect(prismaTransaction).toHaveBeenCalledTimes(1);
    expect(txLodgeBedCreate).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(404);
    expect(body.error).toBe(
      "The room for this bed no longer exists. Refresh and try again.",
    );
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  it("still maps the delete-path P2003 to the byte-identical history message (409)", async () => {
    // assertNoFutureBedAllocations only guards FUTURE dates, so a bed with only
    // past allocation history passes the guard and trips the BedAllocation
    // restrict FK on delete — the shared mapper's P2003 branch must be unchanged.
    // #2593 moved this path behind the production transaction wrapper, so the
    // race must be driven through the locked transaction delegates rather than
    // through the root Prisma mock.
    prismaTransaction.mockImplementation(
      async (cb: (tx: unknown) => Promise<unknown>) =>
        cb({
    $queryRaw: vi.fn().mockResolvedValue([{ held: true }]),
          $executeRaw: txExecuteRaw.mockResolvedValue(1),
          lodgeBed: {
            findUnique: txLodgeBedFindUnique.mockResolvedValue({
              room: { lodgeId: "lodge-a" },
            }),
            delete: txLodgeBedDelete.mockRejectedValue(restrictError()),
          },
          bedAllocation: {
            findMany: txBedAllocationFindMany.mockResolvedValue([]),
          },
          hutLeaderAssignment: {
            findMany: txHutLeaderAssignmentFindMany.mockResolvedValue([]),
          },
        }),
    );

    const res = await callDelete("bed-1");
    const body = await res.json();

    expect(prismaTransaction).toHaveBeenCalledTimes(1);
    expect(txExecuteRaw).toHaveBeenCalledTimes(2);
    expect(txExecuteRaw.mock.calls[0]?.[0].join("?")).toContain(
      "pg_advisory_xact_lock(1)",
    );
    expect(txExecuteRaw.mock.calls[1]?.[0].join("?")).toContain(
      "pg_advisory_xact_lock(hashtextextended(",
    );
    expect(txLodgeBedFindUnique).toHaveBeenCalledWith({
      where: { id: "bed-1" },
      select: { room: { select: { lodgeId: true } } },
    });
    expect(txBedAllocationFindMany).toHaveBeenCalledTimes(1);
    expect(txHutLeaderAssignmentFindMany).toHaveBeenCalledTimes(1);
    expect(txLodgeBedDelete).toHaveBeenCalledWith({ where: { id: "bed-1" } });
    expect(lodgeBedDelete).not.toHaveBeenCalled();
    expect(res.status).toBe(409);
    expect(body.error).toBe(
      "Cannot delete a bed with allocation history; deactivate it instead.",
    );
    expect(mockLogAudit).not.toHaveBeenCalled();
  });
});
